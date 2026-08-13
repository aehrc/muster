/**
 * The pairing request form, as data.
 *
 * Two questions live here, both of which a component would answer badly.
 *
 * **Which clients may be offered as the requesting side?** The caller's organisations' clients
 * that are enrolled in *this* event - because a pairing exists within a single event (FR-012,
 * scenario 6) and the request names the enrolment rather than the system. The answer comes out of
 * the organisation listing the console already holds, so choosing a client costs no extra request.
 *
 * **What goes in the fields?** The client's own record, prefilled and editable before submission
 * (FR-012). Every field is a string here, including the lists: an input holds text, and converting
 * on each keystroke means a half-typed URL is briefly a different value from what was typed. The
 * conversion happens once, on submit, and an unparseable value is sent as-is so the server names
 * the field rather than the console guessing.
 *
 * Author: John Grimes
 */

import { prefillRegistrationFields } from "@muster/core";

import { lines, words } from "./textLists.js";

import type {
  Confidentiality,
  MyOrganisation,
  OrganisationSystem,
  RegistrationFieldsInput,
} from "@muster/contracts";

/** One client a member may offer as the requesting side. */
export interface ClientCandidate {
  /** What the request names: the client's enrolment in this event. */
  readonly enrolmentId: string;
  readonly systemId: string;
  readonly name: string;
  readonly organisationId: string;
}

/** The request form's fields, all as text. */
export interface PairingRequestForm {
  readonly clientName: string;
  readonly launchUrl: string;
  /** One per line. */
  readonly redirectUris: string;
  /** Whitespace-separated, as SMART writes them. */
  readonly scopes: string;
  readonly confidentiality: string;
  readonly launchContext: string;
  readonly needsIntrospection: boolean;
}

/**
 * The caller's clients that are enrolled in one event.
 *
 * @param mine - The organisations the caller belongs to, with their systems.
 * @param eventSlug - The event the pairing would be in.
 * @returns One candidate per enrolled client, in the order the organisations were listed.
 * @example
 * ```ts
 * const candidates = clientCandidates(organisations.data?.organisations ?? [], slug);
 * ```
 */
export function clientCandidates(
  mine: readonly MyOrganisation[],
  eventSlug: string,
): readonly ClientCandidate[] {
  return mine.flatMap((organisation) =>
    organisation.systems
      .filter((system) => system.clientProfile !== null)
      .flatMap((system) =>
        system.enrolments
          .filter((enrolment) => enrolment.eventSlug === eventSlug)
          .map((enrolment) => ({
            enrolmentId: enrolment.id,
            systemId: system.id,
            name: system.name,
            organisationId: organisation.id,
          })),
      ),
  );
}

/**
 * The form a client's record prefills (FR-012).
 *
 * The prefill itself is `prefillRegistrationFields` in `@muster/core`, so what the console shows
 * and what a later phase signs into a software statement are derived from the record the same way.
 * This adds only the conversion into text.
 *
 * @param system - The client system, as the organisation listing reports it.
 * @returns The form, ready to be edited.
 * @example
 * ```ts
 * const [form, setForm] = useState<PairingRequestForm | undefined>();
 * const values = form ?? pairingRequestForm(system);
 * ```
 */
export function pairingRequestForm(
  system: OrganisationSystem,
): PairingRequestForm {
  const fields = prefillRegistrationFields({
    name: system.name,
    clientProfile: system.clientProfile ?? {
      launchUrl: "",
      redirectUris: [],
      scopes: [],
      confidentiality: "public",
      launchContext: "",
      needsIntrospection: false,
    },
  });
  return {
    clientName: fields.clientName,
    launchUrl: fields.launchUrl,
    redirectUris: fields.redirectUris.join("\n"),
    scopes: fields.scopes.join(" "),
    confidentiality: fields.confidentiality,
    launchContext: fields.launchContext,
    needsIntrospection: fields.needsIntrospection,
  };
}

/**
 * The field set a form submits.
 *
 * @param form - The form's current values.
 * @returns The `registrationFields` half of the body for `POST /api/pairings`.
 * @example
 * ```ts
 * request.mutate({ eventSlug, clientEnrolmentId, serverEnrolmentId,
 *   registrationFields: registrationFieldsFrom(values) });
 * ```
 */
export function registrationFieldsFrom(
  form: PairingRequestForm,
): RegistrationFieldsInput {
  return {
    clientName: form.clientName.trim(),
    launchUrl: form.launchUrl.trim(),
    redirectUris: lines(form.redirectUris),
    scopes: words(form.scopes),
    confidentiality: form.confidentiality as Confidentiality,
    launchContext: form.launchContext,
    needsIntrospection: form.needsIntrospection,
  };
}

/**
 * What is obviously wrong before the request is made.
 *
 * Only the four minimums the server would refuse anyway, said next to the form rather than instead
 * of it: the server remains the authority on validity, so there are not two rules that can
 * disagree - these are the same four `registrationFieldRefusal` holds.
 *
 * @param form - The form's current values.
 * @returns A sentence to show, or `undefined` when the form may be submitted.
 */
export function pairingRequestFormProblem(
  form: PairingRequestForm,
): string | undefined {
  const fields = registrationFieldsFrom(form);
  if (fields.clientName.length === 0) {
    return "A pairing request needs a client name: it is what the server operator will see in their own client list.";
  }
  if (fields.launchUrl.length === 0) {
    return "A pairing request needs a launch URL, so a server that launches apps can launch this one.";
  }
  if (fields.redirectUris.length === 0) {
    return "A pairing request needs at least one redirect URI, or the authorization code flow cannot complete.";
  }
  if (fields.scopes.length === 0) {
    return "A pairing request needs at least one scope: it is what the server owner is being asked to agree to.";
  }
  return undefined;
}
