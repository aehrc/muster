import { describe, expect, test } from "bun:test";

import {
  authoriseHarnessRun,
  cleanupTarget,
  describeCleanup,
  expiredClaims,
  harnessCheckOrder,
  harnessCheckTitles,
  harnessProbeFields,
  harnessRequestEvidence,
  harnessResponseEvidence,
  harnessVerdict,
  judgeAcceptance,
  judgeFidelity,
  judgeRefusal,
  judgeStatementOnly,
  maximumEvidenceLength,
  metadataDifferences,
  redactStatement,
  tamperedStatement,
  vouchedMetadata,
} from "./checks.ts";
import { statementClaims } from "../statements/build.ts";

import type { HarnessExchange } from "./checks.ts";
import type { AccountFacts } from "../accounts/rules.ts";
import type { HarnessCheck, HarnessCheckName } from "@muster/contracts";

/**
 * The conformance harness's judgements, with no network and no server anywhere
 * near them.
 *
 * The harness is the thing that decides whether a vendor's server implements the
 * profile, so what it decides has to be decidable from the exchange alone: a
 * request and a response in, a pass or a fail with its reason out. Everything in
 * this suite is that function, which is why the whole of User Story 6's judgement
 * can be tested without a registration endpoint.
 *
 * Four rules are load-bearing here. A MUST that fails is a failure and removes
 * the badge; a SHOULD that fails - the RFC 7591 error vocabulary - is an advisory
 * and the run still passes. Deny by default applies to a run as much as to a
 * mint: a run missing one of the profile's checks has not passed the profile. The
 * recorded evidence is redacted, because the report is public and a statement
 * with a working signature in it is a vouching artefact anybody could spend. And
 * a client the harness registered is either deleted or reported as left behind -
 * never quietly forgotten.
 */

/** An approved, verified member: the account the harness runs as. */
const approved: AccountFacts = {
  status: "approved",
  emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
  isAdmin: false,
};

/** The moment every judgement in this suite is made at. */
const now = new Date("2026-08-19T03:04:05.000Z");

/** The claims of the statement the harness vouches its throwaway client with. */
const claims = statementClaims({
  issuer: "https://muster.example.org",
  eventSlug: "sparked-2026-09",
  eventEndsOn: "2026-09-03",
  graceDays: 7,
  softwareId: "harness:11111111-1111-1111-1111-111111111111",
  jti: "1e0c1c0e-0000-4000-8000-000000000001",
  fields: harnessProbeFields({ publicUrl: "https://muster.example.org" }),
  now,
});

/** What the statement vouches for, which is what fidelity is measured against. */
const vouched = vouchedMetadata(claims);

/**
 * Builds an exchange from a status and a response body.
 *
 * @param status - the status the server answered with
 * @param body - the JSON body it answered with
 * @returns the exchange, with the request the harness would have made
 */
const exchangeWith = (
  status: number,
  body: Record<string, unknown> | null,
): HarnessExchange => ({
  request: harnessRequestEvidence("POST", "https://stub.example.org/register", {
    software_statement: "header.payload.signature",
  }),
  response: harnessResponseEvidence(
    status,
    body === null ? "" : JSON.stringify(body),
  ),
});

// A conformant 201, carrying the registered metadata per RFC 7591 section 3.2.1.
const registered = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  client_id: "stub-abc123",
  client_id_issued_at: 1_755_000_000,
  ...vouched,
  registration_client_uri: "https://stub.example.org/register/stub-abc123",
  registration_access_token: "rat-secret",
  ...overrides,
});

// A refusal in RFC 7591's shape.
const refusal = (
  error: string,
  description = "The statement did not verify.",
): Record<string, unknown> => ({ error, error_description: description });

/**
 * Builds a check with a given name and outcome, for aggregation tests.
 *
 * @param name - the check
 * @param outcome - how it turned out
 * @returns the check
 */
