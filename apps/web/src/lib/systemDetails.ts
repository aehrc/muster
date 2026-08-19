import type {
  AuthorizationMode,
  ClientProfile,
  RegistrationMode,
  ServerProfile,
} from "@muster/contracts";

/**
 * A system's structured fields, labelled for a reader.
 *
 * The event view and the system detail show the same records, so the labels and
 * the wording of each mode are stated once here. The stored values are codes -
 * `trustedDcr`, `confidential` - and a directory meant to replace a hand-written
 * table has to read like one, so nothing on screen is a code.
 *
 * The registration guidance lives here rather than in a page because it is a fact
 * about the record: an `open` server needs no pairing at all (FR-016), and that
 * is true wherever the record is shown.
 *
 * @author John Grimes
 */

/** One structured field of a record. */
export type Detail = {
  /** what the field is called */
  readonly label: string;
  /** what it holds */
  readonly value: string | readonly string[];
  /** whether it is an address or an identifier, to be shown in a mono face */
  readonly mono?: boolean;
};

/** How each authorization mode reads. */
const authorizationWords: Record<AuthorizationMode, string> = {
  open: "Open (no authorization)",
  smart: "SMART on FHIR",
};

/** How each registration mode reads. */
const registrationWords: Record<RegistrationMode, string> = {
  open: "None needed",
  manual: "Manual, by the server's owner",
  trustedDcr: "Automatic, against a Muster software statement",
};

/** What a would-be client has to do, for each registration mode. */
const registrationAdvice: Record<RegistrationMode, string> = {
  open: "No registration is needed at this server, so there is nothing to request.",
  manual:
    "Registration is manual: a pairing request goes to the server's owner, who registers the client and records the identifier they issued.",
  trustedDcr:
    "This server accepts a Muster-signed software statement, so a client can be registered without a person on the server's side.",
};

/**
 * Renders a JWT date claim as the instant it names.
 *
 * Shared by the two screens that decode a signed artefact - the registration run and
 * the ticket playground - because a member checking whether an expiry was capped
 * cannot read a count of seconds, and both screens would otherwise convert it their
 * own way.
 *
 * @param label - the claim's name, as the profile spells it
 * @param seconds - the claim's value, in seconds since the epoch
 * @returns the row to show
 * @example
 * ```ts
 * instantDetail("exp", claims.exp);
 * // { label: "exp", value: "2026-09-11T00:00:00.000Z", mono: true }
 * ```
 */
export const instantDetail = (label: string, seconds: number): Detail => ({
  label,
  value: new Date(seconds * 1000).toISOString(),
  mono: true,
});

/**
 * Drops the fields that hold nothing.
 *
 * FR-006's optional fields are genuinely optional, and a row showing a label
 * against a blank says less than no row at all.
 *
 * @param details - every field the profile could carry
 * @returns the fields that hold something
 */
const present = (details: readonly Detail[]): readonly Detail[] =>
  details.filter((detail) =>
    typeof detail.value === "string"
      ? detail.value.trim().length > 0
      : detail.value.length > 0,
  );

/**
 * Describes a server profile.
 *
 * @param profile - the server profile
 * @returns its fields, with the modes in words and the empty ones omitted
 * @example
 * ```tsx
 * <DetailList details={serverDetails(system.serverProfile)} />
 * ```
 */
export const serverDetails = (profile: ServerProfile): readonly Detail[] =>
  present([
    { label: "FHIR base URL", value: profile.fhirBaseUrl, mono: true },
    {
      label: "Authorization",
      value: authorizationWords[profile.authorizationMode],
    },
    {
      label: "Registration",
      value: registrationWords[profile.registrationMode],
    },
    {
      label: "Registration endpoint",
      value: profile.registrationEndpoint ?? "",
      mono: true,
    },
    { label: "Notes", value: profile.notes },
  ]);

/**
 * Describes a client profile.
 *
 * @param profile - the client profile
 * @returns its fields, with the lists kept as lists
 * @example
 * ```tsx
 * <DetailList details={clientDetails(system.clientProfile)} />
 * ```
 */
export const clientDetails = (profile: ClientProfile): readonly Detail[] =>
  present([
    { label: "Launch URL", value: profile.launchUrl, mono: true },
    { label: "Redirect URIs", value: profile.redirectUris, mono: true },
    { label: "Scopes", value: profile.scopes, mono: true },
    {
      label: "Client type",
      value:
        profile.confidentiality === "confidential"
          ? "Confidential (keeps a secret)"
          : "Public (cannot keep a secret)",
    },
    { label: "Launch context", value: profile.launchContext },
    {
      label: "Token introspection",
      value: profile.needsIntrospection ? "Needed" : "Not needed",
    },
  ]);

/**
 * What a would-be client has to do to register at this server.
 *
 * @param profile - the server profile
 * @returns the guidance, in words fit to show a reader
 * @example
 * ```tsx
 * <p>{registrationGuidance(system.serverProfile)}</p>
 * ```
 */
export const registrationGuidance = (profile: ServerProfile): string =>
  registrationAdvice[profile.registrationMode];
