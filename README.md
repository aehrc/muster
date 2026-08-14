# Muster

A connectathon participant directory. It replaces the spreadsheet everyone
copies from: who is bringing which system to which event, what those systems
can do, whether they are actually reachable, and what happened when two of them
tried to talk to each other.

Organisations and their systems persist across events; enrolment is per event.
Everything a reader might want is public - the event view, the JSON API, the
brands bundle, the persona coverage grid, the signing keys, the profile
documentation - and contact details are not: those are visible only to a
signed-in approved member.

## What it does

- **A directory.** Organisations describe their systems once; each event they
  bring one to, they enrol it and confirm the details are still current.
- **A pairing tracker.** An app owner asks a server owner to register a client;
  the server owner answers with the identifier they issued, or declines with a
  reason. Both sides read the same timeline.
- **Trusted dynamic client registration.** A server that opts in publishes a
  registration endpoint; Muster signs the vetted metadata into a software
  statement and presents it, and the pairing completes with nobody on the
  server side doing anything. The statement vouches no further than the event's
  end plus its grace period.
- **A conformance harness.** A vendor can prove their endpoint implements the
  registration profile before event day - including that it refuses a tampered,
  expired or replayed statement - and a fully passing run puts a "DCR verified"
  badge on their entry.
- **Live verification.** Every enrolled server's SMART configuration and
  CapabilityStatement are fetched on a schedule. An entry that has stopped being
  true is flagged: unreachable, or drifting from what it declared, or on an
  address the outbound guard refused to fetch at all.
- **Machine-readable exports.** The event's systems as JSON, and its servers as
  a FHIR brands bundle.
- **Shared personas.** Test patients curated from the event's source FHIR
  server, with a public grid of which participating servers hold each one.
- **A permission ticket playground.** Mint a SMART permission ticket bound to a
  persona's IHI and present it to a data holder that accepts one.

The specification bundle is in `.local/specs/001-participant-directory/`, and
the two vendor-facing contracts are in `contracts/`.

## Layout

```
apps/server     the HTTP server: routes, scheduler, keys, mail, outbound guard
apps/web        the console (Vite, React, TypeScript)
packages/core   the pure domain: state machines, claims, check and coverage rules
packages/contracts  the wire shapes, as Zod schemas
packages/db     schema, migrations, repositories, the two-identity bootstrap
deploy/         the compose stack, the stubs, and the Helm chart
e2e/            the Playwright suite: quickstart scenarios 1 to 7
```

`packages/core` does no I/O at all - no network, no database, no filesystem, no
direct reads of the clock or of randomness. That is what makes the
security-critical decisions (what goes into a signed statement, what a
conformance verdict means) auditable without standing up infrastructure.

## Getting started

