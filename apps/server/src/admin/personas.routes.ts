/**
 * Curating an event's personas from the FHIR server it was configured with.
 *
 * Two routes, and four decisions worth stating.
 *
 * **The source is a participant-supplied address like any other.** It is typed into an
 * event by an admin, and an admin is not a reason to skip the SSRF guard - so both routes
 * fetch through the one guarded path, and a private or internal address is refused with a
 * 422 naming the refusal before anything is sent (principle III, FR-020).
 *
 * **Adding a persona sends an identifier, and nothing else.** The demographics and the IHI
 * are read from the source by the route rather than accepted from the request, so what a
 * persona claims is what the source says. A body asserting an IHI for a patient that has
 * none changes nothing: it is not read.
 *
 * **Only patients carrying an IHI are eligible, and the reason is stated** (FR-031,
 * scenario 2). The search returns the refused patients beside the eligible ones, each with
 * a sentence naming the namespace that was looked for; the add refuses with the same
 * sentence. An admin who can see the patient on the source server is never left wondering
 * where it went.
 *
 * **The response to a mutation is the persona, and the page is read from the public route.**
 * There is no admin-only listing: the constitution forbids a view-only data path, and the
 * flag admins need - a persona missing at its source - is a property of the persona that the
 * public grid already carries.
 *
 * Author: John Grimes
 */

import { personaInputSchema } from "@muster/contracts";
import {
  assessPersonaCandidate,
  parsePatientSearch,
  personaSearchUrl,
  patientResourceUrl,
} from "@muster/core";
import { findPersonaByIhi, insertPersona, isUniqueViolation } from "@muster/db";

import { namedEvent } from "./access.js";
import { requireAdmin } from "../auth/middleware.js";
import { injectedOutbound } from "../context.js";
import { jsonError } from "../http/errors.js";
import { parseBody } from "../http/requestBody.js";
import { personaRefusalView, personaView } from "../http/views.js";
import { checkOutboundUrl, outboundFetch } from "../outbound/outboundFetch.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { OutboundResponse } from "../outbound/outboundFetch.js";
import type { PersonaAssessment } from "@muster/core";
import type { EventRow } from "@muster/db";
import type { Context, Hono } from "hono";

/**
 * How long the source server has to answer.
 *
 * Longer than a liveness check, because an admin is watching this one and a search of a
 * well-stocked test server is slower than fetching its CapabilityStatement.
 */
const SOURCE_TIMEOUT_MS = 15_000;

/** The event a persona route names, and where its source server lives. */
interface PersonaSource {
  readonly event: EventRow;
  readonly sourceUrl: string;
}

/**
 * Resolves the event and its configured source, refusing when there is nothing to fetch.
 *
 * The guard's verdict on the address is taken here rather than at the fetch, so that an
 * event naming an internal address is refused identically by both routes and neither can
 * acquire the exemption by forgetting to ask.
 */
async function namedSource(
  context: ServerContext,
  c: Context<MusterEnvironment>,
): Promise<PersonaSource | Response> {
  const event = await namedEvent(context, c, c.req.param("slug") ?? "");
  if (event instanceof Response) {
    return event;
  }
  if (event.personaSourceUrl === null) {
    return jsonError(
      c,
      422,
      "no_persona_source",
      "This event names no persona source server. Set one on the event before curating personas.",
    );
  }
  const address = checkOutboundUrl(
    event.personaSourceUrl,
    context.config.outboundAllowedHosts,
  );
  if (!address.ok) {
    return jsonError(c, 422, "guarded_address", address.description);
  }
  return { event, sourceUrl: event.personaSourceUrl };
}

/**
 * Fetches one address on the source server through the one guarded path.
 *
 * A refusal and an error status are both answered with a 502: from the admin's point of
 * view the source server did not produce a patient, and the sentence says which of the two
 * happened. The guarded case never reaches here - {@link namedSource} answers it with a 422
 * before anything is sent.
 */
