/**
 * Resolving the thing a console request names, and refusing when it is not the caller's.
 *
 * Every console route starts by turning a path parameter into a row the caller is allowed to
 * act on, and the refusals have to be identical wherever that happens: an organisation
 * somebody else owns and an organisation that does not exist both answer 404. A 403 would
 * confirm the identifier names something, which is how a directory of vendors is enumerated
 * by anybody with an account.
 *
 * Written once, so that the membership predicate cannot be present on the system route and
 * absent on the enrolment route.
 *
 * Author: John Grimes
 */

import {
  findEventBySlug,
  findOrganisationById,
  findSystemById,
  isOrganisationMember,
  listEnrolmentsForOrganisation,
  listOrganisationMembers,
  listSystemsForOrganisation,
} from "@muster/db";

import { jsonError } from "../http/errors.js";
import { myOrganisationView } from "../http/views.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { MyOrganisation } from "@muster/contracts";
import type {
  AccountRow,
  EventRow,
  OrganisationRow,
  SystemRow,
} from "@muster/db";
import type { Context } from "hono";

/**
 * The account a guarded route is acting for.
 *
 * Guarded routes are mounted behind `requireApproved`, which refuses before a handler runs.
 * The assertion documents that rather than re-checking it - and it is an assertion rather
 * than an optional return, because a handler that silently treated "no account" as a case
 * would be a handler whose guard could be removed without a test failing.
 *
 * @param c - The request.
 * @returns The signed-in account.
 * @throws {Error} When the route is missing its guard.
 */
export function callerAccount(c: Context<MusterEnvironment>): AccountRow {
  const account = c.get("account");
  if (account === undefined) {
    throw new Error(
      "A console handler ran without an account; it is missing its requireApproved guard",
    );
  }
  return account;
}

/** The identifier of the account a guarded route is acting for. */
export function callerId(c: Context<MusterEnvironment>): string {
  return callerAccount(c).id;
}

/**
 * The organisation named in the path, if the caller belongs to it.
 *
 * @returns The organisation, or the refusal to return from the handler.
 */
export async function callerOrganisation(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  organisationId: string,
): Promise<OrganisationRow | Response> {
  const organisation = await findOrganisationById(context.db, organisationId);
  if (
    organisation === undefined ||
    !(await isOrganisationMember(context.db, {
      organisationId,
      accountId: callerId(c),
    }))
  ) {
    // One answer for both cases. See the module header.
    return jsonError(
      c,
      404,
      "not_found",
      "No organisation of yours has that id",
    );
  }
  return organisation;
}

/**
 * The system named in the path, if the caller's organisation owns it.
 *
 * @returns The system, or the refusal to return from the handler.
 */
export async function callerSystem(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  systemId: string,
): Promise<SystemRow | Response> {
  const system = await findSystemById(context.db, systemId);
  if (
    system === undefined ||
    !(await isOrganisationMember(context.db, {
      organisationId: system.organisationId,
      accountId: callerId(c),
    }))
  ) {
    return jsonError(c, 404, "not_found", "No system of yours has that id");
  }
  return system;
}

/**
 * The organisation named in the path, whoever it belongs to.
 *
 * For the contacts feed, which any approved member may read (FR-007, scenario 6): a member
 * looking at somebody else's system needs to know who to talk to about it.
 *
 * @returns The organisation, or the refusal to return from the handler.
 */
export async function namedOrganisation(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  organisationId: string,
): Promise<OrganisationRow | Response> {
  const organisation = await findOrganisationById(context.db, organisationId);
  if (organisation === undefined) {
    return jsonError(c, 404, "not_found", "No organisation has that id");
  }
  return organisation;
}

/**
 * The event named in the path.
 *
 * Public, so there is no membership to check - but the 404 is the same shape as the others,
 * which is why it lives here.
 *
 * @returns The event, or the refusal to return from the handler.
 */
export async function namedEvent(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  slug: string,
): Promise<EventRow | Response> {
  const event = await findEventBySlug(context.db, slug);
  if (event === undefined) {
    return jsonError(c, 404, "not_found", "No event has that slug");
  }
  return event;
}

/**
 * Everything an organisation's page shows.
 *
 * Three queries for the whole page rather than one per system, and it is the response body of
 * every mutation on an organisation - so the console renders the new state without a second
 * round trip, per `contracts/http-api.md`.
 */
export async function organisationResponse(
  context: ServerContext,
  organisation: OrganisationRow,
): Promise<MyOrganisation> {
  const [members, systems, enrolments] = await Promise.all([
    listOrganisationMembers(context.db, organisation.id),
    listSystemsForOrganisation(context.db, organisation.id),
    listEnrolmentsForOrganisation(context.db, organisation.id),
  ]);
  return myOrganisationView(organisation, members, systems, enrolments);
}
