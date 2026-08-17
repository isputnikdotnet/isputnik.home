# ── Stage 1: install all deps (with native-module build tools) ────
FROM node:26-slim AS deps
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
# The git ref being built (CI passes the tag; defaults to the branch docs live on).
# Baked into the bundle so in-app Help links point at THIS version's guides.
ARG DOCS_REF=main
ENV DOCS_REF=$DOCS_REF
COPY apps/web ./apps/web
# The user guides are a build input, not just documentation: vite.config.ts copies
# them into public/ so the app can render them at /help. Without this the build
# fails outright (ENOENT on docs/users) rather than quietly shipping no help.
COPY docs/users ./docs/users
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
# That ci still leaves dev/web-only leftovers (the root-`overrides` target vite
# plus the tsx → esbuild chain). Do NOT sweep by npm's ":extraneous, .dev" flags:
# they're computed per hoisted tree node, so a package reachable through both a
# dev tool and a runtime dep (sharp's detect-libc/semver) gets flagged dev — that
# sweep shipped a 1.8.0 image whose server crashed at import ("Cannot find module
# 'detect-libc'"). Instead keep exactly the transitive closure of apps/server's
# production deps computed from package-lock.json and remove everything else.
COPY scripts/docker-prune-runtime-deps.mjs ./scripts/
RUN node scripts/docker-prune-runtime-deps.mjs \
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

# Import smoke test: every production dependency of the server must load from
# the pruned tree, so a bad prune fails THIS build instead of the container at
# startup (native modules included — sharp, better-sqlite3, onnxruntime-node).
# Runs from apps/server so resolution matches the server code's own view
# (non-hoisted packages like otplib live in apps/server/node_modules).
RUN cd apps/server && node -e 'const deps=Object.keys(require("./package.json").dependencies);\
(async()=>{for(const d of deps){try{await import(d)}catch(e){\
  console.error("runtime dep failed to load:",d,"-",e.message);process.exit(1)}}\
console.log(deps.length+" runtime deps load OK")})()'

# ── Stage 5: face recogniser model ────────────────────────────────
# The 167 MB ArcFace model is fetched from a GitHub release rather than carried
# in git-LFS: every image build pulled it through the LFS quota, and once that
# budget ran out checkout failed before a single file compiled, so no image was
# published at all. Its own stage keeps the download out of the code layers —
# a server change doesn't refetch it — and the script verifies a pinned SHA-256,
# so a replaced or truncated asset fails the build instead of shipping an image
# whose face clustering is quietly wrong.
FROM node:26-slim AS face-model
WORKDIR /build
COPY scripts/fetch-face-model.mjs ./scripts/
RUN node scripts/fetch-face-model.mjs --dest /build/models/face

# ── Stage 6: production image ─────────────────────────────────────
FROM node:26-slim
WORKDIR /app

# gosu drops the entrypoint from root to the runtime user (see
# scripts/docker-entrypoint.sh). It is purpose-built for this — a clean privilege
# drop with correct signal/TTY handling, unlike su/sudo.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

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

# ONNX face-recognition models (InsightFace: SCRFD-500MF detector + ArcFace
# ResNet50 recogniser). Resolved at runtime from apps/server/models/face/ (cwd is
# /app). The 2.5 MB detector rides along in git; the 167 MB recogniser is fetched
# in the face-model stage above and lands in the same directory.
COPY apps/server/models ./apps/server/models
COPY --from=face-model /build/models/face/w600k_r50.onnx ./apps/server/models/face/

# Built frontend (served as static files by Fastify)
COPY --from=web-build /build/apps/web/dist ./web

# Root package.json — read by config.ts for version + description
COPY package.json ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV STATIC_PATH=/app/web
# All persistent data lives under /config — mount this as a volume.
# EVERY path the server writes to must be named here: anything left to its default
# lands in the image's own filesystem, where it is invisible to the host and is
# destroyed the moment the container is recreated. Backups were doing exactly that
# until 2.15.1 — see rescueStrandedBackups() in modules/backups.
ENV DB_PATH=/config/db/isputnik.sqlite
ENV THUMBNAIL_PATH=/config/thumbnails
ENV METADATA_PATH=/config/metadata
ENV BACKUP_PATH=/config/backups
# Set to "true" only when served over HTTPS
ENV COOKIE_SECURE=false
# Number of reverse proxies in front (usually 1). 0 = trust nothing / direct access.
ENV TRUST_PROXY_HOPS=0

# Who the server runs as. Default to the image's `node` user (uid/gid 1000); the
# entrypoint honours PUID/PGID overrides so an Unraid install can match its
# appdata share owner (usually 99:100). The /config dirs are created and chowned
# by the entrypoint at runtime — a build-time mkdir would only touch the image
# layer the mounted volume then hides.
ENV PUID=1000
ENV PGID=1000

EXPOSE 4000

# Root entrypoint fixes /config ownership, then execs the CMD as PUID:PGID via
# gosu — the Node server itself never runs as root. No `USER` directive: the
# entrypoint needs root to chown the freshly mounted volume, then drops it.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "apps/server/dist/index.js"]
