/**
 * Minting a permission ticket, end to end through the application.
 *
 * The pure rules are exhausted in `packages/core/src/tickets/build.test.ts`. What this suite
 * asserts is everything that is a property of the composition rather than of a function, and
 * four of those properties are the requirement rather than incidental detail.
 *
 * **The signature verifies against the ticket-purpose key in the published JWKS.** Not
 * against a key the suite happens to hold: the artefact is fetched, the JWKS is fetched from
 * the public route an outside vendor would read, the `kid` in the header is looked up in it,
 * and the verification is done with that key. That is the whole of scenario 2, and it is
 * also what proves the two key purposes have not been crossed - a ticket signed with the
 * statements key would verify against *a* published key and would still be wrong.
 *
 * **The compact JWT is not stored.** `data-model.md` says the ticket is displayed at mint
 * time and not stored, and constitution principle IV is why: it is a bearer credential for a
 * patient's record. The assertion is made against every table in the database rather than
 * against the columns somebody thought of, by the same catalogue sweep `dcr.routes.test.ts`
 * uses for a client secret.
 *
 * **The validity is capped, not trusted.** A request asking for a year gets the event's end
 * plus its grace, and the response says so - so the cap is observable from outside the
 * process rather than only in a unit test.
 *
 * **Refusal is the default.** A revoked member, an unapproved one and an anonymous caller
 * get nothing, and a closed event mints nothing for anybody.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides one, so
 * a skip there is a workflow failure.
 *
 * Author: John Grimes
 */

