# syntax=docker/dockerfile:1
# Web image for pharos: turbo prune, Vite build, then the static build behind unprivileged nginx.
# Build:  docker build -f infra/docker/web.Dockerfile -t apeiron/pharos .
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.33.0
ARG TURBO_VERSION=2.11.7
# Latest stable (even-numbered) nginx minor. 1.31 is the mainline branch.
ARG NGINX_VERSION=1.30

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ARG TURBO_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
WORKDIR /app

# 1. Prune the monorepo down to pharos and its workspace dependencies.
FROM base AS prune
COPY . .
RUN turbo prune @apeiron/pharos --docker

# 2. Install (cached on manifests only) and build the static site.
FROM base AS build
COPY --from=prune /app/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
# 1 builds window.__apeironTest into the page (the resilience profile's pharos-e2e); empty for every normal image.
ARG VITE_TEST_HOOKS=
ENV VITE_TEST_HOOKS=${VITE_TEST_HOOKS}
RUN turbo run build --filter=@apeiron/pharos

# 3. Static files behind nginx, running as the image's non-root user (uid 101).
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine AS runtime
# The image renders every *.template in /etc/nginx/templates into conf.d with envsubst when it starts.
ENV WS_UPSTREAM=antikythera:4000
COPY --chown=101:101 infra/nginx/pharos.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=101:101 /app/apps/pharos/dist /usr/share/nginx/html
EXPOSE 8080
