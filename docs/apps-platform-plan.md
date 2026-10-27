# Apps platform plan — containers beside isputnik.home

isputnik.home is the front door; some features run in containers of their own
behind it. Games was the first (`docs/games-platform-plan.md`). Video is the
second, and with two of them the games-only wiring becomes one shared system: one
gateway, one way to decide who may use an app and from where, one place in the
Control panel to see whether each container is healthy and what it has been doing.

This page is the plan for that system and for video built on it. The games
contract stays valid; everything here extends it.

Status: phase 0 built (2026-10-25, not yet released): `modules/apps/` (registry,
shared gateway, status probes, `GET /api/apps/admin/status`), games moved onto it,
and the Apps group with Installed, Events and Logs. The Games menu switch is still
on Appearance → Sections; it moves to the Installed card with the second
container, when the Sections card's "last section stays on" rule has to be
rethought anyway.

Phase 1 built (2026-10-25, not yet released): Apps → Access (who: Everyone,
groups, people as member / manager / deny on `assignments` with object_type
`app`; from where: a rule per capability), enforced by the shared gateway (no role
→ 404, refused network → 403 with the reason) and forwarded as
`X-Isputnik-App-Role`, `X-Isputnik-Via`, `X-Isputnik-Network`. Two changes from
the plan below: capabilities are declared in home's registry (`registry.ts`), not
read from a container manifest — the paths are what the gateway enforces, so a
container must not be able to widen them; and `X-Isputnik-Libraries` waits for the
first engine (V1).

Phase 2 pairing built (2026-10-25, not yet released): Apps → Setup makes a secret
(32 random bytes, shown once, kept sealed in `app_pairings` with the server key),
replaces or forgets it, and tests the connection. `<APP>_GATEWAY_SECRET` in the
environment still wins, and pairing is off while it is set. The gateway asks for
the secret on every request and is registered for any usable address, so pairing
or rotating needs no restart of home.

Phase 2 backups, home's side built (2026-10-25, not yet released): full and
minimal zips ask each paired container for its database (`modules/apps/backup.ts`)
and carry `apps/<id>.sqlite`, with `backup.json` saying what went in or why not.
Still open: the container side — `GET /games/api/admin/backup` in isputnik.games;
until a container has it, backups say "too old to hand over its database" and
finish without it — and sending a database back from Apps → Installed.

V1 engine started (2026-10-25, https://github.com/isputnikdotnet/isputnik.video,
0.1.0; no image or Unraid template yet): identity from the gateway with `X-Isputnik-Libraries`
as its only permission model; library put / delete / sync (detach, never drop);
shows and movies scanner (.nfo first, release names, stable ids, copies in
progress left for later); catalog routes; folder picker under `MEDIA_ROOT`;
events, log and backup routes.

V1 home side built (2026-10-26, not yet released): server — `modules/library/video`,
video libraries as `libraries` rows of type `video` (`video:/<folder>`), created,
changed, deleted and rescanned through the engine, `X-Isputnik-Libraries` from
the gateway, a sync on start and every 6 hours (56d35e6); web — Add library →
Video with the engine's folder picker, video rows on Library → Libraries, the
Video menu entry, `/shows` and `/movies` and a title's page (664c84c2). Checked
against the real engine. Editing a video library from its row (name, access,
folder, the language TMDB is asked in) came with home 4.44.0. Next: posters and TMDB, then V2 (the player), and
publishing the engine's image and Unraid template.

## Two kinds of container

- **An app** has its own screens and its own data. The gateway proxies the whole
  prefix and the app draws every page. Games is an app.
- **An engine** has no screens. Home owns what the family sees and manages — the
  pages, the library list, who may see what — and the engine does the heavy work
  and keeps the bulky data behind it. Video is an engine.

