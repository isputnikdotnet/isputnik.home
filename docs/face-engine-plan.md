# Face engine plan — face recognition in a container of its own

Face recognition is the heaviest thing in the home image and the thing that
changes least: `onnxruntime-node` (288 MB, pruned to one platform ~70 MB) and the
two InsightFace models (169 MB) ship in every release of home, and home releases
every few days. Each release rebuilds the `node_modules` layer (the version bump
reruns `npm ci`), so every household pulls those megabytes again for a feature
that has not changed since 3.x. Moving the inference into a container of its own
makes home's image smaller and its updates quicker, keeps a native crash in ONNX
or libvips out of the web server, and makes a GPU build a Docker tag rather than
a change to home.

This is the third container beside home and the second **engine**
(`docs/apps-platform-plan.md` → Two kinds of container): no screens, no library
of its own, reached only through home. Unlike video it keeps **no data at all**:
a photo goes in, its faces come out, and everything that is remembered — faces,
people, names, crops, clusters, settings — stays in home's database exactly as
today.

Status: E1 released 2026-11-03 (isputnik.faces 0.1.0, image on GHCR); H1
released the same day as home 4.65.0; H2 followed at once as 4.65.1 — the owner
chose not to keep a release with both paths: the image dropped the ONNX runtime
and the models, and without a paired container the face settings say so and
keep their switches off. A source checkout keeps the in-process path.

## In one sentence

**Home keeps every table and every screen; the engine only turns an image into
boxes, embeddings and face crops.**

## What moves and what stays

| | Today (home) | After |
|---|---|---|
| Decode photo, run SCRFD detector + ArcFace recogniser (`faces/arcface.ts`, ~390 lines) | home | **engine** |
| Face crops for avatars (`faces/thumbnails.ts` → `cropFaceFromRaw`) | home, from the same decode | **engine**, returned with each face; the backfill of old faces without a crop stays in home (sharp is there anyway) |
| Scanner batches, queue, nightly job, time limit (`scanner.ts`, `queue.ts`) | home | home — one call per photo now goes over HTTP |
| Clustering, adoption, naming, merge, health (`cluster.ts`, `adopt.ts`, `health.ts`) | home | home, untouched |
| `gallery_faces`, `gallery_people`, `gallery_face_scans`, settings | home | home, untouched |
| `FACE_ORT_THREADS`, `FACE_ORT_PROVIDERS` | home's environment | the engine's (`ORT_THREADS`, `ORT_PROVIDERS`); home's still apply to a source checkout running in-process |
| `onnxruntime-node`, `models/face/*` | home's image | the engine's image; home keeps them only as a **dev dependency** so `npm run dev` needs no second server |

The embedding model does not change (`FACE_EMBEDDING_MODEL` stays
`buffalo_l/w600k_r50`), so no face is re-embedded and no cluster moves when an
install switches to the container. The engine reports the model it runs in its
health answer, and home refuses to scan with an engine whose model is not the one
its rows were made with.

## Decisions

- **Stateless engine.** No SQLite, no `/config` volume, nothing to back up or
  restore. Events and the log tail live in memory (the log buffer games and video
  already use). The registry marks it `stateless`, and home's backup skips it with
  the reason "keeps no data" instead of "did not answer".
- **Home sends the file; the engine decodes.** The scanner reads the original
  bytes and posts them; the engine decodes with sharp (EXIF-upright, capped at
  2048 px, as `decodeUpright` does now). A photo sharp cannot decode (BMP) is
  converted to JPEG by home's existing ffmpeg fallback (`decodePhotoToJpeg`) before
  sending — so the engine image needs no ffmpeg. Body limit 64 MB.
- **The engine returns the crops too.** Each face comes back with its 160 px
  square WebP avatar, so home's scan loop decodes nothing: no double decode, and
  sharp's cache and thread settings in home stop mattering during a scan.
- **In production, the container is the only way to scan faces.** Home's image
  drops the runtime and the models; the Gallery's face settings say "Face
  recognition needs the isputnik.faces container" with a link to Settings › Apps
  until it is paired. A source checkout (and the test suite) keeps the in-process
  path, chosen automatically when no engine is configured and `onnxruntime-node`
  loads. Keeping both paths in the image would keep the 450 MB, which is the
  whole point.
- **CPU image first.** A CUDA tag (`:cuda`, on an `nvidia/cuda` runtime base with
  cuDNN, several GB) comes when someone has a GPU to test it on — the owner's
  Unraid has none. `ORT_PROVIDERS` is honoured from the start so the CPU image
  can try an accelerator if the libraries are mounted in.
- **One photo in flight.** The engine runs one inference at a time (a queue, like
  `renderInTurn`); home's scanner is sequential already. Two in flight is a later
  measurement, not a design change.
