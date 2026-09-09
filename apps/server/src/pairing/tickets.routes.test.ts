/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  errorEnvelopeSchema,
  jwksSchema,
  ticketResponseSchema,
} from "@muster/contracts";
import { vouchingExpiresAt } from "@muster/core";
import { insertPersona, updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import {
  dayFromToday,
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";
import type { PersonaRow } from "@muster/db";

/**
 * Minting a permission ticket in the playground (US8).
 *
 * Minting is a vouching action, so most of this suite is the deny-by-default
 * boundary: an anonymous caller, an unapproved account, a revoked account, a
 * closed event and a persona belonging to another event are each refused, and each
 * is told which condition it failed.
 *
 * Three assertions carry the constitution directly. The compact JWT is answered to
 * the member who minted it and is written nowhere - asserted by scanning every
 * column of every row of every table in the schema for it, rather than by checking
 * the columns somebody remembered. The claims are recorded, because a ticket
 * Muster minted is something Muster said about a persona to a data holder. And the
 * signature verifies against the ticket-purpose key in the published JWKS, which is
 * the only way a data holder can act on the artefact at all.
 */

describeDatabase("the permission ticket routes", () => {
  let server: TestServer;
  let admin: SignedIn;
  let member: SignedIn;

  /** The event the tickets in this suite are minted for. */
  let slug: string;

  /** The persona the tickets in this suite are minted for. */
  let persona: PersonaRow;

  /** The event's first day. */
  const startsOn = dayFromToday(-1);

  /** The event's last day, which caps every ticket the suite mints. */
  const endsOn = dayFromToday(1);

  /** The grace period the seeded event allows beyond its last day. */
  const graceDays = 7;

  /** The IHI the persona is anchored by, as the seeded source asserts it. */
  const ihi = "8003608500314687";

  /** The constraints quickstart scenario 7 mints with. */
  const scopes = ["patient/Patient.rs", "patient/Observation.rs"];

  beforeAll(async () => {
    server = await startTestServer("tickets");
    admin = await arrangeMember(true);
    member = await arrangeMember();
    slug = await arrangeEvent();
    persona = await arrangePersona(slug, ihi);
  });

  afterAll(async () => {
    await server.close();
  });

  // Signs an account up, verifies it, approves it, and signs it in.
  async function arrangeMember(isAdmin = false): Promise<SignedIn> {
    const account = await signUpAndSignIn(
      server,
      `${uniqueName(isAdmin ? "admin" : "member")}@example.org`,
    );
    await updateAccountStatus(server.database.sql, {
      accountId: account.id,
      status: "approved",
      decidedBy: account.id,
      decidedAt: new Date(),
    });
    if (isAdmin) {
      await server.database
        .sql`update account set is_admin = true where id = ${account.id}`;
    }
    return account;
  }

  // Creates an open event with the suite's last day and grace period.
  async function arrangeEvent(): Promise<string> {
    const created = uniqueName("event").replaceAll("_", "-");
    const response = await request(server, "POST", "/api/admin/events", {
      body: {
        slug: created,
        name: "Sparked connectathon",
        startsOn,
        endsOn,
        status: "open",
        capabilityTags: [],
        graceDays,
      },
      cookie: admin.cookie,
    });
    expect(response.status).toBe(201);
    return created;
  }

  // Curates a persona directly, as the admin route does once it has read the
  // source: the source is not the subject of this suite.
  async function arrangePersona(
    eventSlug: string,
    identifier: string,
  ): Promise<PersonaRow> {
    const rows: { id: string }[] = await server.database
      .sql`select id from event where slug = ${eventSlug}`;
    return insertPersona(server.database.sql, {
      eventId: rows[0]?.id ?? "",
      patientId: uniqueName("patient"),
      ihi: identifier,
      display: {
        name: "Charlotte Morris",
        birthDate: "1990-02-15",
        gender: "female",
      },
      sourceUrl: `https://source.example.org/fhir/Patient/${identifier}`,
    });
  }

  // Mints a ticket as whoever is given, defaulting to the approved member.
  const mint = async (
    body: Record<string, unknown> = {},
    as: SignedIn | null = member,
    event: string = slug,
  ): Promise<Response> =>
    request(server, "POST", `/api/events/${event}/tickets`, {
      body: { personaId: persona.id, scopes, ...body },
      ...(as === null ? {} : { cookie: as.cookie }),
    });

  // Looks for a value anywhere in the database: every column of every row of
  // every table in the scratch schema, by casting each row to text.
  const storedAnywhere = async (value: string): Promise<string[]> => {
    const tables: { table_name: string }[] = await server.database
      .sql`select table_name from information_schema.tables
           where table_schema = ${server.database.schema}
             and table_type = 'BASE TABLE'
           order by table_name`;
    const found: string[] = [];
    for (const { table_name: name } of tables) {
      const rows: { hits: number }[] = await server.database.sql.unsafe(
        `select count(*)::int as hits from "${name}" as row where cast(row as text) like $1`,
        [`%${value}%`],
      );
      if ((rows[0]?.hits ?? 0) > 0) {
        found.push(name);
      }
    }
    return found;
  };

  // Minting -----------------------------------------------------------------

  // Acceptance scenario 1: the compact JWT and its decoded claims, with the
  // subject bound by IHI and the constraints as entered.
  test("answers with the compact ticket and its decoded claims", async () => {
    const response = await mint();

    expect(response.status).toBe(201);
    const { jwt, ticket } = await readJson(response, ticketResponseSchema);
    expect(jwt.split(".")).toHaveLength(3);
    expect(ticket.claims.iss).toBe(server.config.publicUrl);
    expect(ticket.claims.ticket_type).toBe("patient-self-access");
    expect(ticket.claims.muster_event).toBe(slug);
    expect(ticket.claims.smart_scopes).toBe(
      "patient/Patient.rs patient/Observation.rs",
    );
    expect(ticket.claims.subject.identifier).toEqual({
      system: server.config.ihiSystem,
      value: ihi,
    });
    expect(ticket.personaId).toBe(persona.id);
    expect(ticket.claims.jti).toBe(ticket.jti);
  });

  // The claims answered are the claims signed: a playground that displayed
  // something other than what it signed would be worse than no playground.
  test("answers claims that are the payload of the ticket it signed", async () => {
    const response = await mint();

    const { jwt, ticket } = await readJson(response, ticketResponseSchema);
    const payload: unknown = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(payload).toEqual({ ...ticket.claims });
  });

  // Acceptance scenario 2 and the profile's first data-holder obligation: the
  // signature verifies against the published key, matched by `kid`, and that key
  // is the ticket-purpose one rather than the statement-purpose one.
  test("signs the ticket with the published ticket-purpose key", async () => {
    const response = await mint();

    const { jwt, ticket } = await readJson(response, ticketResponseSchema);
    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: "ES256",
      kid: ticket.keyId,
      typ: "JWT",
    });

    const published = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );
    const key = published.keys.find(
      (candidate) => candidate.kid === ticket.keyId,
    );
    expect(key?.muster_purpose).toBe("tickets");
    const verified = await jwtVerify(jwt, await importJWK({ ...key }));
    expect(verified.payload).toEqual({ ...ticket.claims });
  });

  // Acceptance scenario 5: the validity cannot exceed the event's end plus its
  // grace period, whatever was asked for.
  test("caps the validity at the event's end plus its grace days", async () => {
    const response = await mint({
      validUntil: `${dayFromToday(365)}T00:00:00.000Z`,
    });

    const { ticket } = await readJson(response, ticketResponseSchema);
    const ceiling = vouchingExpiresAt({ endsOn, graceDays });
    expect(ticket.expiresAt).toBe(ceiling.toISOString());
    expect(ticket.claims.exp).toBe(Math.floor(ceiling.getTime() / 1000));
  });

  // A shorter validity is honoured, because the cap is a ceiling rather than a
  // fixed lifetime.
  test("honours a validity that ends before the ceiling", async () => {
    const validUntil = `${dayFromToday(1)}T09:00:00.000Z`;
    const response = await mint({ validUntil });

    const { ticket } = await readJson(response, ticketResponseSchema);
    expect(ticket.expiresAt).toBe(validUntil);
  });

  // The record ---------------------------------------------------------------

  // The data model's `ticket` table: who minted it, for which persona, under
  // which key, with the claims - and no JWT.
  test("records the mint against the event, the persona and the member", async () => {
    const response = await mint();

    const { ticket } = await readJson(response, ticketResponseSchema);
    const rows: Record<string, unknown>[] = await server.database
      .sql`select * from ticket where jti = ${ticket.jti}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["minted_by"]).toBe(member.id);
    expect(rows[0]?.["persona_id"]).toBe(persona.id);
    expect(rows[0]?.["key_id"]).toBe(ticket.keyId);
    expect(JSON.parse(String(rows[0]?.["claims"]))).toEqual({
      ...ticket.claims,
    });
    // The table has no column for the artefact at all, which is the strongest
    // form the no-stored-credentials rule can take.
    expect(Object.keys(rows[0] ?? {})).not.toContain("jws");
    expect(Object.keys(rows[0] ?? {})).not.toContain("jwt");
  });

  // The constitution: the artefact is displayed once and stored nowhere. Every
  // table is scanned, rather than the two columns somebody thought of.
  test("stores the ticket itself nowhere at all", async () => {
    const response = await mint();

    const { jwt } = await readJson(response, ticketResponseSchema);
    const signature = jwt.split(".")[2] ?? "";
    expect(await storedAnywhere(jwt)).toEqual([]);
    expect(await storedAnywhere(signature)).toEqual([]);
  });

  // Two mints are two records: a `jti` is per ticket, so a data holder can refuse
  // a replay without refusing the member's next ticket.
  test("gives every ticket its own identifier", async () => {
    const first = await readJson(await mint(), ticketResponseSchema);
    const second = await readJson(await mint(), ticketResponseSchema);

    expect(second.ticket.jti).not.toBe(first.ticket.jti);
  });

  // Refusals ----------------------------------------------------------------

  // Acceptance scenario 4: the playground refuses an account that may not act.
  test("refuses an anonymous caller", async () => {
    const response = await mint({}, null);

    expect(response.status).toBe(401);
  });

  test("refuses an account that has not been approved", async () => {
    const pending = await signUpAndSignIn(
      server,
      `${uniqueName("pending")}@example.org`,
    );

    const response = await mint({}, pending);

    expect(response.status).toBe(403);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain("approval");
  });

  test("refuses a revoked account", async () => {
    const revoked = await arrangeMember();
    await updateAccountStatus(server.database.sql, {
      accountId: revoked.id,
      status: "revoked",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });

    const response = await mint({}, revoked);

    expect(response.status).toBe(403);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain("revoked");
  });

  // A closed event mints nothing (FR-011).
  test("refuses a closed event", async () => {
    const closed = await arrangeEvent();
    const closedPersona = await arrangePersona(closed, "8003608833357361");
    const patched = await request(
      server,
      "PATCH",
      `/api/admin/events/${closed}`,
      {
        body: { status: "closed" },
        cookie: admin.cookie,
      },
    );
    expect(patched.status).toBe(200);

    const response = await mint(
      { personaId: closedPersona.id },
      member,
      closed,
    );

    expect(response.status).toBe(409);
  });

  // A persona curated for another event is not this event's test patient.
  test("refuses a persona that belongs to another event", async () => {
    const other = await arrangeEvent();
    const otherPersona = await arrangePersona(other, "8003608000000001");

    const response = await mint({ personaId: otherPersona.id });

    expect(response.status).toBe(422);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain("event");
  });

  test("refuses a persona that does not exist", async () => {
    const response = await mint({
      personaId: "3f8d8b0e-0d64-4d0a-9c62-0c2a1f0f7f11",
    });

    expect(response.status).toBe(404);
  });

  test("refuses an event that does not exist", async () => {
    const response = await mint({}, member, "no-such-event");

    expect(response.status).toBe(404);
  });

  // Constraints are the substance of a ticket, so a request without any is not a
  // request this route can honour.
  test("refuses a ticket with no scope constraint", async () => {
    const response = await mint({ scopes: [] });

    expect(response.status).toBe(400);
  });

  // A validity that has already passed is refused with the reason rather than
  // quietly widened to the ceiling.
  test("refuses a validity that has already passed", async () => {
    const response = await mint({ validUntil: "2020-01-01T00:00:00.000Z" });

    expect(response.status).toBe(422);
  });

  // Only the patient self-access type is in scope, and the request schema is what
  // says so on the wire.
  test("refuses a ticket type outside the profile's vocabulary", async () => {
    const response = await mint({ ticketType: "provider-access" });

    expect(response.status).toBe(400);
  });
});