Both are reached only through home, paired, monitored and governed the same way.
Video is an engine because video is heavy in two ways: playing it takes real CPU
(remux, transcode), and the code to scan, describe and stream it is large. Both stay
out of home. What the family sees and what the admin manages stays in home, so a
video library is created, shared and browsed exactly like every other library.

## Decisions (owner, 2026-10-25)

- **The gateway stays the only door.** Every container is reached through home under
  its own prefix (`/games`, `/video`); none faces the network.
- **Video is a separate container, integrated as an engine.** Home never opens a
  video file: the video folders are mounted into the video container only, and all
  of ffmpeg runs there.
- **Video libraries are managed in home.** They are rows in home's `libraries`
  table, created in the same Add library dialog, shared with the same access
  editor, listed on the same Library → Libraries page. Their contents (shows,
  episodes, metadata, progress) live in the video container.
- **Video's screens are home's.** Browse pages, the show page and the player are
  part of home's web app (a lazily loaded chunk), built from home's shared
  components, so the look, theme, language and phone layout are the same by
  construction. They call `/video/api/…` through the gateway.
- **Containers get their own Control panel group, "Apps".** A seventh group: the
  six-group budget in `features/control/nav.ts` is raised to seven on purpose,
  with the reason recorded there and in CLAUDE.md. One nav link over one row of
  tabs, like every other group.
- **Connection by pairing.** Home generates each container's secret and shows what
  to put in its template. The container's address is saved on Setup too (since
  4.38.1), so a new container never needs home's template edited; `<APP>_URL` and
  `<APP>_GATEWAY_SECRET` in home's environment still win when set.
- **Video's first client is the browser/PWA player.** The Stremio add-on (Fire TV)
  follows; Kodi over WebDAV after that.
- **Home never starts, stops or updates containers.** That would need the Docker
  socket, which is root on the host. Unraid's Docker page keeps that job; home only
  observes.

## The registry (home)

`modules/apps/` replaces the games-only wiring in `modules/games/`. A container is
one entry in a static registry:

| Field | Games | Video |
|---|---|---|
| id / prefix | `games` → `/games` | `video` → `/video` |
| kind | app | engine |
| upstream (Setup, or the environment) | `GAMES_URL` | `VIDEO_URL` |
| default port | 4200 | 4300 |
| repository / image | `isputnik.games` | `isputnik.video` |

The registry is code, not data: a container is something this release of home
knows how to talk to. What is data is each one's pairing, access and network rules.

The gateway in `modules/games/gateway.ts` becomes `modules/apps/gateway.ts`,
registered once per configured container: session check (`authenticate`), header
stripping, signed identity headers, the sign-in redirect for page navigations (apps
only — an engine has no pages), the 404 while it is switched off, and home's own
gateway log per container. Games' guest links stay games-only and move onto the
shared gateway's hook for "who is this when there is no session" (see Tokens).

## The contract, extended

Everything in the games contract holds (request path, CSRF, preview as member,
identity headers). Additions:

### New identity headers

| Header | Value |
|---|---|
| `X-Isputnik-App-Role` | the person's role in this container: `member` or `manager` (Access, below). `X-Isputnik-User-Role` keeps carrying home's own role. |
| `X-Isputnik-Libraries` | engines only: the ids of this container's libraries the person may see, comma-separated, worked out by home from `assignments` exactly as for any library. The engine filters by it and needs no permission logic of its own. |
| `X-Isputnik-Via` | `session`, `token` or `guest` — how the request got in |
| `X-Isputnik-Network` | `home`, `trusted` or `internet`, as the gateway judged the address, so a page can hide what the network rule would refuse anyway (a Download button) |

Games keeps working unchanged: it ignores headers it does not know.

### Calls every container answers

Under its prefix; home pulls them, the container never calls home.

| Endpoint | Answers | Exists today |
|---|---|---|
| `GET /api/health` | `{ ok, version }`, no identity needed | games |
| `GET /api/manifest` | name, kind, version, contract version, capabilities, token routes | new |
| `GET /api/summary` | badges and For you cards for the signed-in person | games |
| `GET /api/admin/events` | security and business events, manager/admin only | games |
| `GET /api/admin/log` | the log tail, manager/admin only | games |

