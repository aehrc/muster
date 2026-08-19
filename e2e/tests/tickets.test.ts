import { expect, test } from "@playwright/test";

import { panel, signIn, signUp } from "./support/console.ts";
import {
  admin,
  charlotte,
  dataHolderPublicUrl,
  eventSlug,
  ihiSystem,
  participantAddress,
  personaSourceUrl,
} from "./support/stack.ts";

/**
 * Quickstart scenario 7: minting a permission ticket, and spending it.
 *
 * The playground mints a `patient-self-access` ticket for the curated persona,
 * constrained to two scopes. The claims are then checked three ways: against the
 * constraints, against the key set Muster publishes, and against the event's
 * vouching window. Finally the ticket is presented to the stub data holder as the
 * profile says it should be, and the holder's answer is the proof - the granted
 * scopes are the intersection, and the subject's IHI resolved to one of its own
 * patients.
 *
 * The exchange is posted by the suite rather than by Muster, because that is where
 * it happens: Muster mints, the client presents, the holder decides.
 *
 * @author John Grimes
 */

/** The scopes the ticket is constrained to. */
const constrained = ["patient/Patient.rs", "patient/Observation.rs"];

/** The scope the holder supports but this ticket does not carry. */
const withheld = "patient/Condition.rs";

/** The grant type the profile presents a ticket under. */
const tokenExchange = "urn:ietf:params:oauth:grant-type:token-exchange";

/** The token type a ticket is presented as. */
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";

/** The ticket, minted once and used by the tests that follow. */
let jwt = "";

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
test.describe.configure({ mode: "serial" });

/**
 * Decodes a compact JWS payload.
 *
 * @param token - the compact JWS
 * @returns its claims
 */
const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

test("curates the persona the ticket is for, if it is not there yet", async ({
  page,
}) => {
  // The set is shared, so another file may have curated her already; the mint
  // needs her either way. Curation is idempotent from a member's point of view:
  // a second attempt is refused as a duplicate, which is fine here.
  await signIn(page, admin.email, admin.password);
  await page.goto("/admin/events");
  const event = page
    .getByRole("listitem")
    .filter({ hasText: eventSlug })
    .first();
  await event.getByRole("button", { name: "Personas" }).click();
  await expect(page.getByText(personaSourceUrl)).toBeVisible();

  if ((await page.getByText(charlotte.ihi).count()) === 0) {
    await page.getByLabel("Search the source").fill("Morris");
    await page.getByRole("button", { name: "Search" }).click();
    await page
      .getByRole("listitem")
      .filter({ hasText: charlotte.name })
      .getByRole("button", { name: "Add" })
      .click();
  }
  await expect(page.getByText(charlotte.ihi).first()).toBeVisible();
});

test("mints a ticket constrained to two scopes", async ({ page }) => {
  // Any approved member may mint in the playground, so this is not the admin.
  const member = await signUp(page, "ticketmember");
  await signIn(page, admin.email, admin.password);
  await page.goto("/admin/members");
  await page
    .getByRole("row")
    .filter({ hasText: member.email })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(
    page.getByText(`${member.displayName} is now approved`),
  ).toBeVisible();

  await signIn(page, member.email);
  await page.goto(`/events/${eventSlug}/tickets`);
  const form = panel(page, "What the ticket says");
  await form
    .getByLabel("Persona")
    .selectOption({ label: `${charlotte.name} (${charlotte.ihi})` });
  for (const scope of constrained) {
    await form.getByLabel(scope).check();
  }
  await form.getByRole("button", { name: "Mint the ticket" }).click();

  const shown = panel(page, "The ticket, this once");
  await expect(shown).toBeVisible();
  jwt = ((await shown.locator("code").first().innerText()) ?? "").trim();
  expect(jwt.split(".")).toHaveLength(3);
});

test("carries the claims the constraints asked for", async ({ request }) => {
  const claims = claimsOf(jwt);

  expect(claims["ticket_type"]).toBe("patient-self-access");
  expect(claims["smart_scopes"]).toBe(constrained.join(" "));
  expect(claims["subject"]).toMatchObject({
    identifier: { system: ihiSystem, value: charlotte.ihi },
  });

  // The issuer is the deployment's public URL, and the key that signed it is
  // published there (FR-033).
  const jwks = await request.get("/.well-known/jwks.json");
  expect(jwks.ok()).toBe(true);
  const { keys } = (await jwks.json()) as { keys: { kid: string }[] };
  const header = JSON.parse(
    Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { kid: string; alg: string };
  expect(header.alg).toBe("ES256");
  expect(keys.map((key) => key.kid)).toContain(header.kid);

  // Capped at the event's end plus its grace days, whatever was asked for.
  const event = await request.get(`/api/events/${eventSlug}`);
  const { event: detail } = (await event.json()) as {
    event: { endsOn: string; graceDays: number };
  };
  const latest =
    (Date.parse(`${detail.endsOn}T00:00:00.000Z`) +
      (detail.graceDays + 1) * 24 * 60 * 60 * 1000) /
    1000;
  expect(Number(claims["exp"])).toBeLessThanOrEqual(latest);
});

test("verifies against the published key set", async ({ request }) => {
  const jwks = await request.get("/.well-known/jwks.json");
  const { keys } = (await jwks.json()) as {
    keys: { kid: string; kty: string; crv: string; x: string; y: string }[];
  };
  const header = JSON.parse(
    Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { kid: string };
  const jwk = keys.find((key) => key.kid === header.kid);
  expect(jwk).toBeDefined();

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk?.x ?? "", y: jwk?.y ?? "" },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const [head, payload, signature] = jwt.split(".");
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature ?? "", "base64url"),
    new TextEncoder().encode(`${head ?? ""}.${payload ?? ""}`),
  );

  expect(verified).toBe(true);
});

test("is exchanged at the data holder for the intersection", async ({
  request,
}) => {
  const response = await request.post(`${dataHolderPublicUrl}/token`, {
    form: {
      grant_type: tokenExchange,
      subject_token: jwt,
      subject_token_type: jwtTokenType,
      client_id: "smart-forms-test-1",
      client_secret: "not-checked-by-the-stub",
      // Asking for more than the ticket permits: the holder grants the
      // intersection, not the request.
      scope: [...constrained, withheld].join(" "),
    },
  });

  expect(response.ok()).toBe(true);
  const granted = (await response.json()) as {
    access_token: string;
    scope: string;
    patient: string;
  };
  expect(granted.scope.split(" ").sort()).toEqual([...constrained].sort());
  // The IHI resolved to the holder's own patient, which is the point of binding
  // the subject by identifier rather than by resource reference.
  expect(granted.patient).toBe(charlotte.patientId);

  // And the token is good for something: the patient it authorises reads back.
  const read = await request.get(
    `${dataHolderPublicUrl}/fhir/Patient/${granted.patient}`,
    { headers: { authorization: `Bearer ${granted.access_token}` } },
  );
  expect(read.ok()).toBe(true);
  expect(await read.json()).toMatchObject({
    resourceType: "Patient",
    identifier: [{ system: ihiSystem, value: charlotte.ihi }],
  });
});