async function fromSource(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  url: string,
): Promise<OutboundResponse | Response> {
  const result = await outboundFetch(url, {
    allowedHosts: context.config.outboundAllowedHosts,
    timeoutMs: SOURCE_TIMEOUT_MS,
    ...injectedOutbound(context.outbound),
  });
  if (!result.ok) {
    return jsonError(c, 502, "source_unavailable", result.description);
  }
  if (result.value.status < 200 || result.value.status >= 300) {
    return jsonError(
      c,
      502,
      "source_unavailable",
      `The persona source answered HTTP ${String(result.value.status)} to ${url}`,
    );
  }
  return result.value;
}

/**
 * Registers the persona curation routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerPersonaRoutes(router, context);
 * ```
 */
export function registerPersonaRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /**
   * Searches the source server for patients an admin might curate (FR-031).
   *
   * Both lists come back. Dropping the ineligible results would leave an admin looking at a
   * patient on the source server that Muster silently refuses to show them (scenario 2).
   */
  router.get(
    "/admin/events/:slug/persona-search",
    requireAdmin(),
    async (c) => {
      const source = await namedSource(context, c);
      if (source instanceof Response) {
        return source;
      }
      const searched = personaSearchUrl(
        source.sourceUrl,
        c.req.query("q") ?? "",
      );
      const response = await fromSource(context, c, searched);
      if (response instanceof Response) {
        return response;
      }

      const resources = parsePatientSearch(response.body);
      if (resources === undefined) {
        return jsonError(
          c,
          502,
          "source_unavailable",
          "The persona source answered the search with something that is not a searchset Bundle.",
        );
      }
      const assessments = resources.map((resource) =>
        assessPersonaCandidate(resource, context.config.ihiSystem),
      );
      return c.json({
        searched,
        candidates: assessments.flatMap((assessment: PersonaAssessment) =>
          assessment.eligible ? [assessment.candidate] : [],
        ),
        ineligible: assessments.flatMap((assessment: PersonaAssessment) =>
          assessment.eligible ? [] : [personaRefusalView(assessment)],
        ),
      });
    },
  );

  /**
   * Curates one patient from the source server as a persona (FR-031).
   *
   * The patient is read from the source and judged there. That is what makes "only patients
   * carrying an IHI are eligible" a property of the record rather than of what a caller
   * chose to send.
   */
  router.post("/admin/events/:slug/personas", requireAdmin(), async (c) => {
    const source = await namedSource(context, c);
    if (source instanceof Response) {
      return source;
    }
    const body = await parseBody(c, personaInputSchema);
    if (body instanceof Response) {
      return body;
    }

    const response = await fromSource(
      context,
      c,
      patientResourceUrl(source.sourceUrl, body.patientId),
    );
    if (response instanceof Response) {
      return response;
    }

    let resource: unknown;
    try {
      resource = JSON.parse(response.body);
    } catch {
      return jsonError(
        c,
        502,
        "source_unavailable",
        "The persona source answered with something that is not JSON.",
      );
    }

    const assessment = assessPersonaCandidate(
      resource,
      context.config.ihiSystem,
    );
    if (!assessment.eligible) {
      // Scenario 2: the reason is stated, in the words the search results use.
      return jsonError(
        c,
        422,
        assessment.reason === "no-ihi"
          ? "persona_without_ihi"
          : "not_a_patient",
        assessment.detail,
      );
    }

    const { candidate } = assessment;
    const existing = await findPersonaByIhi(context.db, {
      eventId: source.event.id,
      ihi: candidate.ihi,
    });
    if (existing !== undefined) {
      return jsonError(
        c,
        409,
        "persona_exists",
        `${existing.display.name} is already a persona of this event with that IHI.`,
      );
    }

    const now = context.clock();
    try {
      const persona = await insertPersona(context.db, {
        eventId: source.event.id,
        patientId: candidate.patientId,
        display: candidate.display,
        ihi: candidate.ihi,
        checkedAt: now,
      });
      return c.json(
        {
          persona: personaView(persona, source.event, context.config.ihiSystem),
        },
        201,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two admins curating the same patient at once: the index decided, not the lookup.
        return jsonError(
          c,
          409,
          "persona_exists",
          "This event already has a persona with that IHI.",
        );
      }
      throw error;
    }
  });
}