const checkWith = (
  name: HarnessCheckName,
  outcome: HarnessCheck["outcome"],
): HarnessCheck => ({
  name,
  title: harnessCheckTitles[name],
  outcome,
  detail: "",
  request: harnessRequestEvidence("POST", "https://stub.example.org/register", {
    software_statement: "a.b.c",
  }),
  response: harnessResponseEvidence(201, "{}"),
});

// A full set of checks, each with the outcome given.
const everyCheck = (
  outcome: HarnessCheck["outcome"] = "passed",
): readonly HarnessCheck[] =>
  harnessCheckOrder.map((name) => checkWith(name, outcome));

// Who may run one ---------------------------------------------------------

describe("authorising a run", () => {
  /** The facts of a run a server owner is entitled to make. */
  const permitted = {
    member: approved,
    ownsServer: true,
    eventStatus: "open",
    registrationMode: "trustedDcr",
    registrationEndpoint: "https://stub.example.org/register",
  } as const;

  // The server's own owner, on an open event, against an entry that declares
  // trusted registration: the only combination that runs.
  test("permits the owner of a trusted-DCR server in an open event", () => {
    expect(authoriseHarnessRun(permitted).ok).toBe(true);
  });

  // The harness mints statements, which is a vouching action: an account that
  // cannot write cannot vouch (the constitution).
  test("refuses a revoked account", () => {
    const decision = authoriseHarnessRun({
      ...permitted,
      member: { ...approved, status: "revoked" },
    });

    expect(decision.ok).toBe(false);
    expect(decision.ok ? "" : decision.refusal.reason).toBe("revoked");
  });

  test("refuses an account with an unverified address", () => {
    const decision = authoriseHarnessRun({
      ...permitted,
      member: { ...approved, emailVerifiedAt: null },
    });

    expect(decision.ok ? "" : decision.refusal.reason).toBe("not_verified");
  });

  // The harness posts signed statements at somebody's registration endpoint. It
  // is the entry's own organisation that may ask for that, and nobody else.
  test("refuses a member of another organisation", () => {
    const decision = authoriseHarnessRun({ ...permitted, ownsServer: false });

    expect(decision.ok ? "" : decision.refusal.reason).toBe("not_member");
  });

  test("refuses a run against a closed event", () => {
    const decision = authoriseHarnessRun({
      ...permitted,
      eventStatus: "closed",
    });

    expect(decision.ok ? "" : decision.refusal.reason).toBe("event_not_open");
  });

  // A server that registers clients by hand has nothing for the harness to
  // check, and one that declares no endpoint has nowhere to check it.
  test("refuses a run against a manual-registration server", () => {
    const decision = authoriseHarnessRun({
      ...permitted,
      registrationMode: "manual",
    });

    expect(decision.ok ? "" : decision.refusal.reason).toBe(
      "manual_registration",
    );
  });

  test("refuses a trusted-DCR entry that declares no endpoint", () => {
    const decision = authoriseHarnessRun({
      ...permitted,
      registrationEndpoint: null,
    });

    expect(decision.ok ? "" : decision.refusal.reason).toBe("invalid_metadata");
  });
});

// What the harness vouches for -------------------------------------------

describe("the throwaway client", () => {
  // Every address derives from the public URL, and the name says what it is so a
  // server owner reading their own client list knows where it came from.
  test("derives its addresses from the public URL and names itself", () => {
    const fields = harnessProbeFields({
      publicUrl: "https://muster.example.org",
    });

    expect(fields.clientName).toContain("Muster");
    expect(fields.clientName.toLowerCase()).toContain("harness");
    expect(fields.launchUrl.startsWith("https://muster.example.org/")).toBe(
      true,
    );
    expect(fields.redirectUris).toHaveLength(1);
    expect(
      fields.redirectUris[0]?.startsWith("https://muster.example.org/"),
    ).toBe(true);
  });

  // A public client, so no secret is ever issued for it: the harness has no
  // business holding somebody's client secret, even a throwaway one.
  test("is a public client, so no secret is issued for it", () => {
    expect(
      harnessProbeFields({ publicUrl: "https://muster.example.org" })
        .confidentiality,
    ).toBe("public");
    expect(claims.token_endpoint_auth_method).toBe("none");
  });

  // The metadata under comparison is the profile's client metadata and nothing
  // else: `iss`, `jti` and the rest are not the server's to echo back.
  test("vouches for exactly the profile's client metadata", () => {
    expect(Object.keys(vouched).toSorted()).toEqual([
      "client_name",
      "grant_types",
      "redirect_uris",
      "scope",
      "smart_launch_url",
      "token_endpoint_auth_method",
    ]);
    expect(vouched["client_name"]).toBe(claims.client_name);
    expect(vouched["redirect_uris"]).toEqual(claims.redirect_uris);
  });
});

