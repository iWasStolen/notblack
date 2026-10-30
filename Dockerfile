# ============================================================
# Memphis unBLACKed — Render.com image
#
# One container, four processes, one public port:
#   scripts/render-gateway.js (PID 1) supervises and routes to
#     · Next.js standalone  (node, :3000)
#     · wisp relay          (bun,   :3001)
#     · chat service        (bun,   :3003)
#
# Build stage uses node (Next's supported build runtime) + bun
# (bun.lock installs, mini-service bundling). Runtime stage is
# node:22-slim + a global bun — node runs Next + the prisma CLI,
# bun runs the two bundled services (chat needs bun:sqlite).
# ============================================================

# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /build

# bun for lockfile installs + service bundling
RUN npm install -g bun

# install root deps first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# install app source first (.dockerignore keeps user data + secrets out)
COPY . .

# mini-services carry their own package.json + bun.lock (their
# node_modules are dockerignored — install fresh)
RUN cd mini-services/wisp-service && bun install --frozen-lockfile \
 && cd ../chat-service && bun install --frozen-lockfile

ENV NEXT_TELEMETRY_DISABLED=1
# prisma generate && next build && static/public into standalone
RUN bun run build

# bundle the mini-services into self-contained JS (node_modules baked in)
RUN mkdir -p mini-services-dist \
 && bun build mini-services/wisp-service/index.ts --target=bun \
      --outfile mini-services-dist/mini-service-wisp-service.js \
 && bun build mini-services/chat-service/index.ts --target=bun \
      --outfile mini-services-dist/mini-service-chat-service.js

# isolated prisma CLI tree for boot-time `db push` (schema create/migrate).
# Keep this version in sync with bun.lock — the resolved prisma version.
RUN mkdir -p /prisma-cli \
 && echo '{"name":"memphis-prisma-cli","private":true}' > /prisma-cli/package.json \
 && cd /prisma-cli && bun add prisma@6.19.2

# ---------------- runtime ----------------
FROM node:22-slim AS runtime
WORKDIR /app

RUN npm install -g bun

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=10000 \
    NEXT_PORT=3000 \
    WISP_PORT=3001 \
    CHAT_PORT=3003 \
    DATABASE_URL=file:/app/db/custom.db

# Next standalone (server.js + traced node_modules + static + public —
# the repo build script already copies .next/static and public into it)
COPY --from=build /build/.next/standalone ./

# prisma CLI + schema for the gateway's boot-time db push
# (the CLI tree has non-@prisma deps — copy it whole, it is isolated)
COPY --from=build /prisma-cli ./prisma-cli
COPY --from=build /build/prisma ./prisma

# bundled services + the gateway itself
COPY --from=build /build/mini-services-dist ./mini-services-dist
COPY scripts/render-gateway.js ./scripts/render-gateway.js

EXPOSE 10000
CMD ["node", "scripts/render-gateway.js"]