- **The browser never reaches `/faces/api/detect`.** The gateway forwards only the
  admin window (`/faces/api/admin/*`) and health; detection is called by home's
  server directly, signed with the secret, as the video engine's admin calls are.

## The engine — isputnik.faces

A repository and image shaped like `isputnik.video`: Fastify, TypeScript, **no
front end, no database**, port **4400**, prefix **`/faces`**, Unraid template
without a port, `GATEWAY_SECRET` masked and required in production. CPU limit set
in Unraid if wanted. Repository `isputnikdotnet/isputnik.faces`, image
`ghcr.io/isputnikdotnet/isputnik.faces`, container name `isputnik-faces`.

| Route | Who | What |
|---|---|---|
| `GET /faces/api/health` | anyone | `{ ok, version, model, providers, gpu, loaded }` — `loaded` false until the first detect warmed the sessions (or `WARM=1` loaded them on start) |
| `GET /faces/api/me` | signed | the signed probe home's Dashboard uses to tell a wrong secret from a working one |
| `POST /faces/api/detect` | signed, admin | body: the image bytes (`image/jpeg`, `image/png`, `image/webp`, `image/tiff`, …), `?crops=0` to skip avatars. Answer: `{ model, width, height, faces: [{ box: [x, y, w, h], score, embedding: <base64 of 512 float32>, crop: <base64 webp> \| null }] }`; boxes normalised 0..1 of the upright image, as today. 415 for a format sharp cannot open, 422 for a file that fails to decode, 503 while the models are missing |
| `GET /faces/api/admin/events`, `/log` | admin | the admin's window, from memory |
| `GET /faces/api/admin/backup` | admin | 204: nothing to hand over (home never asks; see Decisions) |

The code: `src/identity.ts`, `config.ts`, `log-buffer.ts`, `events.ts` copied
from video with the video-only parts dropped; `src/arcface.ts` is home's file
moved as it is (decode included) plus `cropFace`, from `thumbnails.ts`;
`src/app.ts` is the five routes. ~200 new lines around ~450 moved.

**Models.** `det_500m.onnx` (2.5 MB) in git; `w600k_r50.onnx` fetched by the
same `scripts/fetch-face-model.mjs` from the same GitHub release asset on home's
repository (the pinned SHA-256 travels with the script), in the Dockerfile's own
stage so a code change never refetches it. `FACE_MODEL_URL` keeps overriding the
source for mirrors.

**Image.** `node:26-slim`; `onnxruntime-node` pruned to the image's platform as
home's Dockerfile does today; gosu entrypoint with PUID/PGID (nothing to chown, but
the same shape as the others); `HEALTHCHECK` on `/faces/api/health`. Expected
size ~300 MB, nearly all of it the runtime and the recogniser.

**Environment.** `GATEWAY_SECRET` (required), `ORT_THREADS` (cores − 1),
`ORT_PROVIDERS` (`cpu`), `WARM` (load the models on start instead of on the
first photo), `LOG_LEVEL`, `PUID`/`PGID`.

**Tests.** The detection test from home (`face-detection.test.ts` with its
fixture) against the real models, skipped when the runtime cannot load; route
tests with a stub detector for the contract (identity, 415/422/503, the base64
shapes).

**CI.** `test.yml` + `docker.yml` as in video: a `v*` tag publishes to GHCR after
the tests; pushes to main build and discard.

## Home's side

### Registry and gateway

- `modules/apps/registry.ts`: a third entry — `id: "faces"`, `kind: "engine"`,
  `prefix: "/faces"`, `FACES_URL` / `FACES_GATEWAY_SECRET`, example
  `http://isputnik-faces:4400`, `signedProbePath: "/faces/api/me"`, docs anchor
  `faces`, and two new fields: `stateless: true` (backups skip it) and
  `section` made **optional** — an engine without pages has no menu switch, and
  the places that read `section` (the menu, Appearance › Sections) skip an app
  without one.
- Capabilities: `manage` (`/faces/api/admin/`, anywhere, admin) and a catch-all
  that the gateway **refuses** (404) — nothing else under `/faces` is for a
  browser. The gateway gets a `forwardOnly` hook if it does not have one; the
  video restore path already uses such a refusal.
- `modules/apps/backup.ts`: a stateless container is left out with
  `{ included: false, reason: "keeps no data" }`, and Maintenance › Backups shows
  no restore card for it.

### The detector switch

`modules/library/gallery/faces/detector.ts` is the one place the scanner, the
crop backfill and the settings page ask:

```
detectFaces(file: { path, bytes? }) → { faces: DetectedFace[] & { crop?: Buffer } }
faceEngineStatus() → { where: "container" | "in-process" | "none", version, model, gpu, reason? }
```

