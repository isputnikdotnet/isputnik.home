# Configuration reference

Every environment variable the server reads, what it does, and where it is set.
Most installs need only two or three of them — `APP_URL`, the `PUID`/`PGID` pair
when your `/config` folder has an unusual owner, and `TRUST_PROXY` once a reverse
proxy is in front. Everything else
has a default that is right for a home server, and nearly everything a household
changes day to day lives in the Control panel, not here.

Where a setting can be made both ways, the Control panel wins: the environment is
the starting value, the page is the choice someone made.

## Where each value comes from

There are four places a value can come from, and they don't all agree on purpose:

| Column | Meaning |
|---|---|
| **Default** | What the server uses when the variable is not set at all — a source install run with `npm run dev` or `node apps/server/dist/index.js` |
| **Image** | What the Docker image sets in its `Dockerfile` (`ENV`), so it applies to compose and Unraid alike unless they override it |
| **Compose** | What [`docker-compose.yml`](../docker-compose.yml) sets or offers as a commented line |
| **Unraid** | What the Community Applications template ([`isputnik-home.xml`](../isputnik-home.xml)) offers as a field |

A dash means the variable is not mentioned there, so the value from the column to
its left applies. In the image, every path points inside `/config`, which is the
one volume you mount — anything left to its default would land in the container's
own filesystem and disappear on the next update.

## Paths

| Variable | Default | Image | What it does |
|---|---|---|---|
| `DB_PATH` | `data/db/isputnik.sqlite` under the repo root | `/config/db/isputnik.sqlite` | The database. Its folder is created on start. Three things live beside it: `mfa.key` (see `MFA_ENCRYPTION_KEY`), a staged restore (`isputnik.sqlite.restore`) waiting for the next start, and the pre-upgrade copy (`isputnik.sqlite.pre-upgrade`) until the server files it in the backup folder — see [rollback.md](rollback.md). |
| `THUMBNAIL_PATH` | empty | – | Where generated covers and previews go when no folder of their own was chosen on **Control panel → Library → Storage**. A folder chosen there wins; with neither, they go to `thumbnails` in system data (the folder the setup guide asks for). |
| `METADATA_PATH` | empty | – | Where a JSON copy of an audiobook's metadata is written each time it is edited — a best-effort export; the database remains the source of truth. Unset, it goes to `metadata` in system data, and nothing is written until system data is chosen. |
| `STATIC_PATH` | empty | `/app/web` | The built web app, served by the same process. Empty means the server answers only `/api` (the Vite dev server serves the pages during development). Image-internal; don't change it in Docker. |

Compose and Unraid set none of these. The image sets only `DB_PATH`; until 4.6 it also set `THUMBNAIL_PATH`, `METADATA_PATH` and `BACKUP_PATH` to folders under `/config`, and the first start of 4.6 writes those same folders as system data, so nothing moves.

## Network and reverse proxy

