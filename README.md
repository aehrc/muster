# Muster

Muster is the connectathon participant directory. It replaces the shared
spreadsheet: a standing registry of organisations and their systems, per-event
enrolment, a structured pairing workflow with a trusted dynamic client
registration ceiling, live verification of what participants have entered,
machine-readable exports, a conformance harness, a shared persona index and a
permission ticket playground.

The public surfaces need no account. The event view, the JSON API, the brands
bundle, the key set, the profile documents and the persona coverage grid are all
readable by anybody; contact details never appear in a response to an anonymous
caller.

## What it does

- **A standing registry.** An organisation describes its systems once - servers,
  clients, or both - and enrols them into each event. Enrolment records a fresh
  confirmation that the details are current.
- **Pairing without an email round trip.** An app owner asks a server owner for a
  client registration, with the field set prefilled from the client's own record.
  Both sides see one state and one history.
- **Trusted dynamic client registration.** Where a server accepts it, Muster
  signs a software statement and registers the client itself, so nobody on the
  server's side has to do anything. Every artefact expires at the event's end plus
  its grace days.
- **Verification rather than assertion.** An in-process scheduler checks each
  enrolled server's discovery and capability documents, flags drift between what
  an entry declares and what the server advertises, and reports an address it
  refused as its own refusal rather than as the server being down.
- **A conformance harness.** A server owner can have the registration profile run
  against their own entry - a valid statement, a tampered one, an expired one, a
  replay, and metadata asserted outside the signature - and the entry carries a
  "DCR verified" badge only while its latest run passed every check.
- **Shared personas.** One source server anchors the event's test patients by
  IHI, and a public grid says which enrolled server holds each of them.
- **Permission tickets.** An approved member can mint a `patient-self-access`
  ticket for a persona, constrained to scopes, and present it to a data holder in
  exchange for an access token.

The vendor-facing contracts are published by the running server at
`/docs/registration-profile` and `/docs/ticket-profile`, and its signing keys at
`/.well-known/jwks.json`.

## Getting started

Requirements: [Bun](https://bun.com) 1.3 or later. The stack needs Docker; the
tests need PostgreSQL 18, either the one in the stack or one of your own.

```sh
bun install
```

### The whole stack

Brings up Muster, PostgreSQL, the stub registration server, the stub data holder
and the stub persona source, then creates the admin account and an open event:

```sh
bun run stack:up
bun run stack:seed
```

The console is then at <http://localhost:8080>, signed in as
`admin@example.org` with the password `muster-admin-password`. Mail is written
to the log rather than sent, so a verification link is read with
`bun run stack:logs`. `bun run stack:down` removes it all, database included.

The stubs are what make the whole product demonstrable without a vendor's
server. They are reached over plain http, which Muster permits only for a host
named in `MUSTER_OUTBOUND_ALLOWLIST` - the same variable that exempts a host from
the address guard - so there is no certificate and no private key in this
repository, and nothing anywhere disables TLS verification. A deployment leaves
that variable unset, and then no private address is reachable and no plaintext
endpoint can be recorded.

### From source

Serving the console from the server needs it built first, and the two directories
default to where the image holds them, so both are given here:

```sh
export MUSTER_PUBLIC_URL=http://localhost:8080
export MUSTER_MASTER_KEY=development-master-key-not-for-deployment
export MUSTER_DATABASE_URL=postgresql://muster:muster@localhost:5432/muster
export MUSTER_MIGRATION_DATABASE_URL=postgresql://muster:muster@localhost:5432/muster
export MUSTER_MIGRATIONS_DIRECTORY=packages/db/migrations
export MUSTER_WEB_DIRECTORY=apps/web/dist

bun run build:web
bun scripts/seed.ts
bun apps/server/src/index.ts
```

The server applies its migrations at start-up and states what it started with,
including whether it found a console to serve. For working on the console
itself, `bun --filter @muster/web dev` serves it from Vite on port 5173 and
proxies the API to 8080.

## The stack

```text
packages/core        pure domain logic, no I/O
packages/contracts   Zod schemas shared by the server and the console
packages/db          Drizzle schema, plain .sql migrations, repositories
apps/server          Hono server, bundled to one file, serves the console too
apps/web             React + Vite console and public pages
e2e                  Playwright suite over quickstart scenarios 1 to 7
deploy               compose stack, the stubs, and the Helm chart
scripts              the quality gates and the seed
```

TypeScript throughout, run and bundled with Bun. The domain logic in
`packages/core` performs no I/O at all: time, randomness and fetching arrive as
arguments, so the pairing state machine, the claim construction, the check
evaluation, the harness verdicts and the rate limiter are all unit tested without
a database or a server.

Two boundaries are worth knowing about before changing anything.
`apps/server/src/outbound/outboundFetch.ts` is the only code path that may reach
the network, because Muster's whole job is fetching addresses that strangers
typed in. And `packages/db/src/roles.ts` splits the database roles: an owning
role applies migrations, and the serving role has data rights only.

The server ships as one bundled JavaScript file with no `node_modules` and no
native addons, with the built console beside it:

```sh
bun run build && bun run check:bundle
docker build -t muster:dev .
```

`deploy/helm/muster` deploys that image as one instance behind one service; see
[its README](deploy/helm/muster/README.md) for the values, and the comment at the
top of its deployment template for why `replicas` is pinned to 1 and not
configurable.

## The gates

All of these pass before a change is done:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run lint:duplication   # jscpd, threshold 0
bun run test               # unit + integration
bun run test:coverage      # >=80% lines and functions
bun run build && bun run check:bundle
```

The integration suites need a database and skip visibly without one:

```sh
export MUSTER_TEST_DATABASE_URL=postgresql://muster:muster@localhost:5432/muster_test
export MUSTER_REQUIRE_DATABASE_TESTS=1   # turns a missing URL into a failure
bun run test
```

The end-to-end suite runs against the stack rather than a dev server:

```sh
bun run stack:up && bun run stack:seed
bunx playwright install chromium
bun run test:e2e
```

CI runs all of it, and additionally builds the image and smoke tests it, lints
and renders the Helm chart on both supported Helm lines, and asserts that the
render pins a single replica. See `.github/workflows/ci.yml`.

## Licence

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
(CSIRO) ABN 41 687 119 230.