import {
  findActiveSigningKey,
  findStoredValue,
  hasTestDatabase,
  insertPersona,
  listEventTickets,
  makeEvent,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { apiJson, apiRequest } from "../test/api.js";
import {
  createTestStack,
  TEST_IHI_SYSTEM,
  TEST_PUBLIC_URL,
} from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type { MintedTicket } from "@muster/contracts";
import type { EventRow, PersonaRow } from "@muster/db";
import type { JSONWebKeySet } from "jose";

/** The quickstart's persona (scenario 7). */
const CHARLOTTE = {
  patientId: "charlotte-morris",
  name: "Charlotte Morris",
  birthDate: "1985-03-12",
  ihi: "8003608500314687",
} as const;

/** The quickstart's scope constraints. */
const SCOPES = ["patient/Patient.rs", "patient/Observation.rs"] as const;

/** The event's last day and grace, so the cap can be worked out in the assertions. */
const ENDS_ON = "2026-09-19";

/** Days past the last day the vouching still holds. */
const GRACE_DAYS = 7;

/** The instant the cap works out to: the whole of the 26th is covered. */
const CAP_SECONDS = Date.parse("2026-09-27T00:00:00.000Z") / 1000;

describe.skipIf(!hasTestDatabase())("the ticket mint route", () => {
  let stack: TestStack;
  let event: EventRow;
  let closedEvent: EventRow;
  let persona: PersonaRow;
  let otherPersona: PersonaRow;
  let memberCookie: string;
  let adminCookie: string;

  beforeAll(async () => {
    stack = await createTestStack();
    stack.setNow(new Date("2026-09-15T04:00:00.000Z"));

    event = await makeEvent(stack.db, {
      slug: `tickets-${uniqueSuffix()}`,
      status: "open",
      endsOn: ENDS_ON,
      graceDays: GRACE_DAYS,
    });
    closedEvent = await makeEvent(stack.db, {
      slug: `tickets-closed-${uniqueSuffix()}`,
      status: "closed",
      endsOn: ENDS_ON,
      graceDays: GRACE_DAYS,
    });
    persona = await insertPersona(stack.db, {
      eventId: event.id,
      patientId: CHARLOTTE.patientId,
      display: { name: CHARLOTTE.name, birthDate: CHARLOTTE.birthDate },
      ihi: CHARLOTTE.ihi,
      checkedAt: stack.now(),
    });
    // A persona of a different event, so "this persona is not in this event" can be asserted
    // as a refusal rather than as a ticket bound to the wrong subject.
    otherPersona = await insertPersona(stack.db, {
      eventId: closedEvent.id,
      patientId: "mia-banks",
      display: { name: "Mia Banks", birthDate: "1991-07-04" },
      ihi: "8003608333647261",
      checkedAt: stack.now(),
    });

    // No organisation: FR-033 puts minting in the hands of approved *members*, not of an
    // organisation that owns something. A member with no entry in the directory can still
    // exercise the playground, which is the point of it.
    const member = await stack.makeMember({ displayName: "Jo Chen" });
    memberCookie = await stack.signIn(member.email);
    // The clock moved a fortnight past the stack's default, which is past the session the
    // harness signed the admin in with. A fresh one, so the admin routes still answer.
    adminCookie = await stack.signIn(stack.admin.email);
  });

  afterAll(async () => {
    await stack.close();
  });

  /** Asks for a ticket the way the playground does. */
  const mint = async (
    body: Record<string, unknown>,
    expectedStatus = 200,
    cookie = memberCookie,
    slug = event.slug,
  ) =>
    await apiJson<{ ticket: MintedTicket }>(
      stack,
      "POST",
      `/api/events/${slug}/tickets`,
      { cookie, body },
      expectedStatus,
    );

  /**
   * The quickstart's request.
   *
   * A function rather than a constant: the persona is created in `beforeAll`, which runs
   * after this block is evaluated.
   */
  const quickstartBody = () => ({
    personaId: persona.id,
    ticketType: "patient-self-access",
    scopes: [...SCOPES],
    validUntil: null,
  });

  describe("what a mint returns (scenario 1, FR-034)", () => {
    it("returns the compact JWT beside its decoded claims", async () => {
      const { ticket } = await mint({
        ...quickstartBody(),
        personaId: persona.id,
      });

      // Three dot-separated segments: a compact JWS, which is what a member pastes into
      // their client.
      expect(ticket.jwt.split(".")).toHaveLength(3);
      expect(ticket.claims.ticket_type).toBe("patient-self-access");
      expect(ticket.claims.muster_event).toBe(event.slug);
      expect(ticket.personaId).toBe(persona.id);

      // The decoded claims are the claims of the artefact, rather than a second opinion
      // assembled beside it.
      const payload = JSON.parse(
        Buffer.from(ticket.jwt.split(".", 2)[1] ?? "", "base64url").toString(),
      ) as Record<string, unknown>;
      expect(payload).toEqual(ticket.claims as unknown as typeof payload);
    });

    it("binds the subject by the deployment's IHI system and the persona's IHI", async () => {
      const { ticket } = await mint(quickstartBody());
      expect(ticket.claims.subject).toEqual({
        identifier: { system: TEST_IHI_SYSTEM, value: CHARLOTTE.ihi },
      });
    });

    it("states the chosen scope constraints, space separated", async () => {
      const { ticket } = await mint(quickstartBody());
      expect(ticket.claims.smart_scopes).toBe(
        "patient/Patient.rs patient/Observation.rs",
      );
    });

    it("issues from the deployment's public URL", async () => {
      const { ticket } = await mint(quickstartBody());
      expect(ticket.claims.iss).toBe(TEST_PUBLIC_URL);
    });

    it("gives every ticket its own identifier", async () => {
      const first = await mint(quickstartBody());
      const second = await mint(quickstartBody());
      expect(first.ticket.jti).not.toBe(second.ticket.jti);
      expect(first.ticket.jwt).not.toBe(second.ticket.jwt);
    });
  });

  describe("verifying the signature (scenario 2)", () => {
    it("verifies against the ticket-purpose key in the published JWKS", async () => {
      const { ticket } = await mint(quickstartBody());

      // Fetched from the public route, exactly as an outside vendor would.
      const jwks = await apiJson<JSONWebKeySet>(
        stack,
        "GET",
        "/.well-known/jwks.json",
      );
      const verified = await jwtVerify(ticket.jwt, createLocalJWKSet(jwks), {
        issuer: TEST_PUBLIC_URL,
      });
      expect(verified.payload["jti"]).toBe(ticket.jti);
      expect(verified.protectedHeader.alg).toBe("ES256");
      expect(verified.protectedHeader.kid).toBe(ticket.keyId);
    });

    // The two purposes are separate keys on purpose (`packages/core/src/keys/purposes.ts`):
    // a vendor who trusts Muster to vouch for a client registration has not agreed to it
    // releasing a patient's record. A ticket signed with the statements key would verify
    // against the same JWKS and would still be the wrong key, so the `kid` is checked
    // against the ticket-purpose key specifically.
    it("is signed with the tickets key and not with the statements key", async () => {
      const { ticket } = await mint(quickstartBody());
      const tickets = await findActiveSigningKey(stack.db, "tickets");
      const statements = await findActiveSigningKey(stack.db, "statements");

      expect(decodeProtectedHeader(ticket.jwt).kid).toBe(tickets?.kid);
      expect(ticket.keyId).toBe(tickets?.kid ?? "");
      expect(ticket.keyId).not.toBe(statements?.kid ?? "");
    });

    it("records the key that signed it, so a rotation leaves it verifiable", async () => {
      const { ticket } = await mint(quickstartBody());
      const jwks = await apiJson<JSONWebKeySet>(
        stack,
        "GET",
        "/.well-known/jwks.json",
      );
      expect(jwks.keys.map((key) => key.kid)).toContain(ticket.keyId);
    });
  });

  describe("what is recorded, and what is not (principle IV)", () => {
    it("records the mint: who, when, the persona and the constraints", async () => {
      const before = stack.now();
      const { ticket } = await mint(quickstartBody());
      const row = (await listEventTickets(stack.db, event.id)).find(
        (candidate) => candidate.jti === ticket.jti,
      );

      expect(row).toBeDefined();
      expect(row?.eventId).toBe(event.id);
      expect(row?.personaId).toBe(persona.id);
      expect(row?.keyId).toBe(ticket.keyId);
      expect(row?.claims.smart_scopes).toBe(
        "patient/Patient.rs patient/Observation.rs",
      );
      expect(row?.claims.subject.identifier.value).toBe(CHARLOTTE.ihi);
      expect(row?.createdAt.toISOString()).toBe(before.toISOString());
      expect(row?.expiresAt.getTime()).toBe(CAP_SECONDS * 1000);
      // Somebody minted it, and the row says who.
      expect(row?.mintedBy).toBeString();
    });

    // The claim that matters: the artefact is not in the database at all. Asserted against
    // every base table rather than against the columns this file knows about.
    it("does not store the compact JWT anywhere in the database", async () => {
      const { ticket } = await mint(quickstartBody());
      expect(await findStoredValue(stack.db, ticket.jwt)).toEqual([]);
      // Nor the signature on its own, which is the part that makes it usable.
      expect(
        await findStoredValue(stack.db, ticket.jwt.split(".", 3)[2] ?? ""),
      ).toEqual([]);
    });

    // FR-036: no credential may be written to a log, and a ticket is one.
    it("does not write the compact JWT to a log line", async () => {
      const written: string[] = [];
      const record =
        (original: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
          written.push(args.map(String).join(" "));
          original(...args);
        };
      const originals = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
      };
      console.log = record(originals.log);
      console.info = record(originals.info);
      console.warn = record(originals.warn);
      console.error = record(originals.error);
      console.debug = record(originals.debug);

      let minted: MintedTicket;
      try {
        minted = (await mint(quickstartBody())).ticket;
      } finally {
        Object.assign(console, originals);
      }

      expect(written.join("\n")).not.toContain(minted.jwt);
      expect(written.join("\n")).not.toContain(
        minted.jwt.split(".", 3)[2] ?? "",
      );
    });
  });

  describe("the validity cap (FR-033, scenario 5)", () => {
    it("caps a request for a year at the event's end plus its grace", async () => {
      const { ticket } = await mint({
        ...quickstartBody(),
        validUntil: "2027-09-15",
      });
      expect(ticket.claims.exp).toBe(CAP_SECONDS);
      expect(ticket.expiresAt).toBe(new Date(CAP_SECONDS * 1000).toISOString());
    });

    it("expires at the cap when nothing narrower is asked for", async () => {
      const { ticket } = await mint(quickstartBody());
      expect(ticket.claims.exp).toBe(CAP_SECONDS);
    });

    it("honours a validity narrower than the cap", async () => {
      const { ticket } = await mint({
        ...quickstartBody(),
        validUntil: "2026-09-16",
      });
      expect(ticket.claims.exp).toBe(
        Date.parse("2026-09-17T00:00:00.000Z") / 1000,
      );
    });

    it("refuses a validity that has already passed", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), validUntil: "2026-09-01" },
        },
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "validity_in_the_past",
      );
    });
  });

  describe("deny by default (scenario 4)", () => {
    it("refuses an anonymous caller", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        { body: quickstartBody() },
      );
      expect(refused.status).toBe(401);
    });

    it("refuses a revoked member", async () => {
      const revoked = await stack.makeMember({ displayName: "Ex Member" });
      const cookie = await stack.signIn(revoked.email);
      // Through the admin route, so the state is the one a revocation actually leaves.
      const revocation = await apiRequest(
        stack,
        "POST",
        `/api/admin/accounts/${revoked.id}/revoke`,
        { cookie: adminCookie },
      );
      expect(revocation.status).toBe(200);

      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        { cookie, body: quickstartBody() },
      );
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "revoked_member",
      );
    });

    it("refuses an account still awaiting approval", async () => {
      const pending = await stack.makeMember({
        displayName: "Not Yet Approved",
        status: "pending",
      });
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        { cookie: await stack.signIn(pending.email), body: quickstartBody() },
      );
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "awaiting_approval",
      );
    });

    it("mints nothing for a closed event", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${closedEvent.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), personaId: otherPersona.id },
        },
      );
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "event_not_open",
      );
    });

    it("leaves nothing recorded when it refuses", async () => {
      await apiRequest(
        stack,
        "POST",
        `/api/events/${closedEvent.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), personaId: otherPersona.id },
        },
      );
      // Not "one fewer than before": nothing has ever been minted for a closed event, so
      // the record is empty rather than unchanged.
      expect(await listEventTickets(stack.db, closedEvent.id)).toEqual([]);
    });
  });

  describe("what may be asked for", () => {
    it("refuses a persona that belongs to another event", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), personaId: otherPersona.id },
        },
      );
      expect(refused.status).toBe(404);
    });

    it("refuses a persona identifier that names nothing", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        {
          cookie: memberCookie,
          body: {
            ...quickstartBody(),
            personaId: "00000000-0000-4000-8000-000000000000",
          },
        },
      );
      expect(refused.status).toBe(404);
    });

    it("refuses an event that does not exist", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        "/api/events/no-such-event/tickets",
        { cookie: memberCookie, body: quickstartBody() },
      );
      expect(refused.status).toBe(404);
    });

    it("refuses a scope outside the patient compartment", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), scopes: ["system/*.cruds"] },
        },
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "not_a_patient_scope",
      );
    });

    it("refuses a request with no scopes at all", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        { cookie: memberCookie, body: { ...quickstartBody(), scopes: [] } },
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "no_scopes",
      );
    });

    // Refused by the contract rather than by the mint rules, because the contract's enum is
    // the shape declaration the console shares - so an unrecognised type never reaches the
    // point where a claim set could be built from it.
    it("refuses a ticket type nobody has specified", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        {
          cookie: memberCookie,
          body: { ...quickstartBody(), ticketType: "clinician-access" },
        },
      );
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "invalid_request",
      );
    });

    it("refuses a body that is not the shape the route takes", async () => {
      const refused = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/tickets`,
        { cookie: memberCookie, body: { scopes: "patient/Patient.rs" } },
      );
      expect(refused.status).toBe(400);
    });
  });
});