// The variants the checks need -------------------------------------------

describe("building the variants", () => {
  // The expired statement is a real statement, correctly signed, whose vouching
  // window has closed: the only thing a server can refuse it for is its expiry.
  test("dates an expired statement wholly in the past", () => {
    const expired = expiredClaims(claims, now);

    expect(expired.exp * 1000).toBeLessThan(now.getTime());
    expect(expired.iat).toBeLessThan(expired.exp);
    expect(expired.jti).toBe(claims.jti);
    expect(expired.client_name).toBe(claims.client_name);
  });

  // The tampered statement keeps its header and its claims - so a server reading
  // it without verifying finds a perfectly good statement - and differs only in
  // the signature, which is the thing under test.
  test("tampers with the signature and nothing else", () => {
    const tampered = tamperedStatement("header.payload.AsignatureBytes");

    const [header, payload, signature] = tampered.split(".");
    expect(header).toBe("header");
    expect(payload).toBe("payload");
    expect(signature).not.toBe("AsignatureBytes");
    expect(signature).toHaveLength("AsignatureBytes".length);
    expect(signature).toMatch(/^[\w-]+$/);
  });

  // Whatever the first character is, it changes: a tamper that happened to be a
  // no-op would make the check pass against a server that never verifies.
  test("changes the signature whatever it starts with", () => {
    for (const signature of ["Abc", "Bbc", "-bc", "_bc"]) {
      expect(tamperedStatement(`h.p.${signature}`).split(".")[2]).not.toBe(
        signature,
      );
    }
  });

  // A statement that is not three segments cannot be tampered with meaningfully,
  // and pretending otherwise would report a signature failure that was really a
  // malformed artefact.
  test("refuses to tamper with something that is not a JWS", () => {
    expect(() => tamperedStatement("not-a-jws")).toThrow();
  });
});

// Recorded evidence -------------------------------------------------------

describe("redacting the evidence", () => {
  // The report is public. A statement is a vouching artefact: with its signature
  // it registers a client at any server that trusts Muster, and without it the
  // claims are still fully readable.
  test("keeps a statement's claims and removes its signature", () => {
    const redacted = redactStatement("header.payload.signature");

    expect(redacted.startsWith("header.payload.")).toBe(true);
    expect(redacted).not.toContain("signature");
  });

  test("redacts the statement inside a recorded request", () => {
    const evidence = harnessRequestEvidence(
      "POST",
      "https://stub.example.org/register",
      {
        software_statement: "header.payload.signature",
        client_name: "Outside",
      },
    );

    expect(evidence.method).toBe("POST");
    expect(evidence.url).toBe("https://stub.example.org/register");
    expect(String(evidence.body["software_statement"])).not.toContain(
      "signature",
    );
    // Metadata asserted outside the statement is kept: it is what the
    // statement-only check is evidence of.
    expect(evidence.body["client_name"]).toBe("Outside");
  });

  // No credential is ever written down (the constitution). Both of these are
  // credentials, and both are replaced rather than dropped, so the report still
  // shows that the server issued them.
  test("redacts a client secret and a registration access token", () => {
    const evidence = harnessResponseEvidence(
      201,
      JSON.stringify({
        client_id: "stub-abc123",
        client_secret: "s3cret",
        registration_access_token: "rat-secret",
        client_name: "Probe",
      }),
    );

    expect(JSON.stringify(evidence.body)).not.toContain("s3cret");
    expect(JSON.stringify(evidence.body)).not.toContain("rat-secret");
    expect(evidence.body?.["client_secret"]).toBe("[redacted]");
    expect(evidence.body?.["registration_access_token"]).toBe("[redacted]");
    expect(evidence.body?.["client_id"]).toBe("stub-abc123");
    expect(evidence.text).toBeNull();
  });

  // A server that answers with something other than JSON is still evidence: what
  // it said, as it said it.
  test("keeps a body that is not a JSON object as text", () => {
    const evidence = harnessResponseEvidence(
      504,
      "<html>gateway timeout</html>",
    );

    expect(evidence.status).toBe(504);
    expect(evidence.body).toBeNull();
    expect(evidence.text).toBe("<html>gateway timeout</html>");
  });

  // A participant's server is not trusted to be terse. Evidence is capped so a
  // run cannot write an unbounded body into the record.
  test("truncates a body longer than the evidence cap", () => {
    const evidence = harnessResponseEvidence(
      200,
      JSON.stringify({ padding: "x".repeat(maximumEvidenceLength * 2) }),
    );

    expect(evidence.body).toBeNull();
    expect((evidence.text ?? "").length).toBeLessThan(
      maximumEvidenceLength * 2,
    );
    expect(evidence.text).toContain("truncated");
  });
});