Prerequisites: [Bun](https://bun.sh) and Docker.

```sh
bun install
bun run stack:up      # builds the image, brings up Postgres, Muster and the two stubs
bun run stack:seed    # a track admin, and an open event with capability tags
```

Muster is then at <http://localhost:3000>. Sign in as `admin@muster.test` with
the password `correct horse battery staple` - the seed's defaults, which
`MUSTER_SEED_ADMIN_EMAIL` and `MUSTER_SEED_ADMIN_PASSWORD` override.

The stack sends no mail: with no `MUSTER_SMTP_URL` the console transport writes
every message to the server's log instead, which is where a verification link is
read from.

```sh
bun run stack:logs    # follow it
bun run stack:down    # stop, keeping the database
bun run stack:reset   # stop, discard the database, and bring it back up empty
```

### Working on it

```sh
bun run dev           # the server on :3000 and Vite on :5173, both watching
```

Both read `.env.local`, which Git ignores; `.env.example` documents every
variable and which file it belongs in. `bun run dev` needs a database - the
compose stack's is fine - and it applies no migrations of its own:

```sh
bun run migrate       # applies the migrations and grants the serving role
bun run seed          # the admin and the open event, against MUSTER_DATABASE_URL
```

## The stack

`deploy/docker-compose.yml` brings up five things.

| Service       | What it is                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| `postgres`    | The database. Its init script creates the non-owning serving role.              |
| `migrate`     | Applies the migrations as the owning identity, then exits.                      |
| `muster`      | The server, with the console built into the image.                              |
| `stub-server` | A reference implementation of the registration profile, with breakable rules.   |
| `stub-holder` | A reference data holder for the ticket profile, and the stack's persona source. |

The two stubs serve TLS with the throwaway certificate in `deploy/stubs/tls`,
because a server entry's FHIR base URL and registration endpoint must be
`https`. Muster trusts it through `NODE_EXTRA_CA_CERTS` and reaches the stubs'
private compose addresses only because `MUSTER_OUTBOUND_ALLOWED_HOSTS` names
them: both halves are needed, and neither is a default.

### Moving the ports

Nothing in the stack has a hard-coded address. Export the ports and both
`docker compose` and the end-to-end suite follow:

```sh
export MUSTER_PORT=3100 POSTGRES_PORT=55534 STUB_SERVER_PORT=9443 STUB_HOLDER_PORT=9444
bun run stack:reset && bun run stack:seed && bun run test:e2e
```

CI runs the stack on non-default ports for exactly this reason: an address left
behind anywhere fails there.

## The gates

```sh
bun run format:check      # Prettier
bun run lint              # ESLint
bun run typecheck         # tsc --build --force, every project including e2e/
bun run lint:duplication  # jscpd, threshold 0
bun run test              # unit and integration (`bun test` runs the same suites)
bun run test:coverage     # the same, with lcov totals checked at 80% lines and functions
bun run build             # both bundles
bun run check:bundle      # the server bundle is one self-contained file
bun run check:chart       # the rendered Helm chart's invariants
docker build -t muster:dev .
```

The integration suites **skip themselves** when `MUSTER_TEST_DATABASE_URL` is
unset, and a run that skipped them reports success having touched no database.
`.env.test` sets it locally; CI sets it and fails the workflow on a non-zero
skip count. Check for a skip count if a change to the data layer passes
suspiciously easily.

### End to end

```sh
bun run stack:reset && bun run stack:seed && bun run test:e2e
```

Seven specs (`e2e/tests/*.e2e.ts` - the suffix keeps them out of Bun's test
discovery, which would otherwise collect them and abort), one per quickstart
scenario, run in order by one worker against the compose stack. It is a single journey rather than seven independent tests -
an account is approved before it owns an organisation, a system is enrolled
before it can be paired with, a persona exists before a ticket can name it - so
it needs a database with nothing in it, which is what `stack:reset` provides.

Two of the scenarios drive `docker compose` themselves: scenario 5 stops a
server to watch the directory notice, and scenario 4 recreates the registration
stub with its signature validation turned off so the harness can be shown to
fail. Verification links are read from the log the console mail transport writes
to.

## Container image

```sh
docker build -t muster:dev .
docker run --rm -p 3000:3000 \
  -e MUSTER_PUBLIC_URL=http://localhost:3000 \
  -e MUSTER_DATABASE_URL=postgres://muster_app:muster_app@host.docker.internal:55434/muster \
  -e MUSTER_MASTER_KEY=0123456789abcdef0123456789abcdef \
  -e MUSTER_IHI_SYSTEM=http://ns.electronichealth.net.au/id/hi/ihi/1.0 \
  muster:dev
```

The server bundles to a single file with no native addons, which the build
enforces as a stage of its own: `scripts/checkBundle.mjs` runs under Node inside
the image, so a dependency that cannot be bundled fails the build rather than
the deployment.

The image also carries the `migrate`, `seed` and `rotate-key` commands:

```sh
docker run --rm muster:dev bun dist/index.js migrate
```

## Kubernetes

`deploy/helm/muster` deploys it. `deploy/helm/muster/README.md` documents every
value; `deploy/helm/example-values.yaml` is a working configuration.

```sh
helm lint deploy/helm/muster -f deploy/helm/example-values.yaml
helm template muster deploy/helm/muster -f deploy/helm/example-values.yaml
helm install muster deploy/helm/muster -f deploy/helm/example-values.yaml
```

Replicas are pinned to 1 and the strategy is `Recreate`, because the
verification and coverage schedulers run on an in-process interval inside the
server: a second pod - or a surge during a rollout - is a second scheduler over
the same enrolments. Every credential is an `existingSecret` reference, the
identity that owns the schema reaches the migration Job and nothing else, and
the chart refuses to render without `MUSTER_PUBLIC_URL`. `bun run check:chart`
asserts all of that against the rendered output.

The serving role must exist before the first install: the migration grants it
its access but cannot create it. See "Before the first install" in the chart's
README.

## Configuration

`.env.example` is the list. The ones without a sensible default are
`MUSTER_PUBLIC_URL` (every public URL Muster emits derives from it, including
the issuer of every software statement and permission ticket),
`MUSTER_DATABASE_URL`, `MUSTER_MASTER_KEY` (it encrypts signing private keys at
rest) and `MUSTER_IHI_SYSTEM`. Nothing is guessed at: a configuration that
cannot be resolved stops startup with a message naming the variable.

## The contracts

- `contracts/registration-profile.md` - what a server implements to accept a
  Muster-vouched dynamic client registration. Served at `/docs/registration-profile`.
- `contracts/ticket-profile.md` - what a data holder does with a presented
  permission ticket. Served at `/docs/ticket-profile`.

Both are vendor-facing. Breaking either requires coordination with the Signet
repository's trusted-DCR work.

## Copyright

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
(CSIRO) ABN 41 687 119 230.

All rights reserved. Muster is not open source and carries no licence to use,
copy, modify or distribute it.
