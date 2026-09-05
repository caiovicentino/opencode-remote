# Relay image (P2-127) — multi-stage, tsc-compiled, non-root, self-probing.
# Build from the monorepo root so the lockfile pins the dependency tree:
#   docker build -f deploy/relay/Dockerfile -t opencode-remote/relay .
#
# Constitutional property kept intact: the relay is a blind router. It
# forwards sealed frames it can neither decrypt nor authenticate, never sees
# plaintext or keys, and this image adds no crypto surface of its own.
#
# Build stage compiles apps/relay with tsc; the runtime stage installs only
# the relay's production dependencies (ws) and ships the compiled dist.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY apps/relay/tsconfig.build.json apps/relay/tsconfig.build.json
COPY packages/protocol/package.json packages/protocol/package.json
# dev deps included: typescript lives in devDependencies until dist is emitted
RUN npm ci --workspace apps/relay --workspace packages/protocol
COPY apps/relay/src apps/relay/src
RUN npm run build --workspace apps/relay

# P2-188: the web bundle the relay serves to phones (RELAY_WEB_DIR). Built
# from the same lockfile; static assets only — the relay itself stays a
# blind router and gains no new runtime dependency.
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/gen-version.mjs scripts/gen-version.mjs
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace apps/web --workspace packages/protocol
COPY packages/protocol packages/protocol
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
COPY apps/web/index.html apps/web/index.html
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY apps/web/tsconfig.json apps/web/tsconfig.json
RUN npm run build --workspace apps/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --workspace apps/relay --workspace packages/protocol \
  && npm cache clean --force
COPY --from=build /app/apps/relay/dist ./apps/relay/dist
# P2-188: serve the phone PWA from the relay itself; validated fail-closed
# at boot (missing dir or missing index.html refuses to start).
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV RELAY_WEB_DIR=/app/apps/web/dist
# ship as a non-root user; the relay needs no writes and no privileged ports
USER node
# RELAY_PORT (default 8787); provider TLS terminates in front and forwards here
EXPOSE 8787
# Liveness probe for the hosted stage: the public /healthz endpoint (counters
# only — no room ids, no per-peer metadata). Uses node's own fetch, so the
# slim image carries no extra packages.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/relay/dist/index.js"]
