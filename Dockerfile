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

# ── Stage 4: runtime-only node_modules ────────────────────────────
# The deps stage has dev deps (typescript, vite, esbuild, …) and every web-only
# package — none of that belongs in the runtime image. All runtime deps are the
# server workspace's `dependencies` (the root package has only devDependencies),
# so reinstall just those. Build tools are inherited from deps in case a native
# module has no prebuild for this platform.
FROM deps AS prod-deps
RUN npm ci --omit=dev --workspace apps/server
# npm quirk: that ci still leaves the root-`overrides` target (vite) installed as
# an extraneous package, plus dev deps it peer-references (tsx → esbuild). And
# `npm prune` can't fix it — its reify step puts them right back. So sweep
# whatever npm itself flags as extraneous or dev-only (workspace entries like
# apps/web are outside node_modules and excluded), and fail the build loudly if
# anything survives. Uses `location` (relative), not `path` — npm's log redaction
# can mangle absolute paths.
RUN node -e 'const {execSync}=require("child_process"),fs=require("fs");\
const q=()=>JSON.parse(execSync("npm query \":extraneous, .dev\"",{maxBuffer:64e6}).toString())\
  .filter(p=>p.location.startsWith("node_modules"));\
for(let i=0;i<5;i++){const hits=q();if(!hits.length)process.exit(0);\
  for(const p of hits)fs.rmSync(p.location,{recursive:true,force:true})}\
console.error("dev/extraneous packages survived the sweep");process.exit(1)' \
    && find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete
# ffprobe-static and onnxruntime-node ship binaries for every OS/arch in one
# package (~330 MB and ~220 MB of foreign-platform dead weight). Keep only this
# image's platform. Must happen HERE, not in the final stage — a later RUN rm
# can't shrink an earlier COPY layer.
RUN rm -rf node_modules/ffprobe-static/bin/darwin \
           node_modules/ffprobe-static/bin/win32 \
           node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32 \
    && find node_modules/ffprobe-static/bin/linux \
            node_modules/onnxruntime-node/bin/napi-v6/linux \
            -mindepth 1 -maxdepth 1 -type d ! -name "$(node -p 'process.arch')" \
            -exec rm -rf {} +

# ── Stage 5: production image ─────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# ffmpeg/ffprobe (gallery video metadata + poster thumbnails) ship as the
# ffmpeg-static / ffprobe-static node_modules binaries copied below — no system
# install needed. Photos use sharp.

# Runtime node_modules (with compiled native bindings from the build stage)
COPY --from=prod-deps /build/node_modules ./node_modules

# Workspace-nested modules npm chose NOT to hoist to root. otplib is the first such
# dep (its @otplib/core@12 conflicts with the version the presets pull in, so npm
# nests otplib + @otplib/core under apps/server instead of root). Without this copy
# they're absent at runtime → ERR_MODULE_NOT_FOUND. Copying the whole dir is
# future-proof: any later non-hoisted server dep comes along automatically.
COPY --from=prod-deps /build/apps/server/node_modules ./apps/server/node_modules

# Compiled server
COPY --from=server-build /build/apps/server/dist ./apps/server/dist

# Vendored ONNX face-recognition models (InsightFace: SCRFD-500MF detector +
# ArcFace ResNet50 recogniser). Resolved at runtime from apps/server/models/face/ (cwd is /app).
COPY apps/server/models ./apps/server/models

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
# Number of reverse proxies in front (usually 1). 0 = trust nothing / direct access.
ENV TRUST_PROXY_HOPS=0

EXPOSE 4000

RUN mkdir -p /config/db /config/thumbnails /config/metadata

CMD ["node", "apps/server/dist/index.js"]