### Calls an engine answers for home

Home's server calls these itself, signed with the secret, in the admin's name —
the direction guest links already use when home creates a games match.

| Endpoint | Used for |
|---|---|
| `GET /api/admin/folders?path=` | the folder picker in Add library, browsing the ENGINE's mounts (`/media/…`), not home's |
| `PUT /api/admin/libraries/:id` | create or update a library: home's id, name, folder, settings |
| `DELETE /api/admin/libraries/:id` | the library was deleted in home; the engine drops its catalog |
| `POST /api/admin/libraries/:id/scan` | Scan now |
| `GET /api/admin/libraries` | per library: item count, size, scan state, last scan, errors — for the Libraries page and its cards |
| `GET /api/admin/jobs` | running and recent jobs, for Maintenance → Tasks |

Home is the source of truth for which libraries exist and who may see them; the
engine is the source of truth for what is in them. When the two disagree (the
engine was reset, a call failed), home re-sends its libraries on the next health
check, and the engine drops any library home no longer has.

### Capabilities

The manifest names what a container can do as **capabilities**, each a set of path
patterns under its prefix and a default network rule. Video's:

| Capability | Paths | Default rule |
|---|---|---|
| `browse` | `/video/api/*` | Anywhere |
| `watch` | `/video/api/stream/*`, `/video/api/hls/*`, `/video/api/subtitles/*` | Anywhere |
| `download` | `/video/api/download/*` | Trusted networks only |
| `devices` | `/video/stremio/*`, `/video/dav/*` | Home network only |
| `manage` | `/video/api/admin/*` | Anywhere (needs `manager`) |

Home checks a manifest before using it: every path must sit under the container's
own prefix, and a capability home does not recognise as safe to relax stays at its
default. A request matching no capability falls under `browse`.

## Access — who may use a container

Uses the unified `assignments` table with a new `object_type = 'app'` (`object_id`
= the container id): Everyone, groups or members, as `member` or `manager`, plus
`deny` — the same model and editor as libraries. Home admins are always `manager`.
Default for a newly paired container: Everyone as `member`, which is how games
behaves today. Someone with no assignment gets 404 under the prefix and the entry
is left out of their menu, phone sheet and For you.

For video there is a second, finer level that needs nothing new: each video
library has its own assignments, like any library, and they become the
`X-Isputnik-Libraries` header.

## Network rules — from where

Each capability of each container gets one of three rules, set in Apps → Access:

- **Anywhere** — all home's usual rules still apply (MFA outside trusted networks,
  rate limits, blocks).
- **Trusted networks only** — the trusted zones on Security → Trusted, judged with
  `isTrustedRequest()` so a misconfigured proxy cannot make the internet trusted.
- **Home network only** — private address ranges only.

