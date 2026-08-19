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
# The processes run with bare `bun`: overmind's tmux server is started with
# .overmind.tmux.conf (see the `dev` script in package.json), which copies the
# invoking shell's PATH into the tmux global environment. Without it, tmux
# gives windows after the first a bare system PATH on some setups and bun is
# not found. `web` forces Bun's own runtime with `--bun`, so Vite's
# `node`-shebang bin never needs `node` on PATH.
#
# Author: John Grimes

server: bun --watch apps/server/src/index.ts

web: bun --bun --filter @muster/web dev

register-stub: STUB_PORT=9190 STUB_ISSUER=http://localhost:8090 STUB_JWKS_URL=http://localhost:8090/.well-known/jwks.json STUB_MODE=strict bun run deploy/stubs/registerServer.ts

data-holder-stub: STUB_PORT=9191 STUB_ISSUER=http://localhost:8090 STUB_JWKS_URL=http://localhost:8090/.well-known/jwks.json STUB_TICKET_TYPES=patient-self-access STUB_SCOPES="patient/Patient.rs patient/Observation.rs patient/Condition.rs" STUB_PATIENTS=8003608500314687=charlotte-morris STUB_IHI_SYSTEM=http://ns.electronichealth.net.au/id/hi/ihi/1.0 bun run deploy/stubs/dataHolder.ts

persona-source-stub: STUB_PORT=9192 STUB_IHI_SYSTEM=http://ns.electronichealth.net.au/id/hi/ihi/1.0 bun run deploy/stubs/personaSource.ts
