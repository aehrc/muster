# Muster image.
#
# One image serves the whole product: the bundled server and the built console,
# behind one public URL. The server ships as one bundled JavaScript file - no
# node_modules in the runtime layer and no native addons, asserted by
# scripts/checkBundle.mjs during the build so a dependency that breaks the
# property fails here rather than in production - and the console ships as the
# static output of `vite build` beside it.
#
# Author: John Grimes

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /build

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY scripts/ scripts/
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/

RUN bun build apps/server/src/index.ts --target=bun --outfile dist/server.js \
    && bun scripts/checkBundle.mjs dist/server.js

# The console is static output: it is served by the server rather than by a
# second container, so nothing in the runtime layer needs a build tool.
RUN bun --filter @muster/web build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

COPY --from=build /build/dist/server.js ./server.js
COPY --from=build /build/packages/db/migrations/ ./migrations/
COPY --from=build /build/apps/web/dist/ ./web/

ENV MUSTER_PORT=8080
EXPOSE 8080
USER bun

ENTRYPOINT ["bun", "run", "/app/server.js"]
