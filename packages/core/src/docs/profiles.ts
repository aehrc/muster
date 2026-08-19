/**
 * The profiles Muster publishes, as data.
 *
 * A vendor implements against these documents, and Muster's own harness enforces
 * what they say, so they are part of the product rather than commentary on it.
 * They are held here, in the pure core, for two reasons: they are a function of
 * the deployment's issuer identifier and nothing else, and both the server (which
 * renders them as HTML, so that they can be read from a terminal or quoted in an
 * email) and the console (which renders them as part of the site) need the same
 * document. One source, two renderers, no drift.
 *
 * The wording follows `contracts/registration-profile.md` and
 * `contracts/ticket-profile.md`. Where those documents say MUST or SHOULD, so does
 * this one: an implementer is entitled to know which of the two they are reading.
 *
 * @author John Grimes
 */

/** One element of a document. */
export type DocBlock =
  /** running prose */
  | { readonly kind: "paragraph"; readonly text: string }
  /** an unordered list */
  | { readonly kind: "list"; readonly items: readonly string[] }
  /** a numbered list, where the order is part of the meaning */
  | { readonly kind: "steps"; readonly items: readonly string[] }
  /** a table, with a header row */
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  /** a verbatim block: a request, a response, or a claim set */
  | { readonly kind: "code"; readonly caption: string; readonly text: string };

/** One section of a document. */
export type DocSection = {
  /** the section's heading */
  readonly heading: string;
  /** what it says */
  readonly blocks: readonly DocBlock[];
};

/** One published profile. */
export type ProfileDocument = {
  /** the path segment it is published under */
  readonly slug: string;
  /** its title */
  readonly title: string;
  /** one sentence saying what it is for */
  readonly summary: string;
  /** its sections, in order */
  readonly sections: readonly DocSection[];
};

/**
 * The trusted dynamic client registration profile.
 *
 * @param issuer - the deployment's issuer identifier, from `MUSTER_PUBLIC_URL`
 * @returns the document
 */
