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
# Fastify serves the built frontend from this path
ENV STATIC_PATH=/app/web
# SQLite database location — mount a volume here
ENV DB_PATH=/data/db/isputnik.sqlite

EXPOSE 4000

# Create data dirs so the app can write to them even without a volume
RUN mkdir -p /data/db /data/thumbnails /data/metadata

CMD ["node", "apps/server/dist/index.js"]
