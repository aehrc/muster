/**
 * The documentation index: what a vendor has to implement, and where the keys are.
 *
 * Public, like the rest of the read surface (constitution principle V). Nothing on this page
 * needs an account and nothing on it is hidden from one.
 *
 * **What lives here, and what lives on the server.** The two profiles are rendered from the
 * vendor-facing contracts by the server at `/docs/registration-profile` and
 * `/docs/ticket-profile` - standalone documents a vendor links to and reads with JavaScript
 * disabled. This page is the signposted index that points at them, and it adds the two things
 * a document cannot: this deployment's live key identifiers, read from the same JWKS a
 * verifier fetches, and worked examples of the exchange.
 *
 * **The worked example is statement-only.** The whole request body is the statement, because
 * the anchor vouches for the metadata: a body that could also assert a redirect URI would
 * reopen the gap vouching closes, and the profile forbids honouring one.
 *
 * Author: John Grimes
 */

import { describeError } from "../api/errors.js";
import { useJwks } from "../api/queries.js";
import {
  DetailRow,
  ErrorAlert,
  Loading,
  PageHeader,
  Panel,
} from "../components/layout.js";

/**
 * A copy-and-run registration request.
 *
 * Joined from lines rather than written as one template literal, so the shell's line
 * continuations are the characters they look like rather than an escaping puzzle.
 */
const REGISTRATION_EXAMPLE = [
  "curl -sS -X POST https://auth.example.org/register \\",
  '  -H "Content-Type: application/json" \\',
  `  -d '{"software_statement": "eyJhbGciOiJFUzI1NiIsImtpZCI6Ii4uLiJ9..."}'`,
].join("\n");

/** What a server does with it. */
const VERIFICATION_EXAMPLE = `# 1. Read the protected header's kid.
# 2. Fetch the anchor's JWKS and match it. Refetch once on an unknown kid.
# 3. Verify ES256, check iss, and check now is within iat..exp.
# 4. Refuse a jti this server has already registered (single use).
# 5. Apply your own client validation to the metadata in the statement.
# 6. Cap the client's ability to obtain tokens at exp.`;

/**
 * The key identifiers currently in the JWKS.
 *
 * Its own component so the page reads as a page: the three states a read can be in - waiting,
 * refused, answered (FR-037) - are a branch, and a branch in the middle of a layout is where a
 * missing state gets forgotten.
 */
function PublishedKeys() {
  const jwks = useJwks();

  if (jwks.isPending) {
    return <Loading label="Reading the JWKS" />;
  }
  if (jwks.error !== null) {
    return <ErrorAlert message={describeError(jwks.error)} />;
  }
  return (
    <ul className="plain-list">
      {jwks.data.keys.map((key) => (
        <li className="wrap" key={key.kid ?? ""}>
          <code>{key.kid}</code> ({key.alg})
        </li>
      ))}
    </ul>
  );
}

/** Where the profiles are, and what this deployment's anchor identity is. */
export function Docs() {
  return (
    <article className="page-wide">
      <PageHeader
        title="Documentation"
        subtitle="Everything on this page is public: no account is needed to read it, and none is needed to implement against it."
      />

      <div className="card-row">
        <Panel
          title="Registration profile"
          description="What a server implements to accept Muster-vouched dynamic client registration."
        >
          <p>
            The software statement&apos;s claims, the validation rules a server
            must apply, the error vocabulary, and expiry semantics - a statement
            vouches only until the event&apos;s end plus its grace period, and a
            server caps the client&apos;s access at that.
          </p>
          <p>
            <a
              className="button button-primary"
              href="/docs/registration-profile"
            >
              Read the registration profile
            </a>
          </p>
        </Panel>

        <Panel
          title="Permission ticket profile"
          description="What a data holder expects when a client presents a Muster-minted ticket."
        >
          <p>
            The ticket&apos;s claims, how it is presented by token exchange, and
            the data holder&apos;s obligations: resolve the subject to exactly
            one patient, intersect the scopes, and never accept an
            unauthenticated presenter.
          </p>
          <p>
            <a className="button button-primary" href="/docs/ticket-profile">
              Read the ticket profile
            </a>
          </p>
        </Panel>
      </div>

      <Panel
        title="Signing keys"
        description="The document a verifier fetches, and what is in it right now."
      >
        <DetailRow label="JWKS">
          <span className="wrap">
            <a href="/.well-known/jwks.json">/.well-known/jwks.json</a>
          </span>
        </DetailRow>
        <DetailRow label="Key identifiers published">
          <PublishedKeys />
        </DetailRow>
        <p className="note">
          Muster signs software statements and permission tickets with separate
          keys, and every artefact names the key it was signed with. A
          superseded key stays published until everything signed with it has
          expired, so rotating a key never invalidates an outstanding statement
          or ticket.
        </p>
      </Panel>

      <Panel
        title="Worked examples"
        description="The exchange as a server sees it."
      >
        <h3>Presenting a statement</h3>
        <pre className="code-block">{REGISTRATION_EXAMPLE}</pre>
        <p className="quiet">
          The whole body is the statement. A server must ignore or reject client
          metadata asserted outside it - the anchor vouches for what is inside,
          so nothing outside may override it.
        </p>
        <h3>What the server does with it</h3>
        <pre className="code-block">{VERIFICATION_EXAMPLE}</pre>
        <p className="quiet">
          Muster&apos;s conformance harness checks each of these against a real
          endpoint, so a vendor can prove they hold before event day.
        </p>
      </Panel>
    </article>
  );
}
