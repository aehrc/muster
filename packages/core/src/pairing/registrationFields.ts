import type { ClientProfile, RegistrationFields } from "@muster/contracts";

/**
 * The standard registration field set: how it is prefilled, and what is stored.
 *
 * FR-012 asks for two things that pull in opposite directions. The field set must
 * be prefilled from the client's own record, so that an app owner does not retype
 * what Muster already knows; and it must be editable before submission, so that a
 * connectathon build with a different redirect URI is not blocked by a directory
 * entry. Both are served here: the prefill is a pure function of the client
 * record, and the snapshot that is stored is a pure function of what was
 * submitted.
 *
 * Normalising the snapshot matters because both organisations read it. A trailing
 * space in a redirect URI, or the same scope listed twice, is a difference the two
 * parties would otherwise have to notice and discuss - which is the email
 * round-trip this tracker exists to replace.
 *
 * @author John Grimes
 */

/**
 * Prefills the registration field set from a client's record.
 *
 * @param clientName - what the client system is called
 * @param profile - the client profile the system declares
 * @returns the field set, ready to be shown for editing
 * @example
 * ```ts
 * const fields = prefillRegistrationFields(system.name, system.clientProfile);
 * ```
 */
export const prefillRegistrationFields = (
  clientName: string,
  profile: ClientProfile,
): RegistrationFields => ({
  clientName,
  launchUrl: profile.launchUrl,
  redirectUris: [...profile.redirectUris],
  scopes: [...profile.scopes],
  confidentiality: profile.confidentiality,
  launchContext: profile.launchContext,
  needsIntrospection: profile.needsIntrospection,
});

/**
 * Drops the blanks and the repeats from a list, keeping the order.
 *
 * @param values - the entries as submitted
 * @returns the entries, trimmed, once each, in the order they first appeared
 */
const tidy = (values: readonly string[]): string[] => [
  ...new Set(
    values.map((value) => value.trim()).filter((value) => value !== ""),
  ),
];

/**
 * Normalises a submitted field set into the snapshot to store.
 *
 * @param fields - the field set as submitted
 * @returns the snapshot: trimmed, with repeated redirect URIs and scopes reduced
 *   to one each
 * @example
 * ```ts
 * const snapshot = normaliseRegistrationFields(body.registrationFields);
 * ```
 */
export const normaliseRegistrationFields = (
  fields: RegistrationFields,
): RegistrationFields => ({
  ...fields,
  clientName: fields.clientName.trim(),
  launchUrl: fields.launchUrl.trim(),
  redirectUris: tidy(fields.redirectUris),
  scopes: tidy(fields.scopes),
  launchContext: fields.launchContext.trim(),
});