// Judging one check ------------------------------------------------------

describe("judging acceptance of a valid statement", () => {
  test("passes a 201 that names a client", () => {
    const judgement = judgeAcceptance(exchangeWith(201, registered()));

    expect(judgement.outcome).toBe("passed");
    expect(judgement.detail).toContain("stub-abc123");
  });

  // RFC 7591 states 201, and the profile repeats it - but a 200 that registered
  // the client has done the thing that matters, so it is an advisory.
  test("reports a 200 as an advisory", () => {
    const judgement = judgeAcceptance(exchangeWith(200, registered()));

    expect(judgement.outcome).toBe("advisory");
    expect(judgement.detail).toContain("201");
  });

  // Deny by default: a success that names no client has registered nothing that
  // the rest of the run could check.
  test("fails a success that names no client", () => {
    const judgement = judgeAcceptance(
      exchangeWith(201, { client_name: "Probe" }),
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("client_id");
  });

  // The whole profile rests on this one: a server that refuses what Muster
  // vouched for does not implement it, and the report says what it said.
  test("fails a refusal, quoting what the server said", () => {
    const judgement = judgeAcceptance(
      exchangeWith(
        400,
        refusal("invalid_client_metadata", "No https redirect."),
      ),
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("400");
    expect(judgement.detail).toContain("invalid_client_metadata");
    expect(judgement.detail).toContain("No https redirect.");
  });
});

describe("judging a refusal", () => {
  /** What the profile states for a statement that fails validation. */
  const expected = "invalid_software_statement";

  test("passes a refusal naming the error the profile states", () => {
    const judgement = judgeRefusal(
      exchangeWith(400, refusal(expected)),
      expected,
    );

    expect(judgement.outcome).toBe("passed");
    expect(judgement.detail).toContain(expected);
  });

  // The error vocabulary is a SHOULD, so a server that refuses for the right
  // reason under the wrong name has done the thing that matters. Reported, not
  // failed - the run still passes and the badge stands.
  test("reports the wrong error code as an advisory", () => {
    const judgement = judgeRefusal(
      exchangeWith(400, refusal("invalid_request")),
      expected,
    );

    expect(judgement.outcome).toBe("advisory");
    expect(judgement.detail).toContain("invalid_request");
    expect(judgement.detail).toContain(expected);
  });

  test("reports a refusal with no error code as an advisory", () => {
    const judgement = judgeRefusal(exchangeWith(400, {}), expected);

    expect(judgement.outcome).toBe("advisory");
    expect(judgement.detail).toContain("400");
  });

  // The MUST. A server that registers a client from a statement it should have
  // refused is the failure the harness exists to find, and the client it created
  // is named so the reader knows what to go and delete.
  test("fails an acceptance, naming the client it should not have created", () => {
    const judgement = judgeRefusal(exchangeWith(201, registered()), expected);

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("accepted");
    expect(judgement.detail).toContain("stub-abc123");
  });
});

describe("judging metadata fidelity", () => {
  test("passes when every vouched field came back unchanged", () => {
    const judgement = judgeFidelity(vouched, exchangeWith(201, registered()));

    expect(judgement.outcome).toBe("passed");
  });

  // Arrays are compared as sets: a server that returns the same redirect URIs in
  // another order has registered the same client.
  test("ignores the order of a vouched array", () => {
    const judgement = judgeFidelity(
      { ...vouched, redirect_uris: ["https://a/one", "https://a/two"] },
      exchangeWith(
        201,
        registered({ redirect_uris: ["https://a/two", "https://a/one"] }),
      ),
    );

    expect(judgement.outcome).toBe("passed");
  });

  // The failure names both values, so the vendor can act on it without asking
  // which field and what it should have been.
  test("fails a changed field, naming both values", () => {
    const judgement = judgeFidelity(
      vouched,
      exchangeWith(201, registered({ client_name: "Something else" })),
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("client_name");
    expect(judgement.detail).toContain("Something else");
    expect(judgement.detail).toContain(String(vouched["client_name"]));
  });

  // RFC 7591 §3.2.1 requires the registered metadata in the response. A bare
  // response leaves fidelity unshowable, which is a failure rather than a pass.
  test("fails a response that carries only an identifier", () => {
    const judgement = judgeFidelity(
      vouched,
      exchangeWith(201, { client_id: "stub-abc123" }),
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("client_name");
  });

  test("fails when nothing was registered at all", () => {
    const judgement = judgeFidelity(
      vouched,
      exchangeWith(400, refusal("invalid_software_statement")),
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("Nothing was registered");
  });

  // The comparison itself, since the report is built out of it.
  test("names a missing field and a differing one", () => {
    const differences = metadataDifferences(
      { client_name: "Probe", scope: "openid" },
      { scope: "openid launch" },
    );

    expect(differences).toEqual([
      { field: "client_name", vouched: "Probe", registered: null },
      { field: "scope", vouched: "openid", registered: "openid launch" },
    ]);
  });
});

describe("judging statement-only", () => {
  /** The metadata the harness asserts outside the statement, to be ignored. */
  const outside = ["client_name"];

  // The profile permits either: refuse the request, or ignore what is outside
  // the signature. Both are conformant.
  test("passes a refusal of the request", () => {
    const judgement = judgeStatementOnly(
      vouched,
      exchangeWith(400, refusal("invalid_request", "Metadata must be inside.")),
      outside,
    );

    expect(judgement.outcome).toBe("passed");
    expect(judgement.detail).toContain("client_name");
  });

  test("passes an acceptance that ignored what was outside", () => {
    const judgement = judgeStatementOnly(
      vouched,
      exchangeWith(201, registered()),
      outside,
    );

    expect(judgement.outcome).toBe("passed");
    expect(judgement.detail).toContain("ignor");
  });

  // The MUST: the anchor vouches for the metadata, so nothing outside the
  // signature may override it. A server that lets it is registering a client
  // nobody vouched for.
  test("fails an acceptance that honoured what was outside", () => {
    const judgement = judgeStatementOnly(
      vouched,
      exchangeWith(201, registered({ client_name: "Asserted outside" })),
      outside,
    );

    expect(judgement.outcome).toBe("failed");
    expect(judgement.detail).toContain("Asserted outside");
  });
});

// Aggregating the verdict ------------------------------------------------

describe("aggregating the verdict", () => {
  test("passes a run in which every check passed", () => {
    expect(harnessVerdict(everyCheck("passed"))).toBe("passed");
  });

  // A SHOULD does not remove the badge.
  test("passes a run carrying only advisories", () => {
    expect(harnessVerdict(everyCheck("advisory"))).toBe("passed");
  });

  test("fails a run in which any check failed", () => {
    const checks = [
      ...everyCheck("passed").slice(1),
      checkWith("validStatement", "failed"),
    ];

    expect(harnessVerdict(checks)).toBe("failed");
  });

  // Deny by default. A run that did not make one of the profile's checks has not
  // shown the profile is implemented, so it cannot earn the badge.
  test("fails a run that is missing a check", () => {
    expect(
      harnessVerdict(
        everyCheck("passed").filter(
          (check) => check.name !== "replayedStatement",
        ),
      ),
    ).toBe("failed");
  });

  test("fails an empty run", () => {
    expect(harnessVerdict([])).toBe("failed");
  });

  // FR-029's minimum set, and the profile's own table: every one of them is run,
  // and each has wording a vendor can read.
  test("names every check FR-029 requires", () => {
    expect(harnessCheckOrder).toEqual([
      "validStatement",
      "tamperedSignature",
      "expiredStatement",
      "replayedStatement",
      "metadataFidelity",
      "statementOnly",
    ]);
    for (const name of harnessCheckOrder) {
      expect(harnessCheckTitles[name].length).toBeGreaterThan(0);
    }
  });
});

// Cleaning up ------------------------------------------------------------

describe("cleaning up a throwaway client", () => {
  /** A server that returned both of RFC 7592's management members. */
  const manageable = {
    registrationEndpoint: "https://stub.example.org/register",
    registrationClientUri: "https://stub.example.org/register/stub-abc123",
    registrationAccessToken: "rat-secret",
  };

  test("deletes at the address the server named", () => {
    const target = cleanupTarget(manageable);

    expect(target.ok).toBe(true);
    expect(target.ok ? target.url : "").toBe(manageable.registrationClientUri);
    expect(target.ok ? target.accessToken : "").toBe("rat-secret");
  });

  // A server that returns neither is within the profile: the client is reported
  // as left behind, which is a note rather than a failure.
  test("reports a server that named no management address", () => {
    const target = cleanupTarget({
      ...manageable,
      registrationClientUri: undefined,
    });

    expect(target.ok).toBe(false);
    expect(target.ok ? "" : target.reason).toContain("registration_client_uri");
  });

  test("reports a server that returned no management token", () => {
    const target = cleanupTarget({
      ...manageable,
      registrationAccessToken: undefined,
    });

    expect(target.ok).toBe(false);
    expect(target.ok ? "" : target.reason).toContain(
      "registration_access_token",
    );
  });

  // The address comes from the server being tested, so it is not followed off
  // that server's own origin: a registration response is not a licence to make
  // Muster delete something somewhere else.
  test("refuses a management address on another origin", () => {
    const target = cleanupTarget({
      ...manageable,
      registrationClientUri: "https://elsewhere.example.org/register/x",
    });

    expect(target.ok).toBe(false);
    expect(target.ok ? "" : target.reason).toContain("origin");
  });

  test("refuses a management address that is not a URL", () => {
    const target = cleanupTarget({
      ...manageable,
      registrationClientUri: "not a url",
    });

    expect(target.ok).toBe(false);
  });
});

describe("reporting the cleanup", () => {
  // Acceptance scenario 4: the report states what was left behind. When nothing
  // was, it says that too, rather than saying nothing.
  test("says so when there was nothing to clean up", () => {
    expect(describeCleanup([])).toContain("nothing");
  });

  test("names what it deleted", () => {
    const cleanup = describeCleanup([
      { clientId: "stub-1", deleted: true, reason: "" },
      { clientId: "stub-2", deleted: true, reason: "" },
    ]);

    expect(cleanup).toContain("stub-1");
    expect(cleanup).toContain("stub-2");
    expect(cleanup).toContain("Deleted");
  });

  test("names what it left behind, and why", () => {
    const cleanup = describeCleanup([
      { clientId: "stub-1", deleted: true, reason: "" },
      {
        clientId: "stub-2",
        deleted: false,
        reason: "the server returned no registration_client_uri",
      },
    ]);

    expect(cleanup).toContain("Deleted stub-1");
    expect(cleanup).toContain("Left behind stub-2");
    expect(cleanup).toContain("no registration_client_uri");
    expect(cleanup).toContain("by hand");
  });
});
