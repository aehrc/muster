# Contract: trusted dynamic client registration profile

The vendor-facing profile. Muster's public docs pages render this contract,
Muster's harness enforces it, and Signet's `002-trusted-dcr-tickets` feature
implements it. It profiles RFC 7591 (OAuth 2.0 Dynamic Client Registration).

## Actors

- **Trust anchor**: Muster. Publishes signing keys at
  `{MUSTER_PUBLIC_URL}/.well-known/jwks.json`; issuer identifier is
  `{MUSTER_PUBLIC_URL}`.
- **Server**: a participant's authorization server exposing a registration
  endpoint (location declared in the server's Muster entry).

## Registration request

```http
POST {registrationEndpoint}
Content-Type: application/json

{ "software_statement": "<JWS>" }
```

Statement-only: all client metadata lives inside the statement. A server
MUST ignore (or reject) any metadata asserted outside `software_statement` -
the anchor vouches for the metadata, so nothing may override it.

## Software statement claims

Signed JWS, ES256, `kid` in the protected header.

| Claim                       | Meaning                                              |
| --------------------------- | ----------------------------------------------------- |
| `iss`                       | the trust anchor issuer identifier                    |
| `sub` / `software_id`       | Muster's system identifier for the client             |
| `jti`                       | unique statement identifier - single registration use |
| `iat` / `exp`               | mint time / vouching expiry (≤ event end + grace)     |
| `muster_event`              | event slug the vouching is scoped to                  |
| `client_name`               | display name                                          |
| `redirect_uris`             | array, at least one                                   |
| `grant_types`               | e.g. `["authorization_code", "refresh_token"]`        |
| `token_endpoint_auth_method`| `none` (public) or `private_key_jwt`/`client_secret_basic` (confidential) |
| `scope`                     | space-separated requested scopes                      |
| `smart_launch_url`          | the app's launch URL (extension claim; servers that launch apps need it) |

## Validation rules a server MUST apply

1. Signature verifies against a key currently published in the anchor's
   JWKS, matched by `kid`. Keys MUST be fetched fresh or provably current;
   verification against a stale cache MUST NOT succeed when the key has been
   withdrawn. Unknown `kid` → refetch once → refuse if still unknown.
2. `iss` equals the configured anchor issuer.
3. Now is within `iat`..`exp`.
4. `jti` has not been used for a prior registration at this server
   (single-use; a race yields exactly one client).
5. The metadata passes the server's own client validation (redirect URI
   rules included). Vouching attests origin, not validity.
6. The created client's ability to obtain tokens ends at `exp` (the
   vouching expiry). Servers MAY cap harder per their own policy.

## Registration response

Per RFC 7591: `201` with `client_id` and, for confidential clients,
`client_secret` (returned once). Muster relays the secret to the initiating
member exactly once and never stores it.

## Errors

RFC 7591 error responses with `error` values:
`invalid_software_statement` (signature, issuer, temporal, replay),
`invalid_client_metadata` (metadata fails server validation),
`invalid_request` (shape). Servers SHOULD distinguish these; the harness
checks that they do.

## Harness checks (normative summary)

| Check                     | Expectation                                    |
| ------------------------- | ----------------------------------------------- |
| Valid statement           | 201, client created, metadata fidelity          |
| Tampered signature        | refused, `invalid_software_statement`           |
| Expired statement         | refused, `invalid_software_statement`           |
| Replayed `jti`            | refused on second use                           |
| Metadata fidelity         | registered client equals statement metadata     |

Event scoping is the anchor's job: Muster never mints for an unknown or
closed event, so servers need no view of the event calendar. A server MAY
additionally pin the `muster_event` values it accepts; the harness treats
such enforcement as informational, not required.
