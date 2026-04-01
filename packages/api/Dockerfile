# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: Build
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

# Copy root workspace manifests and lock file first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./

# Copy every package manifest so npm can resolve workspace topology
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/api/package.json    ./packages/api/package.json
COPY packages/job/package.json    ./packages/job/package.json
COPY packages/web/package.json    ./packages/web/package.json

# Install all deps (devDependencies are required for tsc)
RUN npm ci

# Copy TypeScript source
COPY packages/shared ./packages/shared
COPY packages/api    ./packages/api

# Build shared first (api depends on @haraka/shared)
RUN npm -w packages/shared run build
RUN npm -w packages/api    run build

# ============================================================
# Stage 2: Production
# ============================================================
FROM node:22-slim AS production

ENV NODE_ENV=production
WORKDIR /app

# Copy root workspace manifests
COPY package.json package-lock.json tsconfig.base.json ./

# Copy every package manifest (npm needs these to wire up workspaces)
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/api/package.json    ./packages/api/package.json
COPY packages/job/package.json    ./packages/job/package.json
COPY packages/web/package.json    ./packages/web/package.json

# Install production deps only.
# npm will create the workspace symlink node_modules/@haraka/shared ->
# packages/shared automatically because it is listed in workspaces[].
RUN npm ci --omit=dev

# Copy compiled output from builder.
# The symlink at node_modules/@haraka/shared points into packages/shared,
# so copying the dist directory here is all that is needed.
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/api/dist    ./packages/api/dist

# Use a non-root user for security
RUN groupadd --system --gid 1001 nodejs && \
    useradd  --system --uid 1001 --gid nodejs appuser && \
    chown -R appuser:nodejs /app

USER appuser

EXPOSE 8080

CMD ["node", "packages/api/dist/index.js"]