A refused request gets 403 with a reason the page can show ("Downloads work only
at home"). The same idea as the existing "deletions only from trusted networks"
policy, per container and per capability.

## Tokens — clients without a session

Stremio, Kodi and TV apps cannot carry the session cookie. `api_tokens` already has
scopes (OPDS); a manifest lists its **token routes** and the scope each takes
(`video-stremio`, `video-webdav`). On those routes the gateway takes the token from
the path (`/video/stremio/<token>/…`) or Basic auth (WebDAV), resolves it with
`resolveApiToken`, applies the capability's network rule and forwards the token
owner's identity — libraries included — with `X-Isputnik-Via: token`. The
container never sees or stores tokens.

Tokens are personal: created and revoked in **Profile → Devices**, shown once,
read-only. Apps → Access adds an admin list of every container token for revoking.

## Control panel — the Apps group

| Tab | Content |
|---|---|
| **Installed** | one card per registered container: up/down, version (and "newer version available" from GHCR), secret accepted, URL, the menu switch, a link to an app's own admin pages |
| **Access** | per container: who (assignments editor) and the network rule per capability |
| **Events** | every container's events, `?app=` filter in the query (`initialParam`) |
| **Logs** | each container's log tail and home's gateway log for it, picker in the query |
| **Setup** | pairing: generate or rotate a secret, the values for the Unraid template, a connection test |

Moves: Settings → Games goes away (its address joins `CONTROL_ALIASES`, pointing at
Apps → Installed). The Games switch leaves Appearance → Sections for its card; the
stored value stays in the `sections` setting (`core/sections.ts`), so nothing
migrates and the menu filters keep working. Video gets a `video` section key the
same way. Search terms for every tab go into `features/control/search-index.ts`.

Video libraries do NOT get a page here: they are on Library → Libraries with the
rest.

## Pairing

1. Apps → Setup → the container → **Generate secret**. Home stores it (new
   `app_pairings` table: id, secret, created/rotated by and when — a new table, so
   `schema.sql` only) and shows it once with the template fields to fill.
2. The owner pastes it into the container's template (`GATEWAY_SECRET`) and
   restarts the container.
3. The card turns green when a signed probe is accepted (the games status page's
   `probeSecret`, generalised).

**Rotate** issues a new secret; the card shows "secret not accepted" until the
container has the new one. `GAMES_GATEWAY_SECRET` and `VIDEO_GATEWAY_SECRET` in
home's environment keep working and win over a paired secret, so existing installs
change nothing.

## Backups

Metadata and databases only — never media files, never a container's caches.

- **Contract.** Every container answers `GET <prefix>/api/admin/backup` for the
  `admin` role: a consistent snapshot of its whole SQLite database as the body
  (`application/vnd.sqlite3`; better-sqlite3's `db.serialize()` is one), and
  `X-Isputnik-Backup-Version` with its own version. Nothing else is in it.
- **Home.** A full or minimal backup asks every paired container for it, signed
  like any request, as the admin who started it or — for a scheduled run — as
  `system:backup` with the `admin` role, and stores each answer in its zip as
  `apps/<id>.sqlite`. `backup.json` gains `apps: { <id>: { included, bytes,
  version } | { included: false, reason } }`. The quick database copy stays
  home's alone.
- **A container that does not answer** (down, unpaired, too old to have the
  route) is left out, the backup still finishes, and the activity log line says
  which one was missing and why.
- **Restore.** Home's restore ignores `apps/`. Sending a container its database
  back is a later step, from Apps → Installed, because the container may be on
  another version or down.

## Logs and events

Unchanged from games: pull, never push. The container keeps an `events` table and a
log ring buffer; home reads them through the gateway with the admin's own session
and stores nothing of them. The Events and Logs tabs are the games Settings tab's
two panels, generalised with a picker (shown once there is a second container).

## Video

### Home's side

- **Library type `video`, remote.** `libraries.type` is app-enforced, so the type
  needs no migration. The type registry (`modules/library/shared/library-types.ts`)
  gains a *remote* marker, and everything that touches files skips remote
  libraries: home's scanner, `validateLibrarySource` (the folder exists on the
  engine, not here), storage rooms, thumbnails, trash, backups of media, duplicate
  and missing-file checks. `source_path` holds the engine's path (`/media/Shows`).
  `library_items` stays empty for video: the items live in the engine.
- **Add library → Video.** The dialog's folder picker asks the engine
  (`/api/admin/folders`); Save writes home's row and calls `PUT
  /api/admin/libraries/:id`. Rename, settings and delete do the same. While the
  engine is offline the type is offered but Save says why it cannot finish.
- **Libraries page.** Video libraries are listed with the rest; their counts, size,
  scan state and errors come from the engine (`/api/admin/libraries`), and Scan
  now calls it. Engine offline → the row says so and keeps its access editor.
- **Maintenance → Tasks** shows the engine's jobs beside home's.
- **Screens.** `features/video/` in the web app, loaded on demand: Shows and Movies
  browse pages on `LibraryPageHeader`/`LibraryPageToolbar` (Filter · Sort · View,
  libraries as a filter facet, the A–Z strip from the engine's `letters` facet),
  the show page with seasons and episodes, the movie page, and the player. Same
  i18n keys file, same conventions; `npm run check:ui` covers them.
- **Menu and For you.** A Video entry (section `video`); Continue watching and Next
  up cards from the engine's `/api/summary`. Global search asks `/video/api/search`
  and merges what comes back.
- **Engine offline.** The video pages say "Video is not available right now" in a
  `MessageBox`; nothing else in home is affected.

### The engine — isputnik.video

A repository and image of its own, shaped like `isputnik.games`: Fastify + SQLite,
**no front end**, port 4300, `/config` for its database and caches, the video
folders mounted read-only (`/media` → e.g. `/mnt/user/data/video`), Unraid
template with no port (Network preset "isputnik", or `br0` with a fixed IP on the
owner's server), `GATEWAY_SECRET` masked. A CPU limit can be set on it in Unraid
without touching home.

**Catalog**

- **Layout:** `Show (Year)/Season NN/…SxxEyy…` and `Movie (Year)/…`, with an
  optional `[imdbid-tt…]` / `[tmdbid-…]` tag in the folder name — the layout
  Jellyfin and Kodi use, so a library moves between them unchanged.
- **Metadata:** `.nfo` files first (tvshow, season, episode, movie), then TMDB for
  what is missing (the owner's API key, a setting stored in the engine and edited
  from the Video library's settings in home). Posters, backdrops and stills cached
  under `/config`, served at `/video/api/art/…`.
- **Fix match:** a manager searches TMDB and picks the right show from the show
  page in home; the choice is kept and wins over the scan.
- **Scan:** on library creation, on a schedule, on demand. A folder still growing
  (a copy in progress) is skipped until its size stops changing, so a half-copied
  show is never catalogued as a pile of movies.
- **Progress:** watch position, watched marks, Continue watching, Next up — per
  home user id.

**Playback**

The engine decides per file and per browser (home's player sends what it can
decode):

1. **Direct play** — the browser decodes the container, video and audio: the file
   is served with range support.
2. **Remux** — the video decodes but the container or audio does not (MKV,
   AC3/DTS): ffmpeg copies the video into HLS segments and converts only the audio
   to AAC. Cheap; most of the owner's files land here.
3. **Transcode** — the video itself does not decode (HEVC in most browsers): full
   re-encode to H.264 HLS, CPU at first.

**As built (engine 0.3.0):** the choice is made per file from ffprobe
(`src/delivery.ts`), not yet per browser. Direct is MP4 with 8-bit H.264 or WebM,
with AAC/MP3/Opus/Vorbis/FLAC sound; everything else is HLS in MPEG-TS
segments (Safari natively, hls.js elsewhere). The playlist is the whole film
up front, so the player knows the length and seeks anywhere. Cuts fall on the
file's own keyframes when the picture is copied (read once with ffprobe and kept
in `media_probe`), or on a 6 s grid with keyframes forced onto it when it is
re-encoded, and timestamps stay the file's own, so a run started after a seek
lines up with the segments before it. One ffmpeg run per person and film; it
stops 30 segments ahead and restarts where the player gets to; a session idle
for a minute, or one whose player sends `DELETE /hls/:id`, is stopped and its
segments deleted (`src/hls.ts`). Sound tracks (engine 0.4.0): `/play?audio=<index>`
lists them and picks one; the HLS address carries it (`/hls/:id/t<index>/…`), and a
file with more than one never plays direct, since no browser lets a page choose
among them. The player remembers the language last chosen, per browser. Since engine 0.7.0 a person converts one film at a time (a second is refused, never
taken over, so two screens on one account can't stop each other in turn). Not yet:
HEVC copied for the browsers that decode it, hardware encoding.

Audio track choice (dubs), subtitles (text converted to WebVTT, image subtitles
burned in), resume, next episode. Seeking inside a transcode restarts it at the new
point. One transcode per member at a time and a household cap, so a TV and two
phones cannot stall the box.

Bytes go browser → home → engine. `@fastify/http-proxy` streams rather than
buffers; the gateway's timeouts and body limit must not apply to `watch`
responses. Measured in V2 before anything else is considered.

**Later clients** (routes in the engine, tokens checked by home's gateway)

- **Stremio add-on** — manifest, catalog, meta, stream and subtitle routes under
  `/video/stremio/<token>/`; ids `isputnik:<id>`, never IMDb ids, so Stremio's
  Cinemeta is not told what the family watches; art from this server; `devices`
  at Home network only by default. The TV plays the original file itself, no
  transcode. Stremio keeps its own progress — the protocol never reports back.
- **Kodi / WebDAV** — a read-only view of the libraries with their `.nfo` files and
  posters, Basic auth with a `video-webdav` token.
- **Hardware transcoding** — Intel Quick Sync or NVIDIA passed into the container.

## Phases

| Phase | Where | What |
|---|---|---|
| **0** | home | `modules/apps/` registry and shared gateway; games moved onto it with no behaviour change; the Apps group with Installed, Events and Logs (the Settings → Games content); alias for the old address; budget raised to seven in `nav.ts` and CLAUDE.md |
| **1** | home | Access: `assignments` for containers, the new identity headers (`X-Isputnik-Libraries` included), network rules per capability, the manifest; games publishes a manifest |
| **2** | home | Pairing: `app_pairings`, Setup tab, rotate; env secrets keep winning |
| **V1** | engine | repository, image, Unraid template; health, manifest, admin, folders and library calls; catalog scan with `.nfo` + TMDB; art; progress store |
| **V1** | home | remote library type `video`; Add library → Video, Libraries page and Tasks from the engine; Video menu entry; browse, show and movie pages (no player yet) |
| **V2** | both | the player: direct play, remux, transcode; tracks, subtitles, resume; Continue watching on For you; search. **Step 1 built (engine 0.2.0, home 4.39.0):** direct play with byte ranges, per-person progress and resume, next episode, Continue watching. **Step 2 built (engine 0.3.0):** remux and transcode to HLS, the sound converted to AAC. **Step 3 built (engine 0.6.0):** subtitles — text tracks inside the file and SRT/ASS/VTT files beside it served as WebVTT (`/subtitles/:id/:track.vtt`, under `watch`), image tracks (PGS, DVD) burned into a transcode (`/hls/:id/t<a>b<s>/…`); the player's Subtitles menu remembers the language per browser. Posters and TMDB built in the same engine release (`metadata.ts`): art beside the files first, TMDB with the admin's key (Apps → Installed), Fix match on a title's page |
| **3** | home | token routes through the gateway; Profile → Devices for container tokens |
| **V3** | engine | Stremio add-on |
| **V4** | engine | WebDAV for Kodi; hardware transcoding |

Phases 0–2 are worth doing for games alone. V1 starts once phase 1 has landed.

## Open points

- **Tags, collections, bookmarks for video.** Home would keep references like
  `video:<itemId>` and ask the engine for titles and art when it shows them.
  Possible; not before V2 has been used.
- **Security events into home.** Mirroring an engine's refused requests into home's
  security alerts means the engine calling home, which the contract has avoided.
- **Secret rotation without a gap.** Accepting the previous secret for a short
  overlap would let rotation happen without a "not accepted" moment.
- **Guest links for video** ("share this one film for 48 hours"), on the same idea
  as games guests.
- **Vega OS Fire TVs** cannot sideload; a client there means the Amazon Appstore.
