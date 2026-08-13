/**
 * The standard registration field set: where it comes from, and what it must carry.
 *
 * FR-012 fixes the fields and says they are prefilled from the client's own record and
 * editable before submission. `data-model.md` then makes what was submitted a snapshot taken
 * at request time, and that is the reason the two halves of this module are separate
 * functions: the prefill reads a record, and the judgement reads only the field set. A
 * snapshot has to be judged on its own, because by the time a server owner reads it - or, in
 * User Story 5, by the time Muster signs it into a software statement - the record it was
 * taken from may say something else entirely.
 *
 * The minimums live here rather than in the Zod schema at the wire for that same reason. A set
 * read back out of `pairing.registration_fields` never passes through a request schema, so a
 * rule enforced only there would be a rule that holds for requests and not for the thing
 * requests produce.
 *
 * Pure, per constitution principle II.
 *
 * Author: John Grimes
 */

/** Whether a client can keep a secret. */
export type Confidentiality = "public" | "confidential";

/**
 * The standard registration field set (FR-012).
 *
 * The same shape as `registrationFieldsSchema` in `@muster/contracts`, declared here because
 * this package is the domain and may not depend on the package that validates the wire.
 */
export interface RegistrationFields {
  readonly clientName: string;
  readonly launchUrl: string;
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly confidentiality: Confidentiality;
  /** Which launch context the client needs the server to supply. Free text, may be empty. */
  readonly launchContext: string;
  readonly needsIntrospection: boolean;
}

/** What the prefill reads off a client's own record. */
export interface ClientRecord {
  readonly name: string;
  readonly clientProfile: {
    readonly launchUrl: string;
    readonly redirectUris: readonly string[];
    readonly scopes: readonly string[];
    readonly confidentiality: Confidentiality;
    readonly launchContext: string;
    readonly needsIntrospection: boolean;
  };
}

/** Why a field set cannot be used to register a client. */
export type RegistrationFieldRefusal =
  "no_client_name" | "no_launch_url" | "no_redirect_uris" | "no_scopes";

/**
 * The values of a list, deduplicated, in the order they first appear.
 *
 * Order is preserved because a set that comes back reordered looks edited to the person
 * comparing it against their own entry, and nothing about SMART makes redirect URI order
 * meaningful enough to normalise away.
 */
function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * The field set a client's record prefills (FR-012).
 *
 * A faithful copy, with two normalisations: the client name is trimmed, and a value listed
 * twice is listed once. A record may legitimately repeat a scope; a registration asserting it
 * twice says nothing more and reads as a mistake to whoever has to approve it.
 *
 * @param record - The client system and the profile it declares.
 * @returns The fields, ready to be shown for editing.
 * @example
 * ```ts
 * const fields = prefillRegistrationFields({
 *   name: system.name,
 *   clientProfile: system.clientProfile,
 * });
 * ```
 */
export function prefillRegistrationFields(
  record: ClientRecord,
): RegistrationFields {
  const profile = record.clientProfile;
  return {
    clientName: record.name.trim(),
    launchUrl: profile.launchUrl,
    redirectUris: distinct(profile.redirectUris),
    scopes: distinct(profile.scopes),
    confidentiality: profile.confidentiality,
    launchContext: profile.launchContext,
    needsIntrospection: profile.needsIntrospection,
  };
}

/**
 * Why this field set cannot be used to register a client, or `undefined` when it can.
 *
 * One refusal at a time, in the order a person would fix them. Each of the four is something
 * a registration cannot be completed without: a client with no redirect URI cannot finish an
 * authorization code flow, a client with no scopes gives the server owner nothing to agree to,
 * and a client with no launch URL cannot be launched by a server that launches apps.
 *
 * @param fields - The submitted or stored field set.
 * @returns The refusal code, or `undefined` when the set is usable.
 * @example
 * ```ts
 * const refusal = registrationFieldRefusal(body.registrationFields);
 * if (refusal !== undefined) {
 *   return jsonError(c, 422, refusal, "The registration details are incomplete");
 * }
 * ```
 */
export function registrationFieldRefusal(
  fields: RegistrationFields,
): RegistrationFieldRefusal | undefined {
  if (fields.clientName.trim().length === 0) {
    return "no_client_name";
  }
  if (fields.launchUrl.trim().length === 0) {
    return "no_launch_url";
  }
  if (fields.redirectUris.length === 0) {
    return "no_redirect_uris";
  }
  if (fields.scopes.length === 0) {
    return "no_scopes";
  }
  return undefined;
}
