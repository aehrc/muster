# Contract: permission ticket profile

What Muster mints in the ticket playground and what a data holder (Signet's
`002-trusted-dcr-tickets`, or any other implementer) accepts. Follows the
SMART Permission Tickets draft 0.1.0; claim names are centralised in
`packages/core/src/tickets/` so draft drift is one module's change.

## Ticket

Signed JWS (ES256, `kid` in header), minted by Muster's ticket-purpose key.

| Claim          | Meaning                                                    |
| -------------- | ----------------------------------------------------------- |
| `iss`          | Muster's issuer identifier (`{MUSTER_PUBLIC_URL}`)          |
| `jti`          | unique ticket identifier                                    |
| `iat` / `exp`  | mint time / expiry (≤ event end + grace)                    |
| `ticket_type`  | `patient-self-access` (only type in scope)                  |
| `subject`      | `{ "identifier": { "system": "http://ns.electronichealth.net.au/id/hi/ihi/1.0", "value": "<IHI>" } }` |
| `smart_scopes` | space-separated scope constraints chosen at mint            |
| `muster_event` | event slug                                                  |

## Presentation (data holder side)

RFC 8693 token exchange at the data holder's token endpoint:

```http
POST {tokenEndpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<ticket JWS>
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
&scope=<requested scopes>
&client_id=...&client_assertion=...   (client authenticates)
```

## Data holder obligations (normative summary)

1. Validate signature against the issuer's published keys, issuer match,
   temporal validity, and `ticket_type` membership in the holder's accepted
   set.
2. Authenticate the presenting client; refuse public/unauthenticated
   presenters.
3. Resolve `subject.identifier` to exactly one local patient; zero or many
   matches refuse the exchange.
4. Granted scopes = requested ∩ `smart_scopes` ∩ holder policy; empty →
   refuse.
5. Access-token lifetime ≤ remaining ticket validity.
6. Advertise accepted types via `smart_permission_ticket_types_supported`
   in `.well-known/smart-configuration` - only while enabled.

## Discovery

Muster's verification checks read
`smart_permission_ticket_types_supported` from each enrolled server's
smart-configuration and surface support on the event view.