| Variable | Default | Image | Compose | Unraid | What it does |
|---|---|---|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` | – | – | The address the server listens on. The source default answers only the machine it runs on; set `0.0.0.0` to reach a source install from the network. |
| `PORT` | `4000` | `4000` | – | port mapping | The port it listens on. In Docker, change the host side of the port mapping rather than this. |
| `APP_URL` | `http://127.0.0.1:5173` (the Vite dev server) | – | `http://localhost:4000` | field, blank | The address people use to reach the app. The browser origin the server accepts (CORS); the hostname passkeys are bound to; the fallback for invite and share links when the browser doesn't say where it is. An `https://` address also turns on HSTS, the http→https redirect and — with `COOKIE_SECURE=auto` — secure cookies. Leave it as plain http (or blank on Unraid) for a LAN-only install. |
| `TRUST_PROXY` | unset | `""` | commented example | field | The reverse proxy's own IP or CIDR range, comma-separated for several (`172.18.0.0/16`). Forwarded client addresses are believed only when they come from these. Unset means trust nothing — right with no proxy, wrong behind one: every visitor then looks like the proxy and shares one rate-limit bucket (over the limit, requests get HTTP 429). See [hosting.md](hosting.md). |
| `TRUST_PROXY_HOPS` | `0` | `0` | commented example | field | The older form: the number of proxies in front (usually `1`), trusted whoever they are. Only safe when the app's port can't be reached except through the proxy. If both are set, `TRUST_PROXY` wins. |
| `HTTPS_REDIRECT` | on when `APP_URL` is `https://` | – | – | – | Redirects a visitor who arrived over plain http (as reported by the proxy's `X-Forwarded-Proto`) to https. Set `false` when the proxy already does it. Does nothing for a plain-http `APP_URL`. |
| `HSTS` | on when `APP_URL` is `https://` | – | – | field, blank | Tells browsers to use HTTPS only for a year. Set `false` when the proxy sends its own `Strict-Transport-Security` header. Does nothing for a plain-http `APP_URL`. |

The walkthrough for putting all of this together is
[Exposing your library to the internet](users/exposing-to-the-internet.md).

## Security and sessions

| Variable | Default | Image | Compose | Unraid | What it does |
|---|---|---|---|---|---|
| `COOKIE_SECURE` | on when `NODE_ENV=production`, else off | `auto` | `auto` | field, `auto` | `auto` (or any value other than `true`/`false`) follows `APP_URL`: secure cookies for an `https://` address, plain ones for http. `true`/`false` override it. Browsers never send a secure cookie over plain http, so `true` on an http install means nobody can sign in. |
| `SESSION_DAYS` | `14` | – | commented | field, `14` | How long a browser sign-in lasts. |
| `DEVICE_SESSION_DAYS` | `365` | – | – | field, `365` | How long a screen signed in with [Link a device](users/link-a-device.md) stays signed in. Long on purpose — a wall display shouldn't need a keyboard every fortnight — and each one is named, listed under Profile → Devices, and revocable. |
| `INVITE_DAYS` | `7` | – | commented | field, `7` | The default lifetime of an invitation link, in days. |
| `ACTIVITY_LOG_RETENTION_DAYS` | `365` | – | – | – | How far back the **Prune the activity log** scheduled job (off by default) keeps the activity log and sign-in attempts — the two tables that record visitor IP addresses. Only matters once that job is on. |
| `MFA_ENCRYPTION_KEY` | unset | – | – | – | The key two-factor (TOTP) secrets are encrypted with, as any string. Unset, the server makes a random key and keeps it in `mfa.key` beside the database, which works out of the box and travels in full and minimal backups. Set it only if you want the key outside the data folder, and keep it forever: changing it — including switching an existing install from the file to this — makes every stored secret unreadable and everyone using an authenticator app must set it up again. With it set, backups carry no key, so a server you restore onto needs the same value. |

## Backups

| Variable | Default | Image | What it does |
|---|---|---|---|
| `BACKUP_PATH` | `backups` beside the database's folder | – | The backup folder when no folder of their own was chosen on **Control panel → Library → Storage**. Unset, backups go to `backups` in system data, or beside the database's folder until system data is chosen (`/config/backups` in Docker). When a restore is applied, the database it replaces is kept as `isputnik-<date>-<time>.sqlite` in the backup folder, and listed on the Backup page. |
| `BACKUP_RETENTION` | `10` | – | **Legacy.** Since 3.89.0 retention is set on **Control panel → Maintenance → Backup** ("Keep the newest") and stored in the database, and since 4.3.0 each kind — full, minimal, database copy — has its own count. This is only the starting value for all three on an install where they have never been saved; an install upgraded from an earlier version already has its own. It has no effect on the automatic pre-upgrade copies, which always keep the newest 2. |

Scheduling and the three kinds of backup are all in the Control panel — see
[The control panel → Backup](users/control-panel.md#backup).

## Face recognition and performance

| Variable | Default | What it does |
|---|---|---|
| `FACE_ORT_THREADS` | CPU cores − 1 (at least 1) | How many CPU threads a face scan may use. The default leaves one core free so the web app stays responsive while a scan runs; set `1` to throttle hardest on a small box, or higher to finish sooner. |
| `FACE_ORT_PROVIDERS` | unset (CPU) | Comma-separated onnxruntime execution providers to try first, e.g. `cuda,cpu`. CPU is always added as the last resort, and a provider that fails to load — or fails mid-scan — falls back to CPU on its own. It only helps with an onnxruntime build and a machine that actually have that accelerator; the Docker image is set up for CPU. |

Neither is in the image, compose or the Unraid template; add them as extra
variables if you need them. Background:
[gallery-library.md → Face recognition](gallery-library.md#face-recognition).

## IP locations

| Variable | Default | Image | What it does |
|---|---|---|---|
| `GEOIP_PATH` | the **Locations** folder of the Map data room (App storage's `Map data/Locations`, else `map-data/Locations` next to the database's folder) | – | Where the IP-location databases live — the country database the Dashboard's Locations view fetches, and any city-level `.mmdb` you add by hand. Leave it unset and they move with the Map data room. Before 4.6 the default was a `geoip` folder (`/config/geoip` in the image); anything still there is moved into the room when the server starts. Set it only to keep them in a folder of your own, which the server then never moves. |
| `GEOIP_URL_BASE` | `https://download.db-ip.com/free` | – | Where that country database is downloaded from (`<base>/dbip-country-lite-YYYY-MM.mmdb.gz`). Change it only to point at a mirror. |

## Logging

| Variable | Default | What it does |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. At `info` every request is logged, and on a busy install that is most of the log — each audio range request while someone listens is a line. `warn` drops the per-request lines and keeps problems. |

The compose file caps Docker's own log files (json-file, 10 MB × 5). A plain
`docker run` gets whatever the Docker daemon is configured for, which by default
is no limit — pass `--log-opt max-size=10m --log-opt max-file=5` or set it in
the daemon.

## Container user and image internals

| Variable | Image | Compose | Unraid | What it does |
|---|---|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` | `1000` / `1000` | `99` / `100` | The user and group the server runs as. The container starts as root only long enough to take ownership of `/config` for that user, then drops to it — the server itself never runs as root. Read by the entrypoint script, not the server. See [Exposing → About the container user](users/exposing-to-the-internet.md#about-the-container-user). |
| `NODE_ENV` | `production` | – | – | The server only uses it to pick `COOKIE_SECURE`'s behaviour when that is unset. Leave it. |

## What the container does on its own

These need no configuration, but they are worth knowing when you run it:

- **Health check.** The image declares a Docker `HEALTHCHECK` against
  `GET /api/health` every 30 seconds, with a two-minute grace period at start for a
  first boot's migrations. The endpoint needs no sign-in and says only
  `{ "ok": true }`, or answers 503 when the database stops responding. Compose and
  Unraid inherit it, so `docker ps` shows the container as healthy or unhealthy.
- **Orderly shutdown.** On `docker stop` the server finishes the requests in
  flight, lets background work (scans, face scans, renders, storage moves) stop
  between units and closes the database, giving itself 10 seconds. Compose sets
  `stop_grace_period: 30s` and the Unraid template `--stop-timeout=30` so Docker
  doesn't kill it first; a plain `docker run` should pass `--stop-timeout 30`.
- **Pre-upgrade copy.** The first start of a new version saves the database as it
  was before that version's migrations run. See [rollback.md](rollback.md).

## Building the image

Two variables affect building, not the running server. `DOCS_REF` is a Docker
build argument: the git ref the in-app Help links point at (CI passes the tag; a
local build says `main`). `FACE_MODEL_URL` is read by
`scripts/fetch-face-model.mjs` (`npm run fetch:face-model`) to fetch the 167 MB
face recogniser from a mirror instead of the project's release asset; the file is
checked against a pinned SHA-256 wherever it comes from.
