# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/clients/clockin/package.json ./packages/clients/clockin/
COPY packages/clients/dimacon/package.json ./packages/clients/dimacon/
COPY packages/clients/lexoffice/package.json ./packages/clients/lexoffice/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN pnpm build
RUN CI=true pnpm prune --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3020
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/package.json ./package.json
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3020/healthz || exit 1
CMD ["pnpm", "exec", "tsx", "src/server/index.ts"]
