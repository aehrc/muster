import {
  clientProfileSchema,
  serverProfileSchema,
  systemKinds,
} from "@muster/contracts";

import type {
  AccountView,
  Contact,
  EnrolledSystem,
  EventDetail,
  EventSummary,
  SystemRecord,
} from "@muster/contracts";
import type {
  AccountRow,
  EnrolledSystemRow,
  EventRow,
  SystemRow,
} from "@muster/db";

/**
 * How stored rows become the shapes on the wire.
 *
 * One module, shared by the routes a member drives and the public read API, so
 * a field cannot appear in one and be missing from the other. The profiles are
 * parsed against the contract schemas on the way out rather than passed through:
 * what the console receives is what the contract says, or the request fails.
 *
 * Contact details are a parameter here and never a lookup: a view can only
 * carry them if its caller has already decided the reader may see them, which
 * is what keeps FR-007 in one place.
 *
 * @author John Grimes
 */

/**
 * Renders a system.
 *
 * @param system - the system as stored
 * @returns the system record, with its kinds derived from its profiles
 * @throws {Error} when a stored profile does not satisfy the contract
 * @example
 * ```ts
 * context.json({ system: systemRecord(row) });
 * ```
 */
export const systemRecord = (system: SystemRow): SystemRecord => ({
  id: system.id,
  organisationId: system.organisationId,
  name: system.name,
  description: system.description,
  kinds: systemKinds(system),
  serverProfile:
    system.serverProfile == null
      ? null
      : serverProfileSchema.parse(system.serverProfile),
  clientProfile:
    system.clientProfile == null
      ? null
      : clientProfileSchema.parse(system.clientProfile),
});

/**
 * Renders an event for a list.
 *
 * @param event - the event as stored
 * @returns the summary
 */
export const eventSummary = (event: EventRow): EventSummary => ({
  slug: event.slug,
  name: event.name,
  startsOn: event.startsOn,
  endsOn: event.endsOn,
  status: event.status,
});

/**
 * Renders an event with everything the event view needs.
 *
 * @param event - the event as stored
 * @returns the detail
 */
export const eventDetail = (event: EventRow): EventDetail => ({
  ...eventSummary(event),
  capabilityTags: [...event.capabilityTags],
  personaSourceUrl: event.personaSourceUrl,
  graceDays: event.graceDays,
});

/**
 * Renders an enrolled system.
 *
 * @param row - the enrolment joined to its system and organisation
 * @param contacts - the owning organisation's contacts, when the reader may see
 *   them; omitted otherwise, and then absent from the response
 * @returns the enrolled system
 * @example
 * ```ts
 * enrolledSystem(row, visible ? await listOrganisationContacts(sql, id) : undefined);
 * ```
 */
export const enrolledSystem = (
  row: EnrolledSystemRow,
  contacts?: readonly Contact[],
): EnrolledSystem => ({
  enrolmentId: row.enrolmentId,
  tags: [...row.tags],
  confirmedAt: row.confirmedAt.toISOString(),
  system: systemRecord(row.system),
  organisation: row.organisation,
  ...(contacts === undefined ? {} : { contacts: [...contacts] }),
});

/**
 * Renders an account for the console.
 *
 * @param account - the account as stored
 * @returns the account view, which never carries the password hash
 * @example
 * ```ts
 * context.json({ account: accountView(account) });
 * ```
 */
export const accountView = (account: AccountRow): AccountView => ({
  id: account.id,
  email: account.email,
  displayName: account.displayName,
  status: account.status,
  emailVerified: account.emailVerifiedAt !== null,
  isAdmin: account.isAdmin,
});
