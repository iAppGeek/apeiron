# syntax=docker/dockerfile:1
# Reusable multi-stage pattern for every Apeiron service.
# Build:  docker build -f infra/docker/Dockerfile --build-arg APP=gaia -t apeiron/gaia .
# APP is the folder name under apps/ (package @apeiron/<APP>).
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.33.0
ARG TURBO_VERSION=2.11.7

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ARG TURBO_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
WORKDIR /app

# 1. Prune the monorepo down to the target app and its workspace dependencies.
FROM base AS prune
ARG APP
COPY . .
RUN turbo prune @apeiron/${APP} --docker

# 2. Install (cached on manifests only), build, then produce a prod-only deploy folder.
FROM base AS build
ARG APP
COPY --from=prune /app/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
RUN turbo run build --filter=@apeiron/${APP}
RUN pnpm --filter=@apeiron/${APP} deploy --legacy --prod /deploy

# 3. Minimal runtime image, non-root.
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ ./
USER node
CMD ["node", "dist/index.js"]