- Engine configured (address + secret, from Settings › Apps or the environment):
  `faces/engine-client.ts`, the `engineClient` shape from `video/engine.ts`
  (signed as `system:home`, admin role, 60 s timeout per photo), posting the file
  bytes and reading the answer back into `DetectedFace` + crop buffers.
- No engine, and `onnxruntime-node` loads: `arcface.ts` as today (a source
  checkout). `arcface.ts` stays in home for this, with the models fetched by
  `npm run fetch:face-model` as now.
- Neither: `faceEngineStatus().where === "none"`; a scan is refused with the
  reason before a job is queued, and the nightly job logs one line and skips.

### Scanner

`scanner.ts` per photo: read the file (ffmpeg-converted when sharp cannot open
it), `detectFaces`, keep faces ≥ `MIN_FACE_SIDE`, write each returned crop into
the thumbnail store under the same key `cropFaceFromRaw` makes today, then the
unchanged transaction. The in-process path returns crops the same way (it calls
`cropFaceFromRaw` itself), so the loop has one shape. A photo the engine cannot
decode is a failed attempt as now, retried up to the cap.

A scan checks the engine's model against `FACE_EMBEDDING_MODEL` once at the
start and refuses to run against a different one — a mismatch would put
incomparable vectors into one table.

### Screens

- **Gallery face settings** (`GalleryFaceSettingsModal`): a status line at the
  top — "Faces are found by the isputnik.faces container (0.1.0, CPU)", "…in
  this server" for a checkout, or a `MessageBox` (warning) "Face recognition
  needs the isputnik.faces container" with a link to Settings › Apps; Scan now
  disabled with the reason while there is none.
- **Settings › Apps** and **Overview › Dashboard** list it as every container is
  listed (`AppsSection` names it with a new `nav.faces` key; the Dashboard card
  links to the Gallery's face settings for a running engine).
- **Overview › Logs** gets it as a source for free.
- **Maintenance › Backups**: no card (stateless).

Search terms for Settings › Apps gain "faces", "face recognition container".

### The image

- `onnxruntime-node` moves to `devDependencies`; `npm ci --omit=dev` drops it,
  and the prune script's closure never sees it. The Dockerfile loses the
  `face-model` stage, the `models` copies and the onnxruntime platform pruning;
  the import smoke test loops over `dependencies` and so is unaffected.
- `README.md` (Disk) and `docs/configuration.md` say the face model now lives in
  the faces container; `FACE_ORT_*` are documented as source-checkout only.
- Expected saving: ~240 MB from the compressed image, and most of the layer
  churn on an ordinary release.

### Tests (home)

- `face-engine-client.test.ts`: a stand-in faces server (Fastify, like
  `apps-status.test.ts`) answering canned faces; the scanner stores the faces and
  crops it returned, records a failure on 422, refuses a scan on a model
  mismatch, and skips when nothing is configured and the runtime is absent
  (simulated by the switch's injectable loader).
- `apps-status.test.ts`: the list is `["games", "video", "faces"]`.
- `apps-backup.test.ts`: the stateless container is reported as skipped, not
  missing.
- Everything that mocks `arcface.ts` keeps working: the in-process path is still
  there for tests.

## Phases

| Phase | Where | What |
|---|---|---|
| **E1** | isputnik.faces | repository, `arcface.ts` moved with crops, the five routes, Dockerfile, template, CI; tag 0.1.0 and publish the image |
| **H1** | home | registry entry (`stateless`, optional `section`), gateway refusal, backup skip, `detector.ts` + `engine-client.ts`, scanner through the switch, face settings status, Apps and Dashboard naming, docs (`users/apps.md`, `configuration.md`, `gallery-library.md`), tests. Release with the in-process path **still in the image** — one release where both work, so the owner's install switches over without a gap |
| **H2** | home | the image drops the runtime and the models (dev dependency, Dockerfile), README; released after the owner's Unraid has run a nightly scan through the container |
| later | isputnik.faces | `:cuda` tag; two photos in flight if the measurement says the network wait is what the scan spends its time on |

## Open points

- **Big photos over the Docker network.** A 25 MB original per call is fine on
  one box; on a slow link it would be the bottleneck. If so, home can send a
  2048 px JPEG instead — one decode on home's side, the thing this plan avoids,
  so only when measured.
- **Unraid CA listing** for the faces container, as for games
  (`docs/users/apps.md` → the install steps say "the template's address").
- **Dev workflow.** `npm run dev` in home keeps in-process faces; to try the
  container locally, run isputnik.faces on :4400 with a shared secret and set
  `FACES_URL` + `FACES_GATEWAY_SECRET` in home's `.env`.
