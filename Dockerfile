# Multi-stage build. The builder stage takes full dependencies and compiles
# TypeScript; the deps stage resolves production dependencies only; the runtime
# stage ships neither a compiler nor a lockfile.
#
# node:22-bookworm-slim (Debian, glibc) is deliberate. wative-core derives
# passwords through @node-rs/argon2, whose linux-x64-gnu / linux-arm64-gnu
# prebuilds load on glibc without a C toolchain. Startup refuses to continue
# unless that native backend is the one actually selected, so a base image that
# silently falls back to a slower backend is a boot failure, not a slow build.
FROM node:22-bookworm-slim AS builder

# Present for any transitive dependency without a prebuild for this platform.
# Discarded with the stage, so it costs nothing in the shipped image.
# Corepack is refreshed before it is enabled: the version bundled with a base
# image ages, and an older corepack rejects a recently published pnpm on
# signature verification ("cannot find matching keyid"). The prompt is disabled
# because a build has no tty to answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g corepack@latest \
    && corepack enable pnpm

WORKDIR /app

# pnpm-workspace.yaml carries allowBuilds and minimumReleaseAgeExclude, so the
# install resolves the same way it does locally rather than re-prompting.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ ./src/
RUN pnpm run build

# ──────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# curl is not needed by the healthcheck below, which uses node's own fetch.
# It is installed so the container is debuggable from a shell during an
# incident without needing network access to install anything.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json

# errors.json ships with the code so an upgrade cannot leave a stale copy
# behind. tenants.json is deliberately absent: it holds per-tenant secret
# hashes and is mounted read-only at runtime, never baked into an image.
COPY config/errors.json ./config/errors.json

# Written by the service on first boot: it mkdirs the state directory and
# chmods it to 0700, which requires ownership. Creating them here as `node`
# means a named volume inherits the right owner. A BIND mount does not - the
# host directory keeps its own ownership, so it must be chown 1000:1000
# before first start or boot fails with EPERM. See docs/DEPLOY.md.
RUN mkdir -p /var/lib/tee-docker/state /var/lib/tee-docker/data \
    && chown -R node:node /app /var/lib/tee-docker

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    TEE_CONFIG_DIR=/app/config \
    TEE_STATE_DIR=/var/lib/tee-docker/state \
    WATIVE_DATA_ROOT=/var/lib/tee-docker/data

EXPOSE 3000

# Checks the parsed body, not just the status code. start-period is generous
# because boot runs one real Argon2 derivation before the port opens; a probe
# firing during that window would report a false failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
