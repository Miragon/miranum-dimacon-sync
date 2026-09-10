# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
# Build-Zeit-Konfiguration: Vite bakt VITE_* ins Bundle — ein Fly-Secret zur
# Laufzeit kann Auth im Frontend NICHT aktivieren, nur dieses Build-Arg.
ARG VITE_WORKOS_CLIENT_ID=""
ENV VITE_WORKOS_CLIENT_ID=${VITE_WORKOS_CLIENT_ID}
# Optionale AuthKit-Custom-Domain (First-Party-Cookies). Leer = heutiges
# Verhalten (api.workos.com) — ebenfalls nur build-time setzbar.
ARG VITE_WORKOS_API_HOSTNAME=""
ENV VITE_WORKOS_API_HOSTNAME=${VITE_WORKOS_API_HOSTNAME}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
RUN CI=true pnpm prune --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3020
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/dist/client ./dist/client
# Ops-Scripts (Tenant-Anlage via `fly ssh console`) müssen im Image liegen —
# die Mandanten-Anlage hat bewusst keine HTTP-Fläche.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3020/healthz || exit 1
CMD ["pnpm", "exec", "tsx", "src/server/index.ts"]
