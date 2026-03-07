# Pinned 2026-03-07 -- review and update digest periodically
FROM oven/bun:1.2@sha256:a9b88c44e2d2de80aa4e99775c13a1d5d60c5c49e5a2460c5e94bc49bc901e6c AS builder

WORKDIR /app

# Install pnpm
RUN bun install -g pnpm@9.15.4

# Copy workspace config and lockfile first for better layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy all package.json files (workspace structure)
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/protocol/package.json packages/protocol/
COPY packages/test-utils/package.json packages/test-utils/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source code
COPY packages/ packages/
COPY tsconfig.base.json ./

# Build all packages
RUN pnpm -r build

# --- Runtime stage ---
FROM oven/bun:1.2@sha256:a9b88c44e2d2de80aa4e99775c13a1d5d60c5c49e5a2460c5e94bc49bc901e6c

WORKDIR /app

RUN groupadd -r eidolon && useradd -r -g eidolon -d /app -s /bin/false eidolon

# Copy built artifacts and dependencies
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/core/node_modules/ packages/core/node_modules/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/cli/node_modules/ packages/cli/node_modules/
COPY --from=builder /app/packages/protocol/dist/ packages/protocol/dist/
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/protocol/node_modules/ packages/protocol/node_modules/

# Create data and config directories
RUN mkdir -p /app/data /app/config && chown -R eidolon:eidolon /app

USER eidolon

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:18789/health').then(r => { if (!r.ok) process.exit(1) })" || exit 1

ENTRYPOINT ["bun", "run", "packages/cli/dist/index.js", "daemon", "start"]
