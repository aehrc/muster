# Muster's native dev stack: the server, the console, and the three stub
# servers that make trusted dynamic client registration, the permission ticket
# playground and the persona scenarios demonstrable without a vendor's server.
# Postgres is not started here - it is a prerequisite; see README.
#
# `brew install overmind` (needs tmux, already a dependency), `cp .env.example
# .env`, `bun run dev:setup` once, then `bun run dev`.
#
# Ports match .env.example and are deliberately different from
# deploy/docker-compose.yml's, so that stack (which backs the e2e suite) can
# run at the same time as this one without colliding.
#
# Every line puts bun's own install directory on PATH before running it:
# overmind's tmux windows other than the first do not inherit it on every
# machine (some shell setups reset PATH to a bare system default for a new
# tmux window), while other variables such as BUN_INSTALL and HOME come
# through untouched. `web` also forces Bun's own runtime with `--bun`, so
# Vite's `node`-shebang bin never needs `node` on that same reduced PATH.
#
# Author: John Grimes

server: PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" bun --watch apps/server/src/index.ts

web: PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" bun --bun --filter @muster/web dev

register-stub: PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" STUB_PORT=9190 STUB_ISSUER=http://localhost:8090 STUB_JWKS_URL=http://localhost:8090/.well-known/jwks.json STUB_MODE=strict bun run deploy/stubs/registerServer.ts

data-holder-stub: PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" STUB_PORT=9191 STUB_ISSUER=http://localhost:8090 STUB_JWKS_URL=http://localhost:8090/.well-known/jwks.json STUB_TICKET_TYPES=patient-self-access STUB_SCOPES="patient/Patient.rs patient/Observation.rs patient/Condition.rs" STUB_PATIENTS=8003608500314687=charlotte-morris STUB_IHI_SYSTEM=http://ns.electronichealth.net.au/id/hi/ihi/1.0 bun run deploy/stubs/dataHolder.ts

persona-source-stub: PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH" STUB_PORT=9192 STUB_IHI_SYSTEM=http://ns.electronichealth.net.au/id/hi/ihi/1.0 bun run deploy/stubs/personaSource.ts
