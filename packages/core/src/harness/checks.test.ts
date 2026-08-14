/**
 * What each conformance check concludes, and what a run's verdict amounts to.
 *
 * The whole of the harness's judgement is here, because the whole of it is pure: a check is a
 * conclusion about one request and one response, and a verdict is a conclusion about the
 * checks. The server presents the statements and does the I/O; nothing about *what the
 * answers mean* needs a network to test (constitution principle II).
 *
 * The cases are written from `contracts/registration-profile.md`. Where the contract says a
 * server MUST do something, a check fails when it is not done; where the contract says SHOULD
 * - the error vocabulary - the check passes and records an advisory, because a badge removed
 * for a SHOULD would be Muster inventing a requirement.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  harnessOutsideMetadata,
  harnessRegistrationFields,
  harnessRunRefusal,
  harnessStatementClaims,
  harnessVerdict,
  judgeHarnessCheck,
  metadataDivergences,
  readRegistrationResponse,
  scrubCredentials,
  tamperCompactJws,
  HARNESS_CHECK_NAMES,
  REDACTED,
} from "./checks.js";

import type {
  HarnessCheckName,
  HarnessExchange,
  HarnessResponseEvidence,
} from "./checks.js";
import type { SoftwareStatementClaims } from "../statements/build.js";

/** The moment every case is judged at. */
const NOW = new Date("2026-09-02T14:31:00.000Z");

/** The metadata Muster vouches for in these cases. */
const VETTED: SoftwareStatementClaims = harnessStatementClaims({
  kind: "valid",
  issuer: "https://muster.test",
  jti: "statement-1",
  eventSlug: "sparked-2026-09",
  eventEndsOn: "2026-09-19",
  graceDays: 7,
  fields: harnessRegistrationFields("https://muster.test"),
  now: NOW,
});

/** A registration response that echoes the vetted metadata, as RFC 7591 §3.2.1 requires. */
function faithfulBody(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    client_id: "stub-abc123",
    client_name: VETTED.client_name,
    redirect_uris: VETTED.redirect_uris,
    grant_types: VETTED.grant_types,
    token_endpoint_auth_method: VETTED.token_endpoint_auth_method,
    scope: VETTED.scope,
    software_id: VETTED.software_id,
    ...overrides,
  });
}

/** An exchange with a response. */
function exchange(
  response: Partial<HarnessResponseEvidence> & { readonly status: number },
): HarnessExchange {
  return {
    request: {
      method: "POST",
      url: "https://stub.example.org/register",
      body: '{"software_statement":"<statement statement-1>"}',
    },
    response: {
      error: null,
      errorDescription: null,
      body: "",
      ...response,
    },
    failure: null,
  };
}

/** An exchange where nothing came back. */
const NO_ANSWER: HarnessExchange = {
  request: {
    method: "POST",
    url: "https://stub.example.org/register",
    body: '{"software_statement":"<statement statement-1>"}',
  },
  response: null,
  failure: "https://stub.example.org/register did not answer in time",
};

/** Judges one check. */
function judge(name: HarnessCheckName, given: HarnessExchange) {
  return judgeHarnessCheck({ name, exchange: given, vetted: VETTED });
}

describe("the check set", () => {
  // FR-029 names five checks at minimum; the sixth enforces the profile's statement-only
  // rule, which is a MUST in the same document.
  it("covers every case FR-029 names, and the statement-only rule", () => {
    expect(HARNESS_CHECK_NAMES).toEqual([
      "valid-statement",
      "tampered-signature",
      "expired-statement",
      "replayed-statement",
      "metadata-fidelity",
      "statement-only",
    ]);
  });
});

describe("harnessRegistrationFields", () => {
  it("vouches for a throwaway client that belongs to Muster", () => {
    const fields = harnessRegistrationFields("https://muster.test");

    expect(fields.redirectUris).toEqual([
      "https://muster.test/harness/callback",
    ]);
    expect(fields.launchUrl).toBe("https://muster.test/harness/launch");
    // Confidential on purpose: it is the path that makes a server return a credential, and
    // the harness has to be shown handling one without keeping it (principle IV).
    expect(fields.confidentiality).toBe("confidential");
    expect(fields.scopes.length).toBeGreaterThan(0);
  });

  it("does not double a trailing slash from the public URL", () => {
    expect(
      harnessRegistrationFields("https://muster.test/").redirectUris,
    ).toEqual(["https://muster.test/harness/callback"]);
  });
});