const registrationProfile = (issuer: string): ProfileDocument => ({
  slug: "registration-profile",
  title: "Trusted dynamic client registration profile",
  summary:
    "What a server implements in order to register a client that Muster vouches for, with no human on the server's side.",
  sections: [
    {
      heading: "Actors",
      blocks: [
        {
          kind: "list",
          items: [
            `Trust anchor: Muster. Its issuer identifier is ${issuer}, and it publishes its signing keys at ${issuer}/.well-known/jwks.json.`,
            "Server: a participant's authorization server, exposing a registration endpoint declared in its Muster entry.",
            "Client owner: the organisation whose client is being registered. It initiates the run; the server's consent is its published endpoint.",
          ],
        },
      ],
    },
    {
      heading: "Registration request",
      blocks: [
        {
          kind: "code",
          caption: "What Muster POSTs to the registration endpoint",
          text: [
            "POST {registrationEndpoint}",
            "Content-Type: application/json",
            "",
            '{ "software_statement": "<JWS>" }',
          ].join("\n"),
        },
        {
          kind: "paragraph",
          text: "Statement-only: all client metadata lives inside the statement. A server MUST ignore, or reject, any metadata asserted outside software_statement - the anchor vouches for the metadata, so nothing may override it.",
        },
      ],
    },
    {
      heading: "Software statement claims",
      blocks: [
        {
          kind: "paragraph",
          text: "A signed JWS: ES256, with kid in the protected header.",
        },
        {
          kind: "table",
          columns: ["Claim", "Meaning"],
          rows: [
            ["iss", `the trust anchor's issuer identifier (${issuer})`],
            ["sub", "Muster's system identifier for the client"],
            [
              "software_id",
              "the same identifier, under RFC 7591's name for it",
            ],
            [
              "jti",
              "unique statement identifier; a single registration may use it once",
            ],
            ["iat", "when the statement was minted"],
            [
              "exp",
              "when vouching stops: never later than the event's end plus its grace period",
            ],
            ["muster_event", "the event slug the vouching is scoped to"],
            ["client_name", "the client's display name"],
            ["redirect_uris", "array, at least one"],
            [
              "grant_types",
              'currently ["authorization_code", "refresh_token"]',
            ],
            [
              "token_endpoint_auth_method",
              "none for a public client, client_secret_basic for a confidential one",
            ],
            ["scope", "space-separated requested scopes"],
            [
              "smart_launch_url",
              "the app's launch URL; an extension claim, for servers that launch apps",
            ],
          ],
        },
        {
          kind: "code",
          caption: "A worked example: the claims of one statement",
          text: JSON.stringify(
            {
              iss: issuer,
              sub: "0f1a6b6e-6f5f-4a4e-9f4a-2f0b6c2a9d11",
              software_id: "0f1a6b6e-6f5f-4a4e-9f4a-2f0b6c2a9d11",
              jti: "9c9f2b25-05a6-4a5c-9d3a-6f8f2c5d1b77",
              iat: 1_788_000_000,
              exp: 1_788_432_000,
              muster_event: "sparked-2026-09",
              client_name: "Smart Forms",
              redirect_uris: ["https://smartforms.example.org/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              token_endpoint_auth_method: "none",
              scope: "launch/patient patient/Observation.rs openid fhirUser",
              smart_launch_url: "https://smartforms.example.org/launch",
            },
            undefined,
            2,
          ),
        },
      ],
    },
    {
      heading: "Validation rules a server MUST apply",
      blocks: [
        {
          kind: "steps",
          items: [
            `The signature verifies against a key currently published at ${issuer}/.well-known/jwks.json, matched by kid. Keys MUST be fetched fresh or be provably current: verification against a stale cache MUST NOT succeed once the key has been withdrawn. An unknown kid means refetch once, then refuse.`,
            `iss equals the configured anchor issuer (${issuer}).`,
            "Now is within iat..exp.",
            "The jti has not been used for a prior registration at this server. It is single-use, and a race yields exactly one client.",
            "The metadata passes the server's own client validation, redirect URI rules included. Vouching attests origin, not validity.",
            "The created client's ability to obtain tokens ends at exp. A server MAY cap harder under its own policy.",
          ],
        },
      ],
    },
    {
      heading: "Registration response",
      blocks: [
        {
          kind: "paragraph",
          text: "Per RFC 7591: 201 with client_id and, for a confidential client, client_secret returned once. Muster relays the secret to the initiating member exactly once and never stores it.",
        },
        {
          kind: "paragraph",
          text: "Per RFC 7591 section 3.2.1 the response MUST also return the registered client metadata. That is what makes the conformance harness's fidelity check possible: a response carrying only an identifier leaves no way to show that the client created is the client vouched for.",
        },
        {
          kind: "paragraph",
          text: "A server MAY additionally return RFC 7592's registration_client_uri and registration_access_token. The harness uses them to delete the throwaway client it registers; a server that returns neither has that client reported as left behind, which is a note in the report rather than a failure.",
        },
        {
          kind: "code",
          caption: "A worked example: the response to the request above",
          text: JSON.stringify(
            {
              client_id: "smart-forms-9f21",
              client_name: "Smart Forms",
              redirect_uris: ["https://smartforms.example.org/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              token_endpoint_auth_method: "none",
              scope: "launch/patient patient/Observation.rs openid fhirUser",
              client_id_issued_at: 1_788_000_001,
              client_secret_expires_at: 0,
            },
            undefined,
            2,
          ),
        },
      ],
    },
    {
      heading: "Errors",
      blocks: [
        {
          kind: "paragraph",
          text: "RFC 7591 error responses. A server SHOULD distinguish these three; the harness checks that it does, and reports a discrepancy as an advisory rather than a failure.",
        },
        {
          kind: "table",
          columns: ["error", "When"],
          rows: [
            [
              "invalid_software_statement",
              "signature, issuer, temporal or replay failure",
            ],
            [
              "invalid_client_metadata",
              "the metadata fails the server's own validation",
            ],
            ["invalid_request", "the request's shape is wrong"],
          ],
        },
      ],
    },
    {
      heading: "Conformance checks",
      blocks: [
        {
          kind: "paragraph",
          text: "What Muster's harness runs against a registration endpoint. Only a MUST failing removes the verified badge.",
        },
        {
          kind: "table",
          columns: ["Check", "Expectation"],
          rows: [
            ["Valid statement", "201, client created, metadata fidelity"],
            ["Tampered signature", "refused, invalid_software_statement"],
            ["Expired statement", "refused, invalid_software_statement"],
            ["Replayed jti", "refused on second use"],
            [
              "Metadata fidelity",
              "the registered client equals the statement's metadata",
            ],
            [
              "Statement only",
              "metadata asserted outside the statement is refused or ignored",
            ],
          ],
        },
      ],
    },
    {
      heading: "Event scoping",
      blocks: [
        {
          kind: "paragraph",
          text: "Event scoping is the anchor's job. Muster never mints for an unknown or closed event, so a server needs no view of the event calendar. A server MAY additionally pin the muster_event values it accepts; the harness treats such enforcement as informational rather than required.",
        },
      ],
    },
  ],
});

/**
 * The permission ticket profile.
 *
 * @param issuer - the deployment's issuer identifier, from `MUSTER_PUBLIC_URL`
 * @returns the document
 */
const ticketProfile = (issuer: string): ProfileDocument => ({
  slug: "ticket-profile",
  title: "Permission ticket profile",
  summary:
    "What Muster mints in the ticket playground, and what a data holder accepts. Follows the SMART Permission Tickets draft 0.1.0.",
  sections: [
    {
      heading: "The ticket",
      blocks: [
        {
          kind: "paragraph",
          text: "A signed JWS - ES256, with kid in the protected header - minted by Muster's ticket-purpose key. The same key set publishes it: see the registration profile for the address.",
        },
        {
          kind: "table",
          columns: ["Claim", "Meaning"],
          rows: [
            ["iss", `Muster's issuer identifier (${issuer})`],
            ["jti", "unique ticket identifier"],
            [
              "iat / exp",
              "mint time and expiry; never later than the event's end plus its grace period",
            ],
            ["ticket_type", "patient-self-access, the only type in scope"],
            [
              "subject",
              '{ "identifier": { "system": "http://ns.electronichealth.net.au/id/hi/ihi/1.0", "value": "<IHI>" } }',
            ],
            [
              "smart_scopes",
              "space-separated scope constraints chosen at mint time",
            ],
            ["muster_event", "the event slug the ticket is scoped to"],
          ],
        },
      ],
    },
    {
      heading: "Presentation",
      blocks: [
        {
          kind: "paragraph",
          text: "RFC 8693 token exchange at the data holder's token endpoint.",
        },
        {
          kind: "code",
          caption: "What a client presents",
          text: [
            "POST {tokenEndpoint}",
            "Content-Type: application/x-www-form-urlencoded",
            "",
            "grant_type=urn:ietf:params:oauth:grant-type:token-exchange",
            "&subject_token=<ticket JWS>",
            "&subject_token_type=urn:ietf:params:oauth:token-type:jwt",
            "&scope=<requested scopes>",
            "&client_id=...&client_assertion=...",
          ].join("\n"),
        },
      ],
    },
    {
      heading: "Data holder obligations",
      blocks: [
        {
          kind: "steps",
          items: [
            "Validate the signature against the issuer's published keys, the issuer match, temporal validity, and that ticket_type is in the holder's accepted set.",
            "Authenticate the presenting client. Refuse public or unauthenticated presenters.",
            "Resolve subject.identifier to exactly one local patient. Zero matches, or many, refuse the exchange.",
            "Granted scopes are the requested scopes intersected with smart_scopes and with the holder's own policy. An empty intersection refuses.",
            "The access token's lifetime is no longer than the ticket's remaining validity.",
            "Advertise the accepted types as smart_permission_ticket_types_supported in .well-known/smart-configuration, and only while the feature is enabled.",
          ],
        },
      ],
    },
    {
      heading: "Discovery",
      blocks: [
        {
          kind: "paragraph",
          text: "Muster's verification checks read smart_permission_ticket_types_supported from each enrolled server's smart-configuration and surface support on the event view, so a participant can see who accepts tickets before trying one.",
        },
      ],
    },
  ],
});

/**
 * Every profile Muster publishes.
 *
 * @param issuer - the deployment's issuer identifier, from `MUSTER_PUBLIC_URL`
 * @returns the documents, in the order they are listed
 * @example
 * ```ts
 * const documents = profileDocuments(config.publicUrl);
 * ```
 */
export const profileDocuments = (
  issuer: string,
): readonly ProfileDocument[] => [
  registrationProfile(issuer),
  ticketProfile(issuer),
];

/**
 * Finds one published profile.
 *
 * @param issuer - the deployment's issuer identifier
 * @param slug - the path segment asked for
 * @returns the document, or undefined when nothing is published under that slug
 * @example
 * ```ts
 * const document = findProfileDocument(config.publicUrl, "registration-profile");
 * ```
 */
export const findProfileDocument = (
  issuer: string,
  slug: string,
): ProfileDocument | undefined =>
  profileDocuments(issuer).find((document) => document.slug === slug);
