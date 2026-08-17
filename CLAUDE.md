# Muster

Muster is the connectathon participant directory: a persistent registry of
organisations and their systems, per-event enrolment, a pairing workflow with a
trusted dynamic client registration ceiling, live verification of entries,
machine-readable exports, a conformance harness, a shared persona index and a
permission ticket playground.

The user's global `~/.claude/CLAUDE.md` applies in full. What follows is
additional and non-negotiable for this repository.

## Constitution

### Pure core

Domain logic lives in `packages/core` and performs no I/O - no database, no
network, no clock, no environment. Time, randomness and fetching arrive as
arguments. The pairing state machine, statement and ticket claim construction,
check evaluation, persona coverage evaluation, brands bundle construction,
harness verdicts and the rate limiter all belong there and are unit tested
without a database or a server.

Anything that touches I/O lives in `apps/server` or `packages/db`. A rule that
is expressible as a pure function must not be written inside a route handler.

### Deny by default for vouching actions

Muster vouches for other people's clients. Every vouching action - minting a
software statement, running directory-initiated registration, minting a
permission ticket - is refused unless every condition is affirmatively true:

- the account is `approved` with a verified email address, and not `revoked`;
- the account is a member of the organisation owning the client;
- the event is `open` and the pairing belongs to it;
- the artefact's expiry is capped at the event's end plus its grace days.

Absent, unparseable or ambiguous input is a refusal, never a default. Config
that fails to parse fails start-up rather than starting with a guess.

### The SSRF guard is the only path to the network

`apps/server/src/outbound/outboundFetch.ts` is the sole code path that may
reach the network. Nothing else calls `fetch` on a participant-supplied
address. The guard refuses private, loopback, link-local and cloud-metadata
ranges, applies a timeout, and refuses redirects into guarded ranges. A guarded
target is reported to the user as a refusal with its reason, never silently
skipped.

Muster's whole job is fetching addresses that strangers typed in, so this is
the security boundary that matters most.

### No stored client secrets

A client secret returned by a server is shown to the initiating member exactly
once and is never persisted, logged or re-retrievable. The same holds for
passwords (stored only as argon2id hashes via `Bun.password`), session tokens
(stored only as hashes) and minted tickets (displayed, recorded only as
claims). Signing keys are stored encrypted under `MUSTER_MASTER_KEY` with a
version tag on the ciphertext.

No credential is ever written to a log.

### Single instance, in-process scheduler

Scheduled work - liveness and discovery checks, persona coverage - runs on an
in-process interval in one server instance. There is no queue and no worker.
The Helm chart therefore pins `replicas: 1` and says why. Results are persisted
so a restart loses nothing. Do not introduce a second replica without replacing
the scheduler with something that tolerates one.

### Quality gates

All of these pass before any change is considered done:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run lint:duplication   # jscpd, threshold 0
bun run test               # unit + integration
bun run test:coverage      # ≥80% lines and functions, totalled by scripts/checkCoverage.mjs
bun run build && bun run check:bundle
```

The server ships as a single bundled file with no `node_modules` and no native
addons; `scripts/checkBundle.mjs` enforces it and runs inside the Docker build.
A dependency that cannot be bundled does not go in.

Integration suites use `MUSTER_TEST_DATABASE_URL` and skip visibly without it.
CI additionally sets `MUSTER_REQUIRE_DATABASE_TESTS`, which turns a missing URL
into a failure, so the database suites cannot go quiet.

## Layout

```text
packages/core        pure domain logic, no I/O
packages/contracts   Zod schemas shared by server and web
packages/db          Drizzle schema, migrations, repositories
apps/server          Hono server, bundled to one file
apps/web             React + Vite console and public pages
e2e                  Playwright suite against the compose stack
deploy               docker-compose stack and Helm chart
scripts              quality gates and seeding
```

## Conventions specific to Muster

- Two database roles: the owning role applies migrations, a non-owning role
  serves. The serving role has data rights only - no schema `CREATE`, no
  ownership. See `packages/db/src/roles.ts`.
- Migrations are plain `.sql` files applied in filename order by
  `packages/db/src/migrations.ts`, each in its own transaction with its ledger
  row.
- Every public URL derives from `MUSTER_PUBLIC_URL`; nothing hardcodes a host.
- Public reads (event view, JSON API, brands bundle, JWKS, docs, persona
  coverage) work without an account. Contact details never appear in a response
  to an anonymous caller.
- Every mutation returns the updated resource, and every user-visible operation
  reports pending, failed with cause, or succeeded.
- Errors on the wire are `{ error: string, detail?: string }`.