describe("harnessStatementClaims", () => {
  it("caps a valid statement at the event's vouching expiry", () => {
    // The same rule as a real mint (FR-023): event end plus the event's grace days.
    expect(VETTED.exp).toBe(Date.parse("2026-09-27T00:00:00.000Z") / 1000);
    expect(VETTED.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(VETTED.muster_event).toBe("sparked-2026-09");
  });

  it("mints an expired statement whose window has already closed", () => {
    const claims = harnessStatementClaims({
      kind: "expired",
      issuer: "https://muster.test",
      jti: "statement-2",
      eventSlug: "sparked-2026-09",
      eventEndsOn: "2026-09-19",
      graceDays: 7,
      fields: harnessRegistrationFields("https://muster.test"),
      now: NOW,
    });

    const seconds = Math.floor(NOW.getTime() / 1000);
    expect(claims.exp).toBeLessThan(seconds);
    // Issued before it expired: a statement whose `iat` was after its `exp` would be
    // refusable for a second reason, and the check would no longer be about expiry.
    expect(claims.iat).toBeLessThan(claims.exp);
  });
});

describe("tamperCompactJws", () => {
  it("changes the signature and nothing else", () => {
    const jws = "aGVhZGVy.cGF5bG9hZA.QUJDREVG";

    const tampered = tamperCompactJws(jws);

    const [header, payload, signature] = tampered.split(".");
    expect(header).toBe("aGVhZGVy");
    expect(payload).toBe("cGF5bG9hZA");
    expect(signature).not.toBe("QUJDREVG");
    // Still base64url, so the far end reaches its signature check rather than refusing the
    // token as malformed - which would test the wrong rule.
    expect(signature).toMatch(/^[\w-]+$/);
    expect(signature).toHaveLength(8);
  });

  it("refuses anything that is not a compact JWS", () => {
    expect(() => tamperCompactJws("not.a.jws.at.all")).toThrow(TypeError);
    expect(() => tamperCompactJws("header.payload.")).toThrow(TypeError);
  });
});

describe("scrubCredentials", () => {
  it("redacts a client secret from a JSON body and keeps the rest", () => {
    const body = JSON.stringify({
      client_id: "stub-1",
      client_secret: "s3kr1t-value",
      client_secret_expires_at: 0,
      client_name: "Muster conformance harness",
    });

    const scrubbed = scrubCredentials(body);

    expect(scrubbed).not.toContain("s3kr1t-value");
    expect(scrubbed).toContain(REDACTED);
    // The evidence is still evidence: everything that is not a credential survives.
    expect(scrubbed).toContain("stub-1");
    expect(scrubbed).toContain("Muster conformance harness");
    expect(scrubbed).toContain("client_secret_expires_at");
  });

  it("redacts a registration access token, wherever it is nested", () => {
    const body = JSON.stringify({
      client: { registration_access_token: "rat-value", client_id: "stub-2" },
    });

    const scrubbed = scrubCredentials(body);

    expect(scrubbed).not.toContain("rat-value");
    expect(scrubbed).toContain("stub-2");
  });

  it("redacts a credential from a body that is not JSON at all", () => {
    // A server answering form encoding has failed the profile, and its answer is still
    // evidence - which must not be evidence carrying a live credential.
    const scrubbed = scrubCredentials(
      "client_id=stub-3&client_secret=leaked-value&scope=launch",
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-3");
  });

  it("redacts a credential given as an unquoted member", () => {
    // A server answering YAML, or a log-shaped body, quotes neither the member nor its
    // value. The credential is no less live for it.
    const scrubbed = scrubCredentials(
      "client_id: stub-4\nclient_secret: leaked-value\nscope: launch",
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-4");
    expect(scrubbed).toContain("scope: launch");
    expect(scrubbed).toContain(`client_secret: ${REDACTED}`);
  });

  it("redacts a credential whose value is unquoted in a malformed JSON body", () => {
    const scrubbed = scrubCredentials(
      '{"client_id": "stub-5", "client_secret": leaked-value, "scope": "launch"',
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-5");
  });

  it("redacts a credential carried in an XML element", () => {
    // A server answering XML has failed the profile, and its answer is still evidence.
    const scrubbed = scrubCredentials(
      "<registration><client_id>stub-6</client_id>" +
        "<client_secret>leaked-value</client_secret></registration>",
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-6");
    // The element survives; only its text goes.
    expect(scrubbed).toContain(`<client_secret>${REDACTED}</client_secret>`);
  });

  it("redacts a credential carried in a namespaced XML element", () => {
    const scrubbed = scrubCredentials(
      '<reg:response xmlns:reg="urn:example">' +
        "<reg:registration_access_token>rat-value</reg:registration_access_token>" +
        "</reg:response>",
    );

    expect(scrubbed).not.toContain("rat-value");
    expect(scrubbed).toContain("urn:example");
  });

  it("redacts a credential carried in an XML attribute, leaving the markup readable", () => {
    const scrubbed = scrubCredentials(
      '<response client_id="stub-7" client_secret="leaked-value"/>',
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-7");
    expect(scrubbed).toContain(`client_secret="${REDACTED}"`);
    // The redaction must not swallow the rest of the markup with the value.
    expect(scrubbed).toEndWith("/>");
  });

  it("redacts a credential quoted the way a JavaScript literal quotes it", () => {
    const scrubbed = scrubCredentials(
      "{ 'client_id': 'stub-8', 'client_secret': 'leaked-value' }",
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("stub-8");
  });

  it("redacts a credential embedded in the text of a JSON member", () => {
    // Well-formed JSON, but the credential is inside a string rather than a member of its
    // own, which the structural pass cannot see.
    const body = JSON.stringify({
      error: "invalid_client_metadata",
      error_description: "resend it with client_secret=leaked-value",
    });

    const scrubbed = scrubCredentials(body);

    expect(scrubbed).not.toContain("leaked-value");
    expect(scrubbed).toContain("invalid_client_metadata");
    // Redacting must not cost the reader the syntax: a JSON body stays JSON.
    expect(JSON.parse(scrubbed)).toEqual({
      error: "invalid_client_metadata",
      error_description: `resend it with client_secret=${REDACTED}`,
    });
  });

  it("redacts a body that is a bare JSON string carrying a credential", () => {
    const scrubbed = scrubCredentials(
      JSON.stringify("client_secret=leaked-value"),
    );

    expect(scrubbed).not.toContain("leaked-value");
    expect(JSON.parse(scrubbed)).toBe(`client_secret=${REDACTED}`);
  });

  it("leaves a member whose name merely starts with a credential name alone", () => {
    // `client_secret_expires_at` is metadata, not a credential, and a reader needs its value.
    const scrubbed = scrubCredentials(
      "client_id=stub-9&client_secret_expires_at=0&scope=launch",
    );

    expect(scrubbed).toContain("client_secret_expires_at=0");
    expect(scrubbed).not.toContain(REDACTED);
  });

  it("leaves prose that names a credential member alone", () => {
    // Naming a member is not carrying its value, and an error a vendor has to read must
    // survive intact.
    const body = "the client_secret member was missing from the response";

    expect(scrubCredentials(body)).toBe(body);
  });

  it("leaves a body with nothing to redact alone", () => {
    const body = JSON.stringify({ error: "invalid_software_statement" });

    expect(scrubCredentials(body)).toBe(body);
  });
});

describe("readRegistrationResponse", () => {
  it("reads the identifier, the credential and the client configuration address", () => {
    const read = readRegistrationResponse(
      JSON.stringify({
        client_id: "stub-4",
        client_secret: "sekrit",
        registration_client_uri: "https://stub.example.org/clients/stub-4",
        registration_access_token: "rat",
      }),
    );

    expect(read.clientId).toBe("stub-4");
    expect(read.clientSecret).toBe("sekrit");
    expect(read.registrationClientUri).toBe(
      "https://stub.example.org/clients/stub-4",
    );
    expect(read.registrationAccessToken).toBe("rat");
  });

  it("reads nothing out of a body that is not a JSON object", () => {
    for (const body of ["", "not json", "[1,2,3]", '"a string"']) {
      const read = readRegistrationResponse(body);
      expect(read.clientId).toBeNull();
      expect(read.metadata.clientName).toBeNull();
    }
  });

  it("treats a member of the wrong type as absent rather than as a value", () => {
    const read = readRegistrationResponse(
      JSON.stringify({ client_id: 7, redirect_uris: "https://one.example" }),
    );

    expect(read.clientId).toBeNull();
    expect(read.metadata.redirectUris).toBeNull();
  });
});

describe("metadataDivergences", () => {
  it("finds nothing when the registered metadata is the vetted metadata", () => {
    const registered = readRegistrationResponse(faithfulBody()).metadata;

    expect(metadataDivergences(VETTED, registered)).toEqual([]);
  });

  it("ignores order for the list-valued fields", () => {
    const registered = readRegistrationResponse(
      faithfulBody({
        grant_types: VETTED.grant_types.toReversed(),
        scope: VETTED.scope.split(" ").toReversed().join(" "),
      }),
    ).metadata;

    // A server is entitled to store a set in whatever order it likes; a flag whose two
    // values are the same values would teach a reader to ignore the flags that matter.
    expect(metadataDivergences(VETTED, registered)).toEqual([]);
  });

  it("names the field, the vouched value and the registered one", () => {
    const registered = readRegistrationResponse(
      faithfulBody({ client_name: "Something the server preferred" }),
    ).metadata;

    expect(metadataDivergences(VETTED, registered)).toEqual([
      {
        field: "client_name",
        vetted: VETTED.client_name,
        registered: "Something the server preferred",
      },
    ]);
  });

  it("finds a redirect URI the server added of its own accord", () => {
    const registered = readRegistrationResponse(
      faithfulBody({
        redirect_uris: [
          ...VETTED.redirect_uris,
          "https://outside.invalid/callback",
        ],
      }),
    ).metadata;

    const found = metadataDivergences(VETTED, registered);
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe("redirect_uris");
    expect(found[0]?.registered).toContain("outside.invalid");
  });

  it("says nothing about a field the response did not echo", () => {
    // Absence is not disagreement. Whether a response that echoes nothing is conformant is
    // the fidelity check's judgement, not this function's.
    const registered = readRegistrationResponse(
      JSON.stringify({ client_id: "stub-5" }),
    ).metadata;

    expect(metadataDivergences(VETTED, registered)).toEqual([]);
  });
});

describe("the valid-statement check", () => {
  it("passes on a 201 that carries a client identifier", () => {
    const check = judge(
      "valid-statement",
      exchange({ status: 201, body: faithfulBody() }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.detail).toContain("stub-abc123");
    expect(check.advisories).toEqual([]);
    // The evidence travels with the outcome (scenario 1).
    expect(check.request.url).toBe("https://stub.example.org/register");
    expect(check.response?.status).toBe(201);
  });

  it("fails when the server refuses a statement Muster vouched for", () => {
    const check = judge(
      "valid-statement",
      exchange({
        status: 400,
        error: "invalid_software_statement",
        errorDescription: "the anchor is not configured",
        body: '{"error":"invalid_software_statement"}',
      }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("400");
    expect(check.detail).toContain("the anchor is not configured");
  });

  it("fails a success status that registered nothing", () => {
    // A 201 with no `client_id` is a server that has not registered anything, and treating
    // it as success would credit it with a client that does not exist.
    const check = judge(
      "valid-statement",
      exchange({ status: 201, body: "{}" }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("client_id");
  });

  it("passes a 200 but says the profile asks for 201", () => {
    const check = judge(
      "valid-statement",
      exchange({ status: 200, body: faithfulBody() }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.advisories.join(" ")).toContain("201");
  });

  it("fails when nothing answered, and says so", () => {
    const check = judge("valid-statement", NO_ANSWER);

    expect(check.outcome).toBe("failed");
    expect(check.response).toBeNull();
    expect(check.detail).toContain("did not answer");
  });
});

describe("the refusal checks", () => {
  const refusalChecks: readonly HarnessCheckName[] = [
    "tampered-signature",
    "expired-statement",
    "replayed-statement",
  ];

  it("passes when the server refuses with the profile's error code", () => {
    for (const name of refusalChecks) {
      const check = judge(
        name,
        exchange({
          status: 400,
          error: "invalid_software_statement",
          body: '{"error":"invalid_software_statement"}',
        }),
      );

      expect(check.outcome).toBe("passed");
      expect(check.advisories).toEqual([]);
      expect(check.detail).toContain("400");
    }
  });

  it("fails when the server registers a client anyway, naming what it accepted", () => {
    const failures: Readonly<Record<string, string>> = {
      "tampered-signature": "signature",
      "expired-statement": "expired",
      "replayed-statement": "already",
    };

    for (const name of refusalChecks) {
      const check = judge(
        name,
        exchange({ status: 201, body: faithfulBody() }),
      );

      expect(check.outcome).toBe("failed");
      // The report names the failing behaviour (scenario 3), not merely the check.
      expect(check.detail).toContain(failures[name] ?? "");
      expect(check.detail).toContain("stub-abc123");
    }
  });

  it("passes but advises when the error code is not the profile's", () => {
    // The profile says servers SHOULD distinguish the error codes. A badge removed for a
    // SHOULD would be Muster inventing a requirement, so this is reported and not failed.
    const check = judge(
      "tampered-signature",
      exchange({
        status: 400,
        error: "invalid_request",
        body: '{"error":"invalid_request"}',
      }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.advisories.join(" ")).toContain("invalid_software_statement");
    expect(check.advisories.join(" ")).toContain("invalid_request");
  });

  it("fails a success status that refused nothing and registered nothing", () => {
    const check = judge(
      "replayed-statement",
      exchange({ status: 200, body: "{}" }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("200");
  });
});

describe("the metadata-fidelity check", () => {
  it("passes when the registered client is what Muster vouched for", () => {
    const check = judge(
      "metadata-fidelity",
      exchange({ status: 201, body: faithfulBody() }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.detail).toContain("vetted metadata");
  });

  it("fails naming every field the server changed", () => {
    const check = judge(
      "metadata-fidelity",
      exchange({
        status: 201,
        body: faithfulBody({
          client_name: "Renamed by the server",
          scope: "patient/*.*",
        }),
      }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("client_name");
    expect(check.detail).toContain("scope");
    expect(check.detail).toContain("Renamed by the server");
  });

  it("fails when nothing was registered, because there is nothing to compare", () => {
    const check = judge(
      "metadata-fidelity",
      exchange({ status: 400, error: "invalid_software_statement" }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("nothing was registered");
  });

  it("fails when the response echoes no metadata at all", () => {
    // RFC 7591 §3.2.1 requires the registered metadata to be returned. Without it, fidelity
    // cannot be established, and a check that passed regardless would be checking nothing.
    const check = judge(
      "metadata-fidelity",
      exchange({ status: 201, body: '{"client_id":"stub-6"}' }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("no client metadata");
  });
});

describe("the statement-only check", () => {
  it("passes when the server refuses metadata asserted outside the statement", () => {
    const check = judge(
      "statement-only",
      exchange({
        status: 400,
        error: "invalid_request",
        body: '{"error":"invalid_request"}',
      }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.detail).toContain("refused");
  });

  it("passes when the server ignores it and registers the vetted metadata", () => {
    // The profile permits either: ignoring and rejecting are both conformant.
    const check = judge(
      "statement-only",
      exchange({ status: 201, body: faithfulBody() }),
    );

    expect(check.outcome).toBe("passed");
    expect(check.detail).toContain("ignored");
  });

  it("fails when the server honours the outside metadata", () => {
    const outside = harnessOutsideMetadata();
    const check = judge(
      "statement-only",
      exchange({
        status: 201,
        body: faithfulBody({
          client_name: outside["client_name"],
          redirect_uris: outside["redirect_uris"],
        }),
      }),
    );

    expect(check.outcome).toBe("failed");
    expect(check.detail).toContain("outside");
    expect(check.detail).toContain("client_name");
  });
});

describe("harnessOutsideMetadata", () => {
  it("contradicts the vetted metadata, so honouring it is detectable", () => {
    const outside = harnessOutsideMetadata();

    expect(Object.keys(outside).length).toBeGreaterThan(0);
    expect(outside["client_name"]).not.toBe(VETTED.client_name);
    expect(outside["redirect_uris"]).not.toEqual([...VETTED.redirect_uris]);
  });
});

describe("harnessVerdict", () => {
  it("passes only when every check passed (FR-030)", () => {
    expect(harnessVerdict([{ outcome: "passed" }, { outcome: "passed" }])).toBe(
      "passed",
    );
  });

  it("fails when any check failed", () => {
    expect(
      harnessVerdict([
        { outcome: "passed" },
        { outcome: "failed" },
        { outcome: "passed" },
      ]),
    ).toBe("failed");
  });

  it("fails a run with no checks in it", () => {
    // A run that checked nothing has proved nothing, and a badge is a claim that something
    // was proved.
    expect(harnessVerdict([])).toBe("failed");
  });
});

describe("harnessRunRefusal", () => {
  /** An approved member who owns a trusted-DCR server in an open event. */
  const permitted = {
    standing: { status: "approved" as const, emailVerifiedAt: NOW },
    ownsServer: true,
    eventStatus: "open" as const,
    eventEndsOn: "2026-09-19",
    graceDays: 7,
    registrationMode: "trustedDcr" as const,
    registrationEndpoint: "https://stub.example.org/register",
    now: NOW,
  };

  it("permits the server's own owner", () => {
    expect(harnessRunRefusal(permitted)).toBeUndefined();
  });

  it("refuses an anonymous caller", () => {
    expect(harnessRunRefusal({ ...permitted, standing: null })).toBe(
      "not_signed_in",
    );
  });

  it("refuses a revoked member before anything else", () => {
    expect(
      harnessRunRefusal({
        ...permitted,
        standing: { status: "revoked", emailVerifiedAt: NOW },
        ownsServer: false,
      }),
    ).toBe("revoked_member");
  });

  it("refuses anybody but the server's owner (FR-029)", () => {
    // The run registers throwaway clients on somebody else's server. That is the owner's to
    // ask for.
    expect(harnessRunRefusal({ ...permitted, ownsServer: false })).toBe(
      "not_the_server_owner",
    );
  });

  it("refuses an event that is not open", () => {
    expect(harnessRunRefusal({ ...permitted, eventStatus: "closed" })).toBe(
      "event_not_open",
    );
  });

  it("refuses a server whose registration mode is not trusted DCR", () => {
    expect(
      harnessRunRefusal({ ...permitted, registrationMode: "manual" }),
    ).toBe("not_trusted_dcr");
    expect(harnessRunRefusal({ ...permitted, registrationMode: "open" })).toBe(
      "not_trusted_dcr",
    );
  });

  it("refuses an entry that declares no registration endpoint", () => {
    expect(
      harnessRunRefusal({ ...permitted, registrationEndpoint: null }),
    ).toBe("no_registration_endpoint");
    expect(
      harnessRunRefusal({ ...permitted, registrationEndpoint: "  " }),
    ).toBe("no_registration_endpoint");
  });

  it("refuses once the event's grace period has run out", () => {
    // A valid statement minted now would already have expired, so the valid-statement check
    // would fail for a reason that is Muster's rather than the vendor's.
    expect(
      harnessRunRefusal({
        ...permitted,
        now: new Date("2026-10-01T00:00:00Z"),
      }),
    ).toBe("vouching_window_closed");
  });
});
