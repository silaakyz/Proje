# Production image of the EIP application (docs/canliya-alma.md, docker-compose.prod.yml).
#   target "app"   — the Next.js server only (standalone output), runs as the unprivileged `node` user
#   target "tools" — the full project with dev dependencies: migrations (scripts/db/migrate.mjs),
#                    the app database role (scripts/db/app-role.mjs), demo:seed, connectors:pull
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM deps AS tools
COPY . .
USER node
CMD ["node", "scripts/db/migrate.mjs"]

FROM ${NODE_IMAGE} AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
