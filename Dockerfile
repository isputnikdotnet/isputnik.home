# ── Stage 1: install all deps (with native-module build tools) ────
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
RUN npm ci

# ── Stage 2: build the Vite frontend ─────────────────────────────
FROM deps AS web-build
COPY apps/web ./apps/web
RUN npm run build --workspace apps/web

# ── Stage 3: compile the TypeScript server ────────────────────────
FROM deps AS server-build
COPY apps/server ./apps/server
RUN npm run build --workspace apps/server

# ── Stage 4: production image ─────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# Runtime node_modules (with compiled native bindings from the build stage)
COPY --from=deps /build/node_modules ./node_modules

# Compiled server
COPY --from=server-build /build/apps/server/dist ./apps/server/dist

# Built frontend (served as static files by Fastify)
COPY --from=web-build /build/apps/web/dist ./web

# Root package.json — read by config.ts for version + description
COPY package.json ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV STATIC_PATH=/app/web
# All persistent data lives under /config — mount this as a volume
ENV DB_PATH=/config/db/isputnik.sqlite
ENV THUMBNAIL_PATH=/config/thumbnails
ENV METADATA_PATH=/config/metadata
# Set to "true" only when served over HTTPS
ENV COOKIE_SECURE=false

EXPOSE 4000

RUN mkdir -p /config/db /config/thumbnails /config/metadata

CMD ["node", "apps/server/dist/index.js"]
