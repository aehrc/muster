<!-- Author: John Grimes -->

# Muster

Muster is a connectathon participant directory: a persistent registry of
organisations and their systems, per-event enrolment, a structured pairing
workflow with a trusted dynamic client registration ceiling, live
verification of server entries, machine-readable exports, a conformance
harness, shared personas and a permission ticket playground. The active
specification bundle lives in `.local/specs/001-participant-directory/`.

## Constitution

### Core principles

#### I. Test-first (non-negotiable)

No implementation code before a failing test. Every behaviour lands as
failing tests, a minimal implementation, then passing tests. Unit tests
carry the coverage burden; integration tests are few and sit at system
boundaries (HTTP, Postgres, SMTP, Playwright end to end). Work whose
implementation precedes its tests violates this principle.

#### II. Pure core

All domain logic - the pairing state machine, statement and ticket claim
construction, check and drift evaluation, persona coverage, harness
verdicts, rate limiting - lives in `packages/core` and MUST be free of
I/O: no network, no database, no filesystem, and no direct reads of the
clock or randomness (inject them). Side effects belong only in
`apps/server` and `packages/db`.

Rationale: the security-critical logic (what goes into a signed statement
or ticket, what a conformance verdict means) must be auditable and
exhaustively unit-testable without standing up infrastructure.

#### III. One guarded path to the network

Every outbound request to a participant-supplied address MUST go through
the single SSRF-guarded fetch in `apps/server`. The guard MUST refuse
private, loopback and internal address ranges, apply timeouts, and refuse
redirects into guarded ranges. No other module may fetch a URL that
originated from participant input.

#### IV. Secrets are never persisted

Client secrets returned by registration are shown to the initiating
member exactly once and MUST NOT be stored. Passwords are stored only as
argon2id hashes. Signing private keys are encrypted at rest under
`MUSTER_MASTER_KEY`. No credential - password, client secret, ticket,
software statement - may be written to logs.

#### V. Public by default, contacts gated

Every read surface (event view, JSON API, brands bundle, profile
documentation, JWKS, persona coverage) MUST be readable without an
account. Organisation and member contact details MUST NOT be readable by
anyone other than signed-in approved members. A new read surface defaults
to public and MUST be checked for contact-detail leakage before merge.

#### VI. Verifiability outlives key rotation

Rotating a signing key MUST NOT invalidate outstanding statements or
tickets: every signed artefact carries a key identifier, and superseded
public keys remain published until everything signed with them has
expired.

#### VII. Vouching is deny by default

A Muster signature is an assertion that a participant is who they say they
are, so every action that produces one - minting a software statement,
running a directory-initiated registration, minting a permission ticket -
MUST be refused unless each of its preconditions is affirmatively
established: a signed-in member whose account is approved and not revoked,
acting for the organisation that owns the system, against an open event in
which the target is enrolled. An absent, ambiguous or unevaluable
precondition is a refusal, never a permission, and the refusal MUST name
which precondition failed. A new vouching action inherits the refusal and
MUST state its own checks explicitly rather than relying on a caller
having made them.

### Additional constraints

- One deployment, one admin group. No multi-tenancy machinery (tenant
  scoping, row-level security) may be introduced.
- No queues, workers or background services; scheduled work runs on
  in-process intervals inside the single server instance.
- The server MUST bundle to a single file with no native addons.
- Every public URL MUST derive from `MUSTER_PUBLIC_URL`.
- The public JSON API and the web views MUST be fed by the same data; no
  view-only data paths.

### Development workflow

- Features proceed from spec to plan to tasks under
  `.local/specs/<feature>/`; implementation work traces back to a task.
- Quality gates before merge: `bun test` (unit and integration), the
  Playwright end-to-end suite against the docker-compose stack, and lint
  and format checks.
- `contracts/registration-profile.md` and `contracts/ticket-profile.md`
  are vendor-facing contracts; breaking changes to either require
  coordination with the Signet feature `002-trusted-dcr-tickets`.
