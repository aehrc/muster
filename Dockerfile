# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Build stage: install the whole workspace and produce both bundles.
# ---------------------------------------------------------------------------
FROM oven/bun:1-debian AS build
WORKDIR /app

# Manifests first, so a source-only change does not invalidate the install layer.
COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY e2e/package.json ./e2e/
RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps

RUN bun run --filter @muster/web build \
    && bun run --filter @muster/server build

# ---------------------------------------------------------------------------
# Bundle check: is the server bundle self-contained?
# ---------------------------------------------------------------------------
# The runtime image ships no node_modules, so anything left external in the bundle
# would resolve to nothing at startup. A separate stage, on Node, deliberately:
# `builtinModules` must come from an implementation that treats only Node's own
# modules as built in. Bun's list adds `undici` and `ws`, which are ordinary npm
# packages - so a bundle that left one of those external would pass a check run
# under Bun and fail at startup.
#
# The runtime stage copies the marker this one writes, which is what makes BuildKit
# run it at all.
FROM node:24-bookworm-slim AS bundlecheck
WORKDIR /check
COPY --from=build /app/apps/server/dist/index.js ./index.js
COPY --from=build /app/scripts/checkBundle.mjs ./checkBundle.mjs
RUN node checkBundle.mjs index.js && touch /checked

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
# Bun rather than Node, because Muster hashes passwords with argon2id and
# `Bun.password` is the only argon2id implementation available without a native
# addon - which the single-file bundle forbids (see `scripts/checkBundle.mjs`).
# The alternatives were a WASM hashing dependency, or scrypt instead of argon2id;
# the constitution names argon2id, and one fewer dependency is worth a runtime that
# the rest of this repository already uses everywhere else.
FROM oven/bun:1-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    MUSTER_WEB_ROOT=/app/web

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./web
# The generated migrations, which the server's migrate command applies as the
# identity that owns the schema. See `packages/db/src/migrations.ts` for why one
# level up from the bundle is where it looks.
COPY --from=build /app/packages/db/drizzle ./drizzle
# Nothing reads this file. It exists so that the bundle check above is part of this
# image's build graph rather than a stage BuildKit is free to skip.
COPY --from=bundlecheck /checked /app/.bundle-checked

# Run unprivileged. The bun image ships a `bun` user at uid 1000.
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["bun", "dist/index.js"]
