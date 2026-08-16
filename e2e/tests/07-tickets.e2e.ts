/**
 * Quickstart scenario 7: minting a permission ticket and spending it.
 *
 * Three claims, and none of them can be made from the console alone.
 *
 * The ticket's signature is verified against the published JWKS with an independent JOSE
 * implementation, because "Muster says it signed this" is not verification.
 *
 * Its validity is capped at the event's end plus its grace period, so it is compared against
 * that date rather than merely being in the future.
 *
 * And it is presented to the stub data holder by token exchange, which is the only thing that
 * shows the granted scopes are an intersection: the request asks for three, the ticket permits
 * two, and what comes back is two. The holder resolves the subject's IHI to its own patient,
 * which is the whole reason a ticket binds by IHI rather than by an identifier local to one
 * server.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { pageAs } from "../support/journeys.js";
import { HOLDER_CLIENT, PERSONA, SESSIONS, URLS } from "../support/stack.js";

import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { JSONWebKeySet } from "jose";

/** The two scopes the ticket is constrained to, per the quickstart. */
const TICKET_SCOPES = ["patient/Patient.rs", "patient/Observation.rs"];

/** A third scope the presenter asks for and the ticket does not permit. */
const EXTRA_SCOPE = "patient/Condition.rs";

/** RFC 8693's token exchange grant, which is how a ticket is presented. */
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

/** The last instant a ticket for this event may be valid until: end plus seven days' grace. */
const VALIDITY_CAP_SECONDS = Date.parse("2026-09-27T00:00:00Z") / 1000;

/**
 * Presents a ticket to the stub data holder, as the ticket profile says a client does.
 *
 * @param request - Playwright's request context, which trusts the stub's certificate.
 * @param ticket - The compact JWS.
 * @param scope - What the presenter is asking for, which the holder narrows.
 * @returns The holder's answer.
 */
async function presentTicket(
  request: APIRequestContext,
  ticket: string,
  scope: string,
): Promise<APIResponse> {
  return await request.post(`${URLS.dataHolder}/token`, {
    headers: {
      // A permission ticket releases a patient's record, so the profile refuses public
      // presenters: the client authenticates.
      authorization: `Basic ${Buffer.from(`${HOLDER_CLIENT.id}:${HOLDER_CLIENT.secret}`).toString("base64")}`,
    },
    form: {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: ticket,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      scope,
    },
  });
}

test("Scenario 7: minting a permission ticket and exchanging it", async ({
  browser,
  request,
}) => {
  const member = await pageAs(browser, SESSIONS.appOwner);
  let ticket = "";
  let claims: Record<string, unknown> = {};

  await test.step("an approved member mints a ticket for the persona", async () => {
    await member.goto("/tickets");
    await member
      .getByLabel("Persona")
      .selectOption({ label: `${PERSONA.name} - IHI ${PERSONA.ihi}` });
    // The two the quickstart names are the two the form offers by default; the rest stay
    // unticked, which is what makes the intersection below visible.
    for (const scope of TICKET_SCOPES) {
      await expect(member.getByLabel(scope)).toBeChecked();
    }
    await member.getByRole("button", { name: "Mint ticket" }).click();

    ticket = await member.locator("#permission-ticket").inputValue();
    expect(ticket.split(".")).toHaveLength(3);
    claims = JSON.parse(
      await member.getByTestId("ticket-claims").innerText(),
    ) as Record<string, unknown>;
  });

  // Not `async`: every assertion here is synchronous, which is what `test.step` allows.
  await test.step("the decoded claims match the constraints", () => {
    expect(claims["smart_scopes"]).toBe(TICKET_SCOPES.join(" "));
    expect(JSON.stringify(claims["subject"])).toContain(PERSONA.ihi);
    expect(JSON.stringify(claims["subject"])).toContain(PERSONA.ihiSystem);
    const expiry = claims["exp"] as number;
    expect(expiry).toBeGreaterThan(Date.now() / 1000);
    expect(expiry).toBeLessThanOrEqual(VALIDITY_CAP_SECONDS);
  });

  await test.step("the signature verifies against the published JWKS", async () => {
    const response = await request.get("/.well-known/jwks.json");
    expect(response.ok()).toBe(true);
    const keys = createLocalJWKSet((await response.json()) as JSONWebKeySet);
    const verified = await jwtVerify(ticket, keys);
    expect(verified.payload["jti"]).toBe(claims["jti"]);
  });

  await test.step("the data holder grants the intersection and resolves the IHI", async () => {
    // One more scope than the ticket permits, deliberately.
    const exchanged = await presentTicket(
      request,
      ticket,
      [...TICKET_SCOPES, EXTRA_SCOPE].join(" "),
    );
    expect(exchanged.status()).toBe(200);
    const granted = (await exchanged.json()) as {
      scope: string;
      patient: string;
      access_token: string;
    };
    // What was asked for, narrowed by what the ticket permits: the third scope is gone.
    expect(granted.scope.split(" ").toSorted()).toEqual(
      TICKET_SCOPES.toSorted(),
    );
    expect(granted.patient).toBe("charlotte-morris");
    expect(granted.access_token.length).toBeGreaterThan(0);
  });

  await test.step("presenting it a second time is refused", async () => {
    // Single use, by `jti`. Not in the quickstart's words, but it is the property that makes
    // a ticket a ticket rather than a bearer credential.
    const replay = await presentTicket(
      request,
      ticket,
      TICKET_SCOPES.join(" "),
    );
    expect(replay.status()).toBe(400);
  });

  await member.context().close();
});
