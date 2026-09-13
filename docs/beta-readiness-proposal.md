# Beta Readiness Proposal

Status: proposal, 2026-09-11, reviewed at `main@3b65e6c9` (release 3.90.0). Nothing in
this document has been applied. It is the output of a deep review run ahead of moving the
project from "experimental" to **Beta**: five independent passes (server code, web code,
CSS, orphaned files and dependencies, release engineering) plus spot verification of every
Critical/High claim against the working tree. Evidence is given as `path:line` so each item
can be checked and turned into a ticket on its own.

Sizes at review time: server 249 TS files / 69.7k lines, web 318 TS/TSX files / 81.6k lines
(vendor excluded), CSS 48 files / 38.4k lines, 175 server + 36 web test files, 1,112 tracked
files, 371 changelog entries.

---

## 1. Summary

**The codebase is in better shape than its size suggests.** Strict TypeScript is clean in
both workspaces, there are zero `any`, `@ts-ignore`, `console.log` (web) or `TODO` markers
of note, every module exposes one plugin from `index.ts`, `core/` never imports `modules/`,
CSRF/CSP/rate-limits/MFA/SSRF pinning are all shipped, the repo tracks no build output or
secrets, and `check:ui` passes. Only **one** source file in each workspace is unreachable.

**What actually blocks a Beta** is a short list of user-visible defects and ops gaps, not
the structural debt:

| # | Finding | Where | Sev |
|---|---|---|---|
| 1 | Global error handler sends **500 for every Fastify-generated error**: rate-limit 429, body-limit 413, malformed JSON 400 all reach clients as "Unexpected server error" and are logged at `error` | `apps/server/src/index.ts:276-279` | **Critical** |
| 2 | Guest share links run **sharp outside `renderInTurn`** on an unauthenticated path; two concurrent loads of one bad image can kill the process (the documented 0xC0000409 crash) | `modules/library/shared/shares.ts:761-767, 830, 2105` | High |
| 3 | **No SIGTERM handler**: `docker stop` kills workers mid-unit, the seven `onClose` hooks never run | `apps/server/src/index.ts` (no handler) | High |
| 4 | **No health endpoint and no `HEALTHCHECK`** anywhere | Dockerfile, compose, template | High |
| 5 | **Docker publish is not gated on tests** — a red `test.yml` on the release commit still ships `latest` | `.github/workflows/docker.yml` | High |
| 6 | `docs/rollback.md` promises an "automatic pre-upgrade backup" that **does not exist** in code, and hard-codes 3.9.0 | `docs/rollback.md` | High |
| 7 | `shared/Modal` has **no focus trap** and every open modal handles Escape, so Escape in a nested ConfirmDialog also closes the editor under it and discards the form | `apps/web/src/shared/Modal.tsx:54-60` | High |
| 8 | PWA **precaches 4.4 MB** on first visit (168 entries incl. the Russian bundle, the whole control panel, leaflet) | `apps/web/vite.config.ts:151` | High |
| 9 | `datetime(column)` in WHERE/ORDER BY at **138 sites** turns index searches into full scans on `activity_logs`, `login_attempts` (every login), `sessions`, and the job-claim polls | `core/security.ts`, `core/dashboard.ts`, `maintenance/index.ts`, … | High |
| 10 | Category delete bypasses `ConfirmDialog` (an explicit CLAUDE.md rule); slideshow music deletes on one click | `CategoriesSection.tsx:428-433, 587-600`, `MusicPicker.tsx:105` | High |

Everything else in this document is ordered debt: files to split, duplication to fold,
tooling to add, dead files to remove, docs to refresh. Section 2 is the gate; sections 3–11
are the detail; section 12 is a suggested sequence.

---

## 2. Beta gate

Effort: S = half a day or less, M = up to two days, L = more.

### 2.1 Must (before the Beta tag)

| # | Action | Effort | Detail |
|---|---|---|---|
| M1 | Fix the global error handler to honour `error.statusCode < 500` and `error.validation`; log those at `warn`; add a test that trips `@fastify/rate-limit` and asserts 429 | S | §3.1 |
| M2 | Queue `stripImageMetadata` through `renderInTurn` (or cache stripped bytes per item + mtime) | S | §3.2 |
| M3 | `SIGTERM`/`SIGINT` → `app.close()` with a 10 s hard-exit timer; `stop_grace_period: 30s` in compose | S | §9.2 |
| M4 | Unauthenticated `GET /api/health` (`SELECT 1`, `{ ok, version }`) + `HEALTHCHECK` in Dockerfile, compose, Unraid template | S | §9.2 |
| M5 | Gate the Docker publish on green tests (`needs:` in one workflow, or the release step waits for `test.yml`); add branch protection | S | §9.1 |
| M6 | Rewrite `docs/rollback.md` generically, and either implement a boot-time `.sqlite` quick copy when the booted version changes (recommended, the 3.89.0 copy kind is the primitive) or delete the claim | S | §9.4 |
| M7 | `shared/Modal`: portal, modal stack (only the topmost handles Escape/backdrop), focus trap, initial focus, focus restore, `inert` on the app root; add `Modal.test.tsx` + `ConfirmDialog.test.tsx` | M | §3.5 |
| M8 | Trim the PWA precache with `globIgnores` (ru, ControlPanelPage, leaflet, chart, non-shell route chunks); lazy-load the 24 control-panel sections; import `chart.js` with explicit registration | S | §7.2 |
| M9 | Route category delete and music-track delete through `ConfirmDialog` | S | §3.6 |
| M10 | Sweep `datetime(column)` out of WHERE/ORDER BY (compare raw ISO strings); start with `core/security.ts`, `core/dashboard.ts`, job claims | M | §7.1 |
| M11 | Narrow the `uncaughtException` handler to the known FileHandle class; otherwise log and `process.exit(1)` so Docker restarts | S | §3.3 |
| M12 | Beta labelling pass: version `4.0.0` + `"stage": "beta"` in root `package.json` surfaced in About / README / Unraid Overview; touch every "experimental" line (table in §10.2); changelog entry; first GitHub Release | M | §10 |
| M13 | README refresh: quick-start compose, requirements (amd64 only, RAM for faces), 2–3 screenshots from `docs/users/images`, feature list synced with the 20 guides | M | §10.3 |
| M14 | Configuration reference (23 env vars, defaults, where they apply); align `COOKIE_SECURE` default to `auto` in the Dockerfile | S | §9.3 |
| M15 | Replace the two raw NUL bytes with `"\u0000"` escapes (`PhotoInboxPage.tsx:461`, `LayoutStep.tsx:104`) so git/grep stop treating those files as binary | S | §8.1 |
| M16 | Fix the flaky `backup-kinds.test.ts:120` timeout (`testTimeout: 15000` in the server vitest config) | S | §9.6 |

### 2.2 Should (Beta.1 → Beta.2)

| # | Action | Effort | Detail |
|---|---|---|---|
| S1 | Tooling: ESLint (typescript-eslint recommended + react-hooks), `.editorconfig`, `* text=auto eol=lf`; turn on `noUnusedLocals`/`noUnusedParameters` in both tsconfigs (16 server + 48 web fixes) | M | §6.4 |
| S2 | `parseQuery(schema, request.query)` twin of `parseBody`, applied to the 58 `request.query as` sites (repeated query keys become arrays → TypeError → 500 today) | M | §3.4 |
| S3 | Media-type registry in `library/shared` so `trash.ts`, `scan-rules-routes.ts`, `storage-move.ts`, `maintenance/index.ts` stop importing every scanner; breaks the 17-file import cycle | M | §4.1 |
| S4 | Move `audiobook/categorize.ts` → `library/shared/tagging.ts`; move `core/dashboard.ts` + `core/home-location.ts` → `modules/dashboard/`; break the `shares.ts` ⇄ `stories/share.ts` cycle; stop importing `*routes.ts` files for helpers | M | §4.2–4.4 |
| S5 | Split the four largest server files (`shares.ts`, `audiobook/scanner.ts`, `duplicates/job-scan.ts`, `slideshow-render.ts`) per §5.1 | L | §5.1 |
| S6 | Web: collapse AudiobooksPage/EbooksPage into one `CatalogPage`; extract `usePlayback` + `PlayerControls` so `SharePage` stops re-implementing the player; split `GalleryPage.tsx` into `features/gallery/page/` | L | §5.2, §6.1 |
| S7 | Shared web helpers: `useDebouncedValue`, `useAnchoredMenu`, `cx()`, one `formatClock`, one `timeAgo` with i18n; `SessionContext` instead of threading `logout` through 48 props | M | §6.1 |
| S8 | CSS: delete 53 dead classes; define or remove `--surface-2`/`--accent`/`--error`; fix the `min-width: 700px/620px` overlaps; z-index scale; promote the five most-duplicated blocks to `components/` | M | §6.3, §7.3 |
| S9 | Tests: SSRF layer (`core/safe-fetch.ts`, `shared/remote-image.ts`), upload primitive incl. public `/drop/:token`, CSRF negatives, migration walk (v32 baseline → 74 == fresh `schema.sql`), duplicate `job-routes` | L | §8 |
| S10 | Orphans: delete `LibraryCoreFields.tsx`, the 5 unreferenced brand files under `apps/web/public/Assets/brand/`, `scripts/reshape-boxset.mjs`, the empty `library` locale namespace, the 144 unused locale keys, the 31 orphan en keys; archive 19 shipped plan/proposal docs to `docs/archive/` | S | §8 |
| S11 | Move web `vite` and `@vitejs/plugin-react` to devDependencies; add `engines.node >= 26` + `.nvmrc`; bump `@types/node` to 26; drop `@types/svg-maps__common` | S | §8.5 |
| S12 | Docker log rotation in compose; `LOG_LEVEL` env; pino instance for the 24 `console.*` worker sites | S | §9.5 |
| S13 | i18n tail: `App.tsx:301-313`, `GuidePage.tsx:116,121`, `HelpPage.tsx:232-233`, `ProfilePage.tsx:273-275`, `AudioPlayer.tsx:791,792,955`, the English helpers in `shared/utils.ts:73-124`, `feed.ts:104`, `phrasing.ts:110`, `api.ts:117,172` | S | §6.2 |
| S14 | Docs: `architecture.md` + `database.md` status and structure refresh; fix the changelog-file pointer; `css-map.md` (7 missing files, five themes not two); `CONTRIBUTING.md` ("without migrations" is false); `AGENTS.md` → pointer to `CLAUDE.md`; `docs/users/README.md` missing 5 guides | M | §10.4 |
| S15 | `CHANGELOG.md` rendered from `changelog.ts` at release + GitHub Releases per tag; in-app "what changed since your last visit" indicator | S | §10.1 |
| S16 | PII note (IP retention, request logs) in the control-panel guide; SECURITY.md accepted-risk list + `security.txt` link; `DEVICE_SESSION_DAYS` in template | S | §11 |

### 2.3 Later (post-Beta)

Multi-arch image (or document amd64-only); one shared job poller replacing 8 `setInterval`
loops; prepared-statement reuse in scanners; `db/rows.ts` per-table row types replacing 607
inline row casts; `migrate.ts` → one file per migration and a Beta baseline fold;
`changelog.ts` out of the TS compile; route-split page-only CSS; Sputnik theme forks isolated;
`Button` variants for toolbar/tab/tile so the raw-`<button>` count (588) can be linted down;
web tests for `familytree/`, `collections/`, browse toolbar; shared `bootApp()` test helper;
type/spacing tokens.

---

## 3. Correctness and robustness

### 3.1 Critical — every Fastify-generated error becomes a 500 (server)

```ts
// apps/server/src/index.ts:276-279
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Unexpected server error" });
});
```

`@fastify/rate-limit` delivers its verdict by throwing an error with `statusCode = 429`, so
it lands here. Reproduced with the repo's own `node_modules` (scratchpad
`errhandler-demo.mjs`): the second request under `max: 1` → `500`, a body over `bodyLimit`
→ `500` (should be 413), malformed JSON → `500` (should be 400). Consequences:

- The global limiter (`index.ts:127-135`) and the `max: 10` on `/api/auth/login`
  (`core/auth-routes.ts:28`) are invisible to clients: no 429, no `retry-after`, the web
  app cannot back off.
- Every rate-limited request of an abuse sweep is logged at `error`, so the limiter turns
  abuse into log flooding.
- The 32 MiB GEDCOM cap (`familytree/routes.ts:304`) and 8 MiB quotes cap
  (`quotes-import.ts:165`) surface as "Unexpected server error".
- The three tests asserting 429 exercise the manual lockout in `mfa-routes`/`webauthn-routes`,
  not the plugin, which is why this survived.

Fix (~20 lines): if `error.statusCode` is set and below 500, send `{ error: error.message }`
with that status and log at `warn`; handle `error.validation`; keep the 500 path for the
rest. While there, fold the six look-alike `*Error { statusCode }` classes (`UploadError`,
`TrashError` at `shared/trash.ts:213`, `AppStorageError` at `app-storage.ts:53`,
`AppStorageContentsError`, `FolderMoveError` at `gallery/folder-move.ts:30`,
`RecordingError`) under one `core/http-error.ts` base so the ≥12 `instanceof` ladders at
route sites disappear.

### 3.2 High — sharp on the guest path outside `renderInTurn` (server)

CLAUDE.md: "Never render two images at once … Queue renders through `renderInTurn()`".
`renderInTurn` is used by the three scanners and `media.ts` only. The guest share routes
decode originals per request:

```
shares.ts:761  const probe = await sharp(absolutePath, { failOn: "none" }).metadata();
shares.ts:767  const pipeline = sharp(absolutePath, { failOn: "none", animated }).rotate();
shares.ts:830  const stripped = await stripImageMetadata(opts.absolutePath);   // /api/share/:token/file
shares.ts:2105 const stripped = await stripImageMetadata(filePath);            // /api/share/:token/items/:itemId/file
```

Two guests, or one browser prefetching a grid of full-size images, hitting the same
undecodable file concurrently is the libvips race that exits the process with 0xC0000409 and
no log line, reachable **unauthenticated**. Also outside the queue but serial by
construction (fine): `slideshow-title-card.ts:330`, `duplicates/inbox-rescans.ts:194`,
`faces/arcface.ts:295`. Fix: wrap in `renderInTurn`, or cache stripped bytes under the
thumbnail store keyed by `(itemId, mtime)` so an original is decoded once per share.

### 3.3 High — `uncaughtException` keeps the process alive after any error (server)

`index.ts:288` is unconditional. The motivating case (exifr FileHandle GC on Node 24+) is
fixed at `gallery/media.ts:161`. A synchronous throw from one of the 13 `setInterval`
workers leaves a job row at `running` with no worker behind it until the next boot's
recovery pass, and nothing restarts. Narrow it to the known class; otherwise log and
`process.exit(1)`.

### 3.4 Medium — unvalidated query strings (server)

Fastify parses `?url=a&url=b` into an array. 58 sites cast `request.query as { x?: string }`
and call string methods (`metadata-routes.ts:74`, `books-routes.ts:251`,
`ebook/bookmarks.ts:54`, `gallery/routes.ts:327`, …). `.trim` on an array is a `TypeError`,
which §3.1 turns into a logged 500. `core/dashboard.ts:871` already shows the
`parseBody(schema, request.query)` pattern; a `parseQuery` with `z.coerce` applied
mechanically closes all 58.

### 3.5 High — `shared/Modal` dismissal and focus (web)

Every `Modal` adds its own `document` keydown listener (`Modal.tsx:54-60`). A
`ConfirmDialog` rendered inside an open panel modal (`PersonProfileModal.tsx:453/801`,
`DropLinksModal.tsx:130/250`, `StoryCollectionFormModal.tsx:116/247`, `LibrariesSection`,
`SeriesDetailPage`, `LayoutPanel`, `GalleryPage`) means one Escape fires both: the confirm
cancels **and the editor closes, discarding its form**. Only `busy` blocks it. There is also
no `createPortal`, no focus trap, no initial focus (only `ConfirmDialog` sets `autoFocus`),
no focus restore, no `inert` on the page behind — `aria-modal="true"` is set but not kept.
Every convention in `docs/UI-CONVENTIONS.md` rests on this primitive and it has no test.

### 3.6 High — destructive actions outside `ConfirmDialog` (web)

- `CategoriesSection.tsx:313, 428-433, 587-600`: category delete is a two-click inline
  state with raw buttons; the second click deletes and moves N books.
- `MusicPicker.tsx:105-116` ← `:137`: an uploaded slideshow music track is deleted on one
  click.

The other 22 files calling `DELETE` without `ConfirmDialog` are true Remove/Revoke/Unlike
(no data loss) and are fine.

### 3.7 Medium and Low (both apps)

- ~120 web effects fetch without a cancel guard (33 use a flag, 2 use `AbortController`);
  the `queryKey` guard in `useAudiobookCatalog.ts:145-165` is the good pattern. Risk is a
  stale response winning a race after a filter change.
- `CategoriesSection.tsx:351-354` `loadAliases` awaits with no `try` and is called unawaited
  → unhandled rejection, nothing shown.
- `localStorage` without try/catch: `PageSizeMenu.tsx:16,23`, `AudioPlayer.tsx:360,362`
  (the other 30 sites are guarded).
- Server CPU on the event loop inside handlers: `importGedcom` parses up to 32 MiB
  synchronously (`familytree/routes.ts:304-309`); `adm-zip` reads whole EPUBs synchronously
  in the scan job; `core/compression.ts:66-74` compresses every response synchronously
  (measured, documented, acceptable — but it doubles the cost of the unpaginated endpoints
  in §7.1).
- Sync fs in request handlers on library roots (`gallery/routes.ts` 8 calls,
  `audiobook/source-routes.ts` 7, `slideshow-routes.ts` 5, `ebook/routes.ts` 5): on SMB/NFS
  mounts a `statSync` can stall every concurrent request.
- `audiobook/scanner.ts:847-863`: unbounded `Promise.all` recursion over every subdirectory;
  a small semaphore prevents EMFILE on large NAS trees.
- 279 `request.user!` assertions rely on the `preHandler` being present; a `requireUser()`
  helper makes the omission a compile error (none found today).
- Five `<tr onClick>` dashboard rows (`LocationsView.tsx:305,396`, `SystemView.tsx:166`,
  `TasksView.tsx:228`, `SecuritySection.tsx:516`) are not keyboard-reachable.
- `<img>` without `alt`: `GalleryLightbox.tsx:245,272`, `ForYouPage.tsx:27`.

**Verified safe:** job claims are atomic with `changes === 0 → continue`; every queue has a
re-entrancy guard; `exifr.parse` is fed a Buffer; streams are destroyed on client close;
all 47 interpolated SQL fragments are internal; `pathIsInside` guards 71 sites;
`DOMPurify` is applied at both `dangerouslySetInnerHTML` sites; icon buttons all carry
`aria-label`; web `console.log`/`TODO`/`@ts-ignore` are all zero.

---

## 4. Architecture

### 4.1 High — a 17-file import cycle around `library/shared/trash.ts` (server)

```
shared/trash.ts:29  import { rescanSingleBook } from "../audiobook/scanner.js";
shared/trash.ts:30  import { enqueueEbookScan, processEbookScanQueue } from "../ebook/scanner.js";
shared/trash.ts:31  import { enqueueGalleryScan, processGalleryScanQueue } from "../gallery/scanner.js";
shared/trash.ts:32  import { faceCropKeysForItem, removeFaceCropFiles } from "../gallery/faces/crop-files.js";
gallery/scanner.ts → duplicates/inbox-check.ts → duplicates/job-scan.ts → shared/trash.ts   (closes)
shared/storage-move.ts ⇄ shared/trash-move.ts ; storage-move.ts ⇄ gallery/folder-move.ts
gallery/voice-notes.ts → gallery/routes.ts → gallery/voice-notes.ts (via catalog.ts)
```

Members: `gallery/{catalog,cleanup,folder-move,people,replace,replaced,routes,scanner,voice-notes}.ts`,
`gallery/duplicates/{folders,inbox-check,items,job-scan,jobs}.ts`,
`shared/{storage-move,trash,trash-move}.ts`. ESM tolerates it only because every member uses
its imports lazily inside functions; the first top-level read of an imported binding makes
boot order decide whether it is `undefined`. It also means the "type-agnostic trash engine"
cannot be unit-tested without loading all three scanners.

**Fix (pattern already in the repo):** `core/status-contributors.ts` is a registry modules
push into. Add `library/shared/media-types.ts` with
`registerMediaType({ type, rescanItem, enqueueScan, processQueue, cropKeysForItem })`, called
from each `library/<type>/index.ts`. `trash.ts`, `scan-rules-routes.ts`, `storage-move.ts`
and `maintenance/index.ts` (which imports 7 type files) then depend on the registry only —
and `docs/architecture.md:24` ("adding a new library type does not touch existing code")
becomes true. Today a new type must edit at least nine files (`trash.ts`,
`scan-rules-routes.ts`, `storage-move.ts`, `shares.ts:31`, `library/tags.ts:9-16`,
`maintenance/index.ts`, `collections/cleanup`, `stories/cleanup`, `library/index.ts`).

### 4.2 High — `shares.ts` ⇄ `stories/share.ts`, and shared code importing route files

`shares.ts:25-27` imports `stories/share.js`, `stories/audio.js` and **`stories/routes.js`**
(for `sendNarration`); `stories/share.ts:25` imports back. The guest-link engine for every
module should not know stories exist; `stories/share.ts` should register a share kind.
Two more places import a routes file for a helper: `stories/recordings.ts:19` and
`gallery/voice-notes.ts` both pull from `gallery/routes.ts:48-89`
(`uniqueGalleryFileName`, `dateFolderForCapture`, `friendlyStorageError`) → move to
`gallery/files.ts`.

### 4.3 High — `core/dashboard.ts` (912 lines) is product logic

CLAUDE.md: core is "things every feature depends on with no product knowledge". The file
hard-codes event names (`'library.gallery.uploaded'`, `'library.audiobook.played'`, lines
27-46) and joins `playback_progress` (`:877`). Its only importer is `core/index.ts:11`.
Proposal: `modules/dashboard/{index,activity,signins,in-progress,locations-routes}.ts`;
`core/home-location.ts` goes with it; `core/geoip.ts` stays (security/logs use it).
Related, lower: `core/app-storage.ts:25-31` hard-codes the room list including
"Photo Inbox"; a `registerAppRoom()` from each module would keep core ignorant of it.

### 4.4 High — the cross-type tags engine lives under `audiobook/`

`audiobook/categorize.ts` (`addEntityTags`, `setEntityTags`, `entityTagsByIds`) is imported
by 14 non-audiobook files (familytree ×2, stories ×2, gallery ×5, library ×4, ebook ×1).
This is the cross-type taggables engine CLAUDE.md says every new type must join; it belongs
in `library/shared/tagging.ts`. Same shape, smaller: `audiobook/book-helpers.ts`
(`coverUrl`, `upsertAuthor`, `mapBookListRow`) is imported by `ebook/catalog.ts`,
`library/categories.ts`, `library/works.ts` → `library/shared/book-*.ts`.

### 4.5 Medium — bidirectional module pairs

`backups ⇄ maintenance`, `social ⇄ stories`, `library ⇄ familytree`, `library ⇄ stories`;
`stories` reaches into `gallery` 12 times (`house-library`, `slideshow-render`, `routes`).
Not file cycles yet, each one refactor away from §4.1. `house-library.ts` and the
"write a file into the house library" primitive belong in `library/shared`.

### 4.6 Web structure

No `createContext` anywhere; `logout` is threaded through `App.tsx` 48 times and 36 files
declare `logout: () => Promise<void>` as a prop. A `SessionContext` (user, logout,
`isAdminSession`) deletes ~100 prop lines. `pages/` vs `features/` follows the documented
rule except `pages/StoryShareView.tsx` (727 lines, a stories feature) and the six feed-card
components inside `pages/HomePage.tsx` that belong in `features/home/cards/`. There is no
per-feature endpoint layer: 396 `api<…>("/api/…")` calls re-type the URL and response shape
at each call site (`EBOOK_ENDPOINTS` at `EbooksPage.tsx:48` and `ITEM_LINK_API` at
`SendToSheet.tsx:100` are the seeds of the right pattern); `src/api.ts` itself is 181 lines
and fine.

---

## 5. Files that are too big — split plan

Every split below follows a precedent that already exists in the repo, so no new folder
idiom is introduced. Line ranges are today's.

### 5.1 Server

Precedents: `gallery/album-routes.ts` + `albums.ts`; `gallery/slideshow-routes.ts` +
`slideshows.ts` + `slideshow-render.ts` + `slideshow-title-card.ts`;
`gallery/duplicates/{job-routes,job-scan,job-review,job-resolve,jobs}.ts`;
`gallery/people.ts` + `people-routes.ts`; `audiobook/providers/*.ts`;
`familytree/{persons,relations,events,sources,photos,gedcom}.ts`.

| File | Lines | Proposed split |
|---|---|---|
| `library/shared/shares.ts` | 2,328 · 32 routes | `shares/grants.ts` (159-298) · `gallery-set-shares.ts` (392-520) · `album-shares.ts` (521-660) · `serve.ts` (`sendThumbnail`/`sendFile`/`stripImageMetadata`, 691-849) · `manage-routes.ts` (`/api/shares/*`, `/api/shared-with-me`, 853-1750) · `guest-routes.ts` (`/api/share/:token/*`, 1751-2328). Story pieces (1009-1082, 2129-2166) return to `stories/share.ts` via the share-kind registry |
| `library/audiobook/scanner.ts` | 1,971 | `folder-parse.ts` (104-320; `test/audiobook-folder-parse.test.ts` already names it) · `tag-read.ts` (321-480, 616-680) · `sidecar.ts` (516-615, 1027-1078) · `covers.ts` (680-801) · `walk.ts` (802-1026) · `prepare.ts` (`prepareBookScan`, 1079-1404) · `write.ts` (`writeBookScan`, 1428-1610) · `scanner.ts` keeps queue + worker (1611-1971) |
| `gallery/duplicates/job-scan.ts` | 1,726 | One file per tier as `docs/duplicate-detection.md` names them: `snapshot-photo-sets` (217-297), `snapshot-near` (330-486), `snapshot-inbox` (487-620), `snapshot-folders` (621-739), `snapshot-contained` (740-974), `snapshot-overlaps` (975-1146); orchestrator stays (1147-1357); read side → `job-results.ts` (1358-1726) |
| `gallery/slideshow-render.ts` | 1,462 | `segments.ts` (85-335, 604-619) · `ffmpeg-args.ts` (335-533, 734-815) · `prescale.ts` (534-603; a test exists) · `probe.ts` (620-679) · `render.ts` (680-1064) · `movie-files.ts` (1065-1293) · `render-queue.ts` (1309-1462) |
| `audiobook/enrich.ts` | 1,342 | Book lookup stays (32-218); `providers/wikidata.ts` (283-469), `providers/wikipedia.ts` (470-575, 666-724), `person-lookup.ts` (611-1205), `person-photo.ts` (1206-1238); `enrich.ts` keeps `enrichPerson`/`enrichLibraryAuthors` |
| `gallery/duplicates/items.ts` | 1,248 | `hashing.ts` (130-290) · `details.ts` (291-352) · `keeper.ts` (353-619) · `near.ts` (620-834; `BAND_COUNT`/`withinNearDistance` are unused phase-2 leftovers) · `absorb.ts` (875-1089) · `scan-queue.ts` (1090-1248) |
| `stories/stories.ts` | 1,039 | `access.ts` (177-236) · `crud.ts` (237-543) · `list.ts` (544-705) · `chapters.ts` (706-832) · `blocks.ts` (833-1039) |
| `stories/routes.ts` | 987 · 26 routes | `routes.ts` (308-787) · `audio-routes.ts` (788-844) · `chapter-routes.ts` (845-906) · `block-routes.ts` (907-987) |
| `gallery/routes.ts` | 963 · 33 routes | `library-routes` (112-300) · `upload-routes` (301-436) · `browse-routes` (437-588) · `asset-routes` (589-963) · `files.ts` (48-89); `/api/library/trash/replaced*` (178-214) → `shared/trash-routes.ts` |
| `maintenance/index.ts` | 962 | `jobs-catalog.ts` (57-285) · `scheduler.ts` (286-568) · `tasks-view.ts` (570-868) · `routes.ts` (869-962) · 10-line `index.ts` like every other module |
| `familytree/routes.ts` | 944 · 38 routes | Mirror the domain files: `persons-routes` (176-556), `unions-routes` (557-643), `events-routes` (644-725), `sources-routes` (726-823), `photos-routes` (279-293, 824-872), `editors-routes` (873-944), `gedcom-routes` (294-330) |
| `core/dashboard.ts` | 912 | → `modules/dashboard/` (§4.3) |
| `gallery/catalog.ts` | 908 | `scope.ts` (18-100) · `asset-map.ts` (101-283) · `filters.ts` (284-379) · `browse.ts` (380-710) · `memories.ts` (711-908) |
| `db/migrate.ts` | 890 | 43 migrations inline. `db/migrations/033-*.ts` … each exporting `{ version, up }`, runner ~120 lines. The header says history was folded twice; folding to a new baseline at Beta is a reasonable release step |
| `changelog.ts` | 3,561 | Pure data, 5 % of server source, re-checked by `tsc` on every typecheck. Move to `apps/server/changelog/*.md` or one JSON read at boot; keep TS as the source only if the Markdown escaping is valued (the release reviewer's view). Low priority, high annoyance per release |
| `library/app-storage.ts` | 800 | `rooms.ts` (68-295) · `path.ts` (296-508) · `switch.ts` (509-800) |
| `audiobook/book-helpers.ts` | 788 | `covers.ts` (24-86, 188-254) · `metadata-apply.ts` (87-129, 255-527) · `book-detail.ts` (528-788); shared parts move per §4.4 |
| `library/shared/trash.ts` | 761 | `trash-settings.ts` (41-162, 669-715) · `trash-fs.ts` (163-350) · `trash.ts` (351-668) · `trash-retention.ts` (716-761); scanner imports → registry |
| `audiobook/people.ts` | 761 · 15 routes | `people.ts` (43-330) + `people-routes.ts` (331-761), the exact shape `gallery/people.ts` + `people-routes.ts` already have |

Fine as they are: `core/mfa-routes.ts` (740, one concern), `gallery/duplicates/jobs.ts` (722).

### 5.2 Web

Precedents: `features/control/sections/dashboard/` (12 files, one per view + hooks),
`features/control/sections/duplicates/` (9 files), `features/gallery/review/`,
`features/control/layout/`, `features/audiobooks/reader/`.

| File | Lines | State | Proposed split |
|---|---|---|---|
| `features/gallery/GalleryPage.tsx` | 3,120 | 53 `useState`, 21 effects, 7 inline `<Modal>` + 5 `<ConfirmDialog>` | `features/gallery/page/`: route shell + `useGalleryScope()` (160-470); views `TimelineView` (2344-2560), `PeopleView` (1675-1919), `AlbumsView` (1920-2095), `SlideshowsView` (2096-2278), `MemoriesView` (2279-2343), `FoldersView` (2460-2560) — the data hooks `useGalleryAlbums/People/Slideshows` already exist, the JSX never followed; `useTimeline.ts` (508-570 + poll effect 877-889); `useFolderAdmin.ts` (585-720); the 12 inline dialogs become named modals like the ten already imported |
| `audiobooks/AudiobooksPage.tsx` + `EbooksPage.tsx` | 1,533 + 1,051 | twins; 14 handlers identical modulo one i18n key | One `CatalogPage` over the existing `useMediaCatalog` with a `kind` prop; move `BulkEditModal` (401-538), `AddToSeriesModal` (539-658), `GroupAsEditionsModal` (668-757), `UploadBookModal` (758-836), `CatalogBookCard` (174-378), `CatalogAdminMenu` (80-173) out of the page file (five exported components inside a page is why EbooksPage imports from AudiobooksPage); `useCatalogSelection.ts` (946-1017 ≡ 455-515); `useBookLike.ts` (also fixes the third copy in `CatalogRowMobile.tsx:58-90`) |
| `control/sections/SecuritySection.tsx` | 1,545 | switches on four routes (`:120`), eight interfaces (39-116) | `control/sections/security/{OverviewView,PoliciesView,TrustedNetworksView,BlockedIpsView}.tsx` + `security-types.ts`, as `dashboard/` does |
| `audiobooks/BookDetailPage.tsx` | 1,539 | | `EditionsSwitcher` (148-283), `BookDetailView` (284-1539) to own files; `sendToEreader` (335) is duplicated in `SendToSheet.tsx:235` |
| `familytree/FamilyPersonPage.tsx` | 1,403 | | pure helpers 54-306 → `person-profile.ts` next to `chart-layout.ts`; `RelationCard`/`FamilyRow`/`TimelineIcon` (307-404) → `PersonCards.tsx`; the six tabs (`:50`) one file each |
| `control/sections/RecycleBinSection.tsx` | 1,205 | | `recycle-bin-model.ts` (74-191); retention dialog and empty-bin challenge → separate modals; `formatDay`/`saveRetention`/`confirmPurge` duplicated in `MissingPhotosSection.tsx:28/67/90` |
| `audiobooks/AudioPlayer.tsx` + `pages/SharePage.tsx` | 1,178 + 760 | the share page re-implements the whole player (§6.1 #1) | `usePlayback()` hook + `PlayerControls` consumed by both |
| `audiobooks/reader/EbookReader.tsx` | 1,160 | | `reader-prefs.ts` (84-150), `TocList` (177), `ReaderSettings.tsx` (~560-580) |
| `router.ts` | 870 | | `route-aliases.ts` (76-184) + `route-match.ts` (335-717) + `navigation.ts` (744-870) |
| `pages/HomePage.tsx` | 1,003 | | six feed-card components (33-508) → `features/home/cards/` |
| `control/sections/LibrariesSection.tsx` (997), `EditMetadataModal.tsx` (883), `QuotesPage.tsx` (881), `StorageSection.tsx` (877), `dashboard/SignInsView.tsx` (864), `WelcomePage.tsx` (848), `GalleryLightbox.tsx` (845), `PersonProfileModal.tsx` (814), `social/SendToSheet.tsx` (809), `DuplicateCleanupSection.tsx` (771), `CategoriesSection.tsx` (771) | | Medium/Low; split opportunistically when touched |

### 5.3 CSS

All splits follow section-header comments already in the files and can be barrels in the
same import order (the pattern `components.css` / `duplicates.css` already use).

| File | Lines | Barrel |
|---|---|---|
| `stories.css` | 3,620 | `stories/{index,reading,editor,pickers,narration-and-modals}.css` (headers at 5, 557/653/1922/2037/2245/2457/2552, 840-1418, 1445-1882, 1883/2536/2806/3560) |
| `gallery.css` | 3,544 | `gallery/{browse,lightbox,people,slideshow,photo-picker,inbox}.css` (1-567, 568-1803, 1804-3161 people blocks, 1984/2382/2624/2702/2759/2795, 2049-2381, 3162-end) |
| `home.css` | 2,697 | `home/{shell,feed,mobile,resume-and-quotes}.css`; the 96-rule Sputnik fork (933-1100 and scattered) → `themes/sputnik-home.css` |
| `player.css` | 2,604 | `player/{card,popup,bookmarks}.css` + `themes/sputnik-player.css` (1604-2604: a full 1,000-line re-skin) |
| `admin.css` | 2,487 | `admin/{chrome,libraries,overview,tasks,security}.css` mirroring the 7 nav groups |
| `family-tree.css` | 2,315 | `family-tree/{people,profile,modals,chart,mobile}.css` |
| `library-collections.css` | 2,012 | four unrelated pages: `categories`, `series-people`, `bookmarks-quotes`, `collections`; `.audiobook-grid`/`.audiobook-cover` (811-925, 1483) belong in `library-browse.css` |
| `library-browse.css` | 1,751 | `landing`, `toolbar` (316-740 — the shared `LibraryPageToolbar`/`AlphabetBar` CSS every browse page wears; belongs under `components/`), `catalog-cards`, `mobile`; 283-330, 743-770, 1015-1095 are dead |
| `about.css` | 1,640 | really Profile + Help: `about`, `profile`, `help` |
| `auth.css` (1,098), `social.css` (1,053) | | `auth/{tokens,login,device-link}`, `social/{send-to,inbox,activity}` |

---

## 6. Duplication and style consistency

### 6.1 Web duplication (strongest cases, both locations)

| # | What | Where | Sev |
|---|---|---|---|
| 1 | Whole audio player re-implemented for the public share page: `togglePlay`, `goToPrev/Next`, `handleSeek`, `changeRate`, `toggleMute`, sleep/speed menus, `formatTime`, `RATES`, `SLEEP_MINUTES` | `AudioPlayer.tsx:12,27,31,539-599` ≡ `SharePage.tsx:86,98,101,428-540` | High |
| 2 | Audiobooks ↔ Ebooks pages: 14 handlers identical modulo one i18n key (`runBulk` at 1001 vs 497 differ only in a notice key) | `AudiobooksPage.tsx:209-240, 888-1120` ≡ `EbooksPage.tsx:168-200, 393-640` | High |
| 3 | `toggleLike`/`toggleFinished`/`initialStatus` a third time | `CatalogRowMobile.tsx:12,61,76` | Med |
| 4 | Share-link management (`loadLinks`, `createLink`, `copyUrl`, `revokeLink`, `revokeUser`) | `ShareSetModal.tsx:67-160` ≡ `SendToSheet.tsx:164-300` | Med |
| 5 | `formatDuration` (mm:ss) ×3, shadowing a *different* `formatDuration` ("2 hr 5 min") in shared | `GalleryLightbox.tsx:19`, `GalleryLightboxPanel.tsx:36`, `MusicPicker.tsx:9` vs `shared/utils.ts:70` | Med |
| 6 | `timeAgo` ×2 with **different output** ("5 min ago" vs "5m") plus `relativeTime` in shared | `library/feed.ts:104`, `social/phrasing.ts:110`, `shared/utils.ts:109` | Med |
| 7 | Anchored-dropdown positioning math ×7 | `AudiobooksPage:1108`, `EbooksPage:547`, `GalleryPage:889`, `shared/LibraryMenu:45`, `SortMenu:81`, `ActionMenu:64`, `SelectMenu:52` | Med |
| 8 | Author/Narrator/Series list pages: `matchesLibrary`, `matchesSearch`, `bucketOf`, `orderOf`, `openCreate` | `AuthorListPage:93-113`, `NarratorListPage:83-90`, `SeriesListPage:74-75` | Med |
| 9 | Facet-filter helpers | `BookFilter.tsx:108,124,208` ≡ `GalleryFilter.tsx:85,107,135` | Med |
| 10 | "Add to X / create-and-add" modals ×3 | `AddToCollectionModal:94`, `AddToAlbumModal:52,69`, `AddToSlideshowModal:51,68` | Med |
| 11 | Search debounce hand-rolled with `setTimeout` ×6 | `useAudiobookCatalog:116`, `QuotesPage:473`, `GalleryPage:443-455`, `PhotoPicker:93`, `GalleryKeepModal:82`, `SlideshowMovieLibraryModal:63` | Med |
| 12 | `pageOf` in four dashboard views; `escapeHtml` ×2; retention/purge UI ×2 | `dashboard/*View.tsx`, `StoryMap:103`/`StoryMarkdown:50`, `MissingPhotosSection` ≡ `RecycleBinSection` | Low |

Shared hooks that do not exist and explain the above: `useDebouncedValue`,
`useAnchoredMenu`, `useAsync`/`useQuery`, `useLocalStorage`, `cx()`. `useIsMobile` is the
single media-query hook and is used consistently in 16 files.

### 6.2 Web style and i18n

| Dimension | Finding |
|---|---|
| Buttons | 624 `<button>` tags, **588 outside `shared/`**; 153 wear `primary-button`/`secondary-button`/`icon-button`/`text-button` by hand, 43 have no class. Hotspots: `GalleryPage` 55, `EbookReader` 37, `AudioPlayer` 35. The doc says all buttons render through `<Button>`; extend it with `toolbar`/`tab`/`tile` variants so the checker can eventually forbid raw buttons |
| Async state | ad-hoc `loading/error/busy` triples everywhere; no shared hook |
| Inline `style={{}}` | 101, mostly legitimate (swatches, popover coordinates) |
| `className` joining | 294 template joins, no `cx()`; emits `"card  "` double spaces |
| `eslint-disable` without ESLint | 45 `react-hooks/exhaustive-deps` comments, nothing enforces the other 320 effects |
| Control panel | `BackupSection.tsx:220` hand-rolls the eyebrow/h1; `DuplicateCleanupSection.tsx` has no `ControlSectionHead`; `search-index.ts` `TAB_KEYWORDS` misses `maps` and `storySettings` |
| Verb vocabulary | `PersonProfileModal.tsx:803` "Remove photo" uses `danger` for a detach |
| i18n | 6,643 en / 7,294 ru keys, 0 parity issues, ~97 % swept. Remaining literals: `App.tsx:301,312,313` "Loading isputnik.home...", `GuidePage.tsx:116,121`, `HelpPage.tsx:232-233`, `ProfilePage.tsx:273-275`, `AudioPlayer.tsx:791,792,955`, plus non-JSX helpers returning English (`shared/utils.ts:73-124`, `feed.ts:108-120`, `phrasing.ts:113-118`, `api.ts:117,172`). These are on the first screens a Russian user sees |

Consistent and good: `api<T>()` is used for all non-binary fetches (13 raw `fetch` are all
blob/binary or the session bootstrap); `MessageBox` for errors; 0 hand-rolled modals;
named exports; PascalCase components; 43 of 47 routes lazy-loaded.

### 6.3 CSS duplication and tokens

- **76 identical rule bodies, 44 cross-file**: cover-fill `img` ×15, wrapping flex row
  ×30, single-line truncation ×32 (while `base.css` has `.truncate`), `.sr-only` cloned
  twice, nine hand-rolled dropdown menus with seven different z-indexes, the Logs / Recycle
  bin / Duplicates toolbar-pager triplet ×3, six profile section cards.
- **Tokens used but never defined:** `--surface-2` (15 uses), `--accent` (15 uses, with
  fallbacks that disagree: purple `#6336f5` in `duplicates/job-card.css` vs gold `#c8a24a`
  in `result-card.css`), `--error` (`player.css:727`). 728 hard-coded colours outside
  `tokens.css` (`gallery.css` 139, `home.css` 113, `player.css` 83); roughly half are
  legitimate photo scrims.
- **31 distinct `@media` widths.** 740 px is healthy (×39); 1100 px barely used (×4);
  `min-width: 700px` ×2 (`gallery.css`) and `min-width: 620px` (`library-collections.css`)
  turn desktop rules on *inside* the mobile band; 720/760 act as "almost 740".
- **z-index: 30 literal values, no scale.** Toasts/banners (200) sit **under** the
  lightbox, reader and viewers (1000), so an offline or download toast cannot show over an
  open photo; `modal-backdrop` shares 20 with menus and toolbars.
- **Three theming systems:** `tokens.css` (five themes, `data-theme` only, zero
  `prefers-color-scheme`), the Sputnik forks in `home.css` (96 rules) / `player.css`
  (102 rules) under `:root:is([data-theme="dark"],[data-theme="light"])`, and the ebook
  reader's own `--ebk-*` set.
- **Baseline rule is respected**: every mobile block is inside `@media (max-width: 740px)`;
  3 `!important` in the whole codebase, 0 ID selectors. `display-mode: standalone` is never
  used (CLAUDE.md names it); `.home-toast` carries a 72 px mobile tab-bar offset in a base
  rule (`home.css:2458-2485`).
- Naming: flat kebab-case, `is-*` state — consistent; prefixes hold in stories/family-tree/
  home/scan-layout/reader but not in `admin.css`, `about.css`, `library-collections.css`;
  `.audiobook-*` and `.modal-*` are restyled inside other features' files.
- `docs/css-map.md` is stale: 7 imported files missing (`stories`, `social`, `scan-layout`,
  `review`, `audio`, `person-edit`, `welcome`), "two themes" vs five, six class rows that no
  longer exist, "109 multi-file selectors" vs 10 today.

### 6.4 Tooling proposal (the thing that keeps the rest fixed)

There is no ESLint, Prettier or `.editorconfig`; only `tsc --strict` and
`scripts/check-ui-conventions.mjs`. The index is 100 % LF (664/664 files); the "mixed
CRLF" experience is `core.autocrlf=true` working-copy noise plus four files with mixed
working copies. Dominant style from a 20-file sample: 2 spaces, double quotes, semicolons,
**no trailing commas**, `(x) =>`, long lines routine (5–10 % over 100 chars).

Recommended, in this order, each a separate commit:

1. `.editorconfig` (lf, 2 spaces, final newline) and `* text=auto eol=lf` in
   `.gitattributes` (keep the `*.sh` rule). Zero code change.
2. `eslint.config.js` at the root: `typescript-eslint` recommended (not type-checked to
   start), `eslint-plugin-react-hooks` for `apps/web`, `no-unused-vars` with `^_`,
   `no-explicit-any: warn`; ignore `dist`, `public`, `vendor`. The 45 existing
   `eslint-disable` comments are already waiting for it. Add `npm run lint` to `test.yml`.
3. `noUnusedLocals` + `noUnusedParameters` in both tsconfigs after fixing the hits
   (server 16, all in `duplicates/folders.ts`, `duplicates/items.ts`, `shares.ts`,
   `app-storage.ts`, `catalog.ts`, `slideshow-render.ts`, `quotes.ts`; web 48, hotspots
   `StoriesPage.tsx` 10, `GalleryPage.tsx` 9, `StoryCollectionPage.tsx` 6).
4. Prettier is optional. If adopted: `printWidth 120, semi, double quotes,
   trailingComma "none", arrowParens "always", endOfLine lf` reformats the least; commit
   it alone and add the hash to `.git-blame-ignore-revs`. ESLint alone is zero-disruption.
5. Extend `check-ui-conventions.mjs` to CSS: fail on new `!important`, `@media` widths
   outside a sanctioned set (740 · 1100 · 430 · 1240), `var(--x)` with no definition,
   `#hex`/`rgb(` outside `tokens.css`/`themes/` beyond a per-file allowance, and run the
   dead-class scan. Also teach it to check `docs/users/README.md` against the guides.

Server style outliers worth fixing while splitting (§5.1): `modules/library/index.ts:54-62`
mixes `app.register(plugin)` with 13 direct `registerXRoutes(app)` calls; four route-file
naming conventions (`*-routes.ts`, `routes.ts`, routes in `index.ts`, routes in domain
files); `shared/trash-routes.ts:206` array `preHandler` (redundant); three `request.body as`
sites (`core/dashboard.ts:749`, `books-routes.ts:345`, `stories/routes.ts:774`); four
import-time prepared statements (`gallery/catalog.ts:158,578`, `voice-notes.ts:52`,
`social/for-you.ts:41`) that compile before any test `resetDb`; 24 `console.*` in workers
next to pino JSON (`faces/arcface`, `faces/scanner`, `slideshow-render`,
`slideshow-title-card`, `transcode`, `job-recovery:69`, `backups/run:243`, `db.ts:96,104`)
and one `console.log` at boot (`backups/index.ts:105`). Otherwise the server is remarkably
uniform: 208 `parseBody`, 899 `{ error }` bodies, 987 `reply.code`, 491 `preHandler`,
camelCase on the wire everywhere.

---

## 7. Performance

### 7.1 Server / database

- **`datetime(column)` defeats indexes (138 sites).** ISO-8601 strings compare correctly
  as text; wrapping the column hides it from the index. `EXPLAIN QUERY PLAN` against
  `schema.sql`:
  ```
  core/dashboard.ts:833   WHERE datetime(created_at) >= datetime(@from) …
     → SCAN activity_logs USING COVERING INDEX          (full scan)
     plain created_at >= ? → SEARCH … (created_at>? AND created_at<?)
  core/security.ts lockout  WHERE email = ? AND datetime(created_at) > datetime('now', ?)
     → index used for email only                         (every login)
  core/security-routes.ts:131  … datetime(expires_at) > datetime('now') → SCAN sessions
  job claim  ORDER BY datetime(run_at) → USE TEMP B-TREE, polled every 2 s by 8 workers
  ```
  Counts: `core/dashboard.ts` 17, `shares.ts` 11, `gallery/catalog.ts` 10,
  `core/security.ts` 8, `core/logs.ts` 6, `device-link.ts` 5, `maintenance/index.ts` 4.
  `activity_logs` grows until the cleanup job prunes it (itself a `datetime()` scan), so the
  dashboard's four full scans per load slow down every month. One mechanical sweep.
- **N+1 on request paths:** `/api/shared-with-me` (`shares.ts:1684-1686`, on the home
  page's "Sent to you" path) does a users lookup plus a full album item load per share;
  `inbox.ts:91` one query per gallery library; `scan-rules.ts:88`, `series-routes.ts:265`,
  `works.ts:108` loops.
- **No prepared-statement reuse in scanners:** `audiobook/scanner.ts` has 58 `db.prepare`
  sites and `writeBookScan` prepares ~15 statements per book, several inside `forEach`
  (1524-1596): ~100k SQL compilations on a 5k-book scan.
- **Unpaginated:** `GET /api/library/people/names`, `/api/family-tree/tree`,
  `/api/shared-with-me` — then compressed synchronously.
- **Missing indexes:** `library_items(type, deleted_at, discovered_at DESC)` (home
  "recently added" sorts with a temp b-tree), `activity_logs(actor_user_id, created_at)`,
  `sessions(expires_at)`, `jobs(type, status, run_at)`, `blocked_ips(expires_at)`.
- **Caching:** `resolveAppLocation` reads `app_settings` for **every thumbnail request**
  via `thumbnail.ts:134-135`; cache the resolved roots and invalidate from the two setters.
  `libraryJobRunning()` is polled 4×/s at idle by 8 near-identical `process*Queue` loops;
  one shared poller would remove them.

### 7.2 Web bundle and PWA

- Route splitting is good: all 43 routes in `App.tsx:24-66` are `lazy()`, leaflet / marked /
  dompurify / zip / epub are their own chunks, `ru` is a dynamic import.
- **PWA precache defeats it.** `vite.config.ts:151`
  `globPatterns: ["**/*.{js,css,html,svg,woff2}", "guides/*.md"]` precaches 168 entries /
  **4.44 MB** (132 JS chunks) including `ru-*.js` (537 KB), `ControlPanelPage-*.js`
  (**709 KB** — `ControlPanelPage.tsx:21-44` imports all 24 sections statically and
  `DashboardChart.tsx:3` pulls `chart.js/auto`), `leaflet-*.js`, every route chunk and all
  20 guides. Every first visit and every `autoUpdate` after a release downloads the whole
  app. Fix: `globIgnores` for ru/control-panel/leaflet/chart/non-shell chunks; `lazy()` per
  control section (as `LocationsMap` already is); `chart.js` with explicit registration.
  Expect `sw.js` from 4.4 MB to ≈1.5 MB.
- `reloadTimeline` refetches every loaded page in 200-asset chunks and the scan-poll effect
  re-runs it every 3.5 s for the whole loaded set (`GalleryPage.tsx:527-540, 877-889`).
- No virtualization anywhere; timeline pages 80 at a time with "Load more" — acceptable.
- `AudiobooksPage.tsx` has 53 `useState` and zero `useCallback`/`useMemo`, so every
  keystroke re-creates every handler passed to `CatalogBookCard` (no `memo` either).
- Images: 60 of 134 `<img>` carry `loading="lazy"`; album/slideshow covers and Home hero
  do not; `srcset` ×0.

### 7.3 CSS

One flattened `index-*.css` of **603 KB raw / 97.8 KB gzip** ships on every route including
`/login`, `/share/:token`, `/drop/:token` (the login page needs ~35 KB raw). Cheapest wins:
dead CSS (~8 KB), the duplicated Sputnik skins (~60 KB), then importing `auth.css`,
`share.css`, `ebook-reader.css`, `family-tree.css`, `scan-layout.css`, `duplicates/*`,
`about.css` from their lazy page modules instead of `styles.css` (Vite emits them as chunks
exactly as it does leaflet); the five slideshow `@font-face` are raw TTF with no
`font-display` and should move to the slideshow chunk as woff2. Selectors are cheap
(universal `*` only for `box-sizing`, 0 attribute-substring selectors); leaflet and
markercluster are correctly deduped and lazy; foliate-js ships no CSS.

---

## 8. Dead code and orphaned files

### 8.1 Source

| Item | Evidence | Action |
|---|---|---|
| `apps/web/src/features/control/libraries/LibraryCoreFields.tsx` (2.5 KB) | only unreachable web file; exports `LibraryCoreFields`, `LibraryAccessFields`; nothing imports either; strings were translated in the i18n sweep while already dead | delete |
| `apps/server/src/types.ts` | only unreachable server file, but it is the `declare module "fastify"` augmentation picked up by the include glob | keep; optionally rename to `fastify.d.ts` or `import "./types.js"` from `index.ts` |
| Raw U+0000 bytes | `PhotoInboxPage.tsx:461` `key={delivery.folder \|\| "<NUL>root"}`, `LayoutStep.tsx:104` `layouts.join("<NUL>")` (verified: one NUL each). `grep` reports "Binary file matches"; LayoutStep's is inside the first 8 KB so `git diff` shows "Binary files differ" | replace with `"\u0000"` |
| Web dead exports | `BookFilter.tsx:48-240` client-side `facetsFromBooks`/`filterBooks`/`sortBooks`/`SortSelect` (~180 lines, superseded by server facets); `AudiobooksPage.tsx:43 AudiobookHeaderSort` (only an unused import in `EbooksPage.tsx:24`); `nav.ts:151 TAB_BY_SECTION`; `activityEvents.ts LOGIN_EVENTS`; `foliate.ts flattenToc`; `LoginsTable.tsx isLocalAddress`; `StoryMarkdown.tsx renderStoryMarkdown`; `feed.ts EMPTY_QUOTE_PREFS/quoteLanguage/storedQuoteCategory/MEMORY_STRIP_SIZE`; `downloads.ts setOfflineUserId` | delete |
| Server dead exports | `core/permissions.ts:14 SYSTEM_ADMINS_GROUP_ID` (the file's one TODO at `:44` refers to it), `gallery/replace.ts:159 replaceableKind`, `taken-precision.ts:16 isTakenPrecision`, `shared/trash.ts:41 trashFolderFor`, `stories/share.ts:539 storyShareFilePath`, `stories/stories.ts:210,218 storyOfChapter/storyOfBlock`; 76 more exports used only in their own file (`slideshow-render.ts` 11, `mfa-routes.ts` 5) | delete / drop `export` |
| Unused imports/locals | server 16 (`duplicates/folders.ts:26-31` reads like a refactor that moved deletion to `job-resolve.ts` and left the imports; `duplicates/items.ts` phase-2 leftovers `BAND_COUNT`, `withinNearDistance`), web 48 | fix, then turn the flags on (§6.4) |
| Dead CSS | 53 classes / ~300 lines: `gallery.css` 16, `library-browse.css` 8 (the pre-`LibraryPageToolbar` nav row / bulk bar at 283-330, 743-770, 1015-1095 — the *old* toolbar beside the new one), `admin.css` 7, `stories.css` 6, `social.css` 4, `data-display.css` 4, `responsive.css` 3, others 5; full list in the CSS review | delete |

### 8.2 Assets

| Item | Size | Action |
|---|---|---|
| `apps/web/public/Assets/brand/{isputnik-brand-icon.svg, isputnik-logo-sputnik-earth-mark.png, isputnik-logo-sputnik-earth.png, isputnik-logo-sputnik-earth.svg, isputnik-login-orbit-backdrop.svg}` | 238 KB | zero references, shipped in every Docker image and precache-eligible → `git rm` |
| Root `Assets/brand/` twins of the same five + `isputnik-brand-icon.png` (145 KB) | 383 KB | CLAUDE.md keeps the folder for `isputnik-app-icon.png` (the Unraid `<Icon>`); pruning the unused siblings is the owner's call |
| `apps/web/public/fonts/*.ttf` = `apps/server/src/assets/fonts/*.ttf` | 2.11 MB duplicated, hand-synced | gitignore the web copy and copy it in a `buildStart` hook in `vite.config.ts` (same shape as `userGuides()`); server copy is the source of truth |
| `apps/web/src/assets/backgrounds/retro-space-player-night-v2.webp` | 1.58 MB, used | run `npm run optimize:images` |
| `docs/users/images` (66 files, 6.6 MB) | | every image is referenced by a guide; nothing to prune |
| Repo-root `dist/` (2026-05-28, pre-workspace) | 20 KB, untracked | delete locally |

Nothing that should not be tracked is tracked (no `dist/`, `data/`, `*.sqlite`, `.env`,
OS junk). Gaps: `.gitignore` lacks `*.log`, `.DS_Store`, `Thumbs.db`, `*.tsbuildinfo`,
`coverage/`; `.dockerignore` lets `COPY apps/…` pull in `apps/**/test`, the gitignored
`apps/web/public/guides/` (6.8 MB) and, if fetched locally, the 167 MB
`apps/server/models/face/w600k_r50.onnx` before the model stage overwrites it.

### 8.3 Docs

19 plan/proposal docs (~387 KB) describe features that have shipped. Two safe patterns:
`git mv` to `docs/archive/` and `sed` the code-comment paths, or leave in place with a
first-line `Status: shipped in vN (date); kept for history` — `custom-scan-rules-proposal.md`
already does this and is the model.

| Archive now | Shipped as |
|---|---|
| `custom-scan-rules-proposal.md`, `scan-layout-plan.md` | 3.62.0 |
| `alphabet-approach-proposal.md` | 2026-08-12 (migration 34) |
| `iSputnik-Link-a-Device-Proposal.md`, `iSputnik-Link-a-Device-Plan.md`, `iSputnik-Remote-Device-Linking-Plan.md` | 3.5.0 |
| `gallery-slideshows-proposal.md`, `gallery-slideshow-credits-proposal.md` | shipped; `gallery-slideshows.md` is the living reference |
| `duplicate-cleanup-plan.md` | 2.23.0 |
| `stories-proposal.md`, `stories-v2-proposal.md` | 3.44.0–3.50.1 |
| `recipes-plan.md` | 3.66.0 |
| `photo-review-plan.md`, `for-you-plan.md` | 3.71.0–3.76.1, 3.74.0 |
| `i18n-plan.md` | complete 2026-08-27 (update the CLAUDE.md pointer) |
| `security-review-2026-08-17.md`, `security-remediation-2026-08-17.md` | 3.10.0 |

Keep for now with a `Status:` line: `app-storage-plan.md`, `photo-inbox-proposal.md`,
`quotes-plan.md` (phases 2–3 open), `family-sharing-proposal.md` (phase 4 open),
`gallery-memories-albums-proposal.md` (phases 3–5 open). Unlinked but worth keeping and
linking: `css-map.md` (after the fix in §6.3), `rollback.md` (after the rewrite in §9.4).
Oldest untouched living docs worth a skim: `ebook-library.md`, `library-sharing.md`,
`uploads.md` (2026-06-12; multi-format ebooks, Editions and Inbox uploads landed since).
`docs/users/README.md` links 14 of 19 guides — missing `duplicate-cleanup`, `family-sharing`,
`link-a-device`, `passkeys`, `photo-inbox`. `Documents/` is confirmed retired (0 tracked).
An untracked `docs/control-panel-navigation-review.md` sits in the working tree: commit or
discard before the cut.

### 8.4 Locales and scripts

- `locales/{en,ru}/library.json` is an empty `{}` namespace in both languages, still
  imported and registered → delete the two files and the two barrel lines.
- **144 unused keys (2.3 %)** clustered by retired UI, which is the useful signal:
  `control:libraryMembers.*` (14), `family:tagAccess.*` (14), `family:treeSettings.*`,
  `common:home.photoInbox*` (pre-feed tiles), `common:nav.shared*` ("Shared with me"),
  `controlAdmin:layout.preset_*` (7), `galleryModals:shareAlbum.*` (26, a removed dialog),
  33 in `stories` (the pre-redesign editor). Full list in the audit output. Every unused en
  key drags a ru twin and both ship in the bundles.
- Scripts referenced nowhere: `scripts/reshape-boxset.mjs` (June one-off) → delete;
  `seed-fake-logins.mjs`, `demo-photo-inbox.mjs`, `apps/web/scripts/generate-pwa-icons.mjs`
  → keep and add npm scripts (`seed:logins`, `demo:inbox`, `icons:pwa`) so they are
  discoverable; decide whether `scripts/quote-packs/` (67 KB) is a user download (then link
  from `docs/users/quotes.md`) or dev tooling.

### 8.5 Dependencies

- **Misplaced:** `apps/web` `dependencies` → `devDependencies`: `vite`, `@vitejs/plugin-react`
  (`vite-plugin-pwa` is already right). No runtime effect (the image installs only the
  server workspace) but it misstates the surface.
- **Unused:** `@types/svg-maps__common`; `@svg-maps/world` is used only by the one-off
  `gen-country-centroids.mjs` whose output is committed → drop both, document
  `npm i --no-save` in the script header.
- **Node:** runtime is `node:26-slim` (Dockerfile, CI); `@types/node` is `^22`; no
  `engines`, no `.nvmrc`; the Dependabot ignore comment for `@types/node` is stale. Add
  `"engines": { "node": ">=26" }`, `.nvmrc`, bump the types.
- **Local install drift (not a release blocker):** `npm ls` reports `invalid: nodemailer@9.0.6`
  because the local `node_modules` predates the 9.1.1 bump; the lockfile already pins 9.1.1,
  so `npm ci` in CI/Docker is unaffected. Run `npm install` locally.
- `npm outdated`: majors behind are `nodemailer` 9 → 10 and `typescript` 5.9 → 7 (plan
  separately; TS 6/7 change `moduleResolution` defaults); the rest minor/patch.
- `npm audit --omit=dev`: 2 moderate, both `adm-zip ≥0.5.9` symlink-follow on extraction
  (direct dep in `backups/zip-read.ts` and `ebook/scanner.ts`, transitively via
  `onnxruntime-node`; the "fix" downgrades to 0.5.8). Check whether `zip-read.ts` extracts
  to disk or only reads entry buffers; document as accepted or move restore onto `yauzl`.

---

## 9. Release engineering and operations

### 9.1 CI

`test.yml` runs `npm ci → typecheck → test (both) → check:ui` on Node 26 for pushes/PRs;
`docker.yml` builds on the same triggers and pushes only on `v*` tags, moving `latest` on
every tag. **They are not linked**: a red test run on the release commit still publishes.
Fix with a `needs:` on a test job in the same workflow or a release script that waits on
`test.yml`; add branch protection requiring both checks (Dependabot PRs are why CI exists).
Dependabot config is good (weekly, grouped).

### 9.2 Docker and shutdown

What is right: six-stage build, `--omit=dev` + lockfile-closure prune with an import smoke
test of every runtime dep, foreign-platform binaries removed, pinned SHA-256 for the
ArcFace model, `gosu` privilege drop with sentinel-guarded `chown`, every persistent path
under `/config`. Findings:

- **No SIGTERM/SIGINT handler** and `app.close()` is never called. Node is PID 1 after
  `exec gosu … node`; on `docker stop` the seven `onClose` hooks
  (`library/index.ts:127`, `audiobook/index.ts:26`, `ebook/index.ts:16`,
  `gallery/index.ts:66`, `maintenance/index.ts:961`, `stories/index.ts:47`) never run.
  Data is safe (WAL, atomic claims, boot-time recovery) but a slideshow render or storage
  move during an Unraid update restarts from its last checkpoint with no message.
- **No `/api/health`, no `HEALTHCHECK`**; `/api/status` is admin-only. A crash-loop on a
  bad migration is visible only in logs.
- `COOKIE_SECURE` default is `false` in the Dockerfile, `auto` in the Unraid template;
  `config.ts` treats unknown values as "follow `APP_URL`". Set the Dockerfile to `auto`.
- No `logging:` block in compose; Fastify logs every request including range requests
  while streaming audio.
- amd64 only (no `platforms:`); `sharp` and `onnxruntime-node` ship arm64 prebuilds, so
  `linux/arm64` is feasible with QEMU, or document amd64-only.
- Unraid `<Overview>` omits Stories, family tree, face recognition and any Beta wording.

### 9.3 Configuration reference

23 `process.env` names are read; there is no single page listing them. Undocumented
anywhere: `DB_PATH` (source installs), `BACKUP_RETENTION` (superseded by per-kind
retention in 3.89.0 — confirm whether `config.ts:50` still needs it), `GEOIP_URL_BASE`.
Documented but absent from compose/template: `DEVICE_SESSION_DAYS` (365 d), `HTTPS_REDIRECT`,
`HSTS`, `MFA_ENCRYPTION_KEY`, `FACE_ORT_THREADS`, `FACE_ORT_PROVIDERS`. The release review
contains the full parity table; turn it into `docs/configuration.md` (or a section of
`hosting.md`) linked from README and the exposing guide.

### 9.4 Data safety and rollback

WAL + `synchronous=NORMAL` + `foreign_keys=ON`; 42 migrations (33 → 74), each in a
transaction stamping `user_version`, each checking `table_info` first (idempotent); no down
path by design; databases at `user_version` 1–30 are refused with a clear message.
One-way steps exist: 52 (`DROP COLUMN`), 55 (table rebuild), 65 (`DROP COLUMN`), 66
(backfill). A 3.89.0 → Beta upgrade runs **zero** migrations (highest is 74 from 3.79.0)
and no env renames; the 3.88.0 renders move and 3.90.0 rename are guarded tasks.

- **`docs/rollback.md`** names 3.9.0 as "the current known-good version" (16 mentions) and
  says "restore the automatic pre-upgrade backup". No such backup exists in code (grep for
  `pre-upgrade|preUpgrade|lastVersion|previousVersion` finds nothing). Either implement it
  — copy the `.sqlite` when `app_settings.last_booted_version != config.version`, keep one
  — or rewrite the doc to "take a backup before upgrading". Rewrite generically either way
  and link it from README.
- **No schema-drift test**: nothing builds a fresh DB from `schema.sql` and a migrated DB
  from a v32 baseline and diffs `table_info` + indexes. This is the exact footgun
  `docs/database.md` warns about. Snapshot `schema.sql` as of v3.0.0 into a fixture.
- Eleven startup mutators (`seed`, `backfillAlphaKeys`, `migrateRendersIntoAppStorage`,
  scan-lock mop-up, `sweepOrphanLibraryThumbnails`, trash purge, `rescueStrandedBackups`,
  `adoptLegacyBackupSchedule`, legacy narration importer, `recoverOrphanFaceClusters`,
  storage-move recovery) are all guarded and idempotent; none announce themselves in the
  activity log. A single "Startup housekeeping" entry would help support.

### 9.5 Observability

pino via Fastify defaults, level `info`, no `LOG_LEVEL`/`LOG_FORMAT` env; request IDs on
every line; token masking in the `req` serializer; 500s never leak stacks. Missing:
`LOG_LEVEL` pass-through, `/api/health`, a Dashboard card with uptime / last boot version /
count of swallowed uncaught exceptions since boot, `disableRequestLogging` for static and
media paths.

### 9.6 Tests

| Suite | Files | Tests | Result | Time |
|---|---|---|---|---|
| server | 173 | 2,137 | 1 flaky timeout, 2,136 pass | 20.8 s |
| web | 35 | 254 | pass | 15.9 s |

- The one failure is `backup-kinds.test.ts:120` timing out at 5 s under full-suite CPU
  contention (16 s file time; 2.6 s alone). `testTimeout: 15000` in the server vitest
  config.
- No `.skip`/`.only` anywhere. Face-detection tests self-skip when the model is absent, so
  face detection never runs in CI (a weekly job could fetch the model).
- `recipe-import.test.ts` and `webauthn.test.ts` contain external URLs with no fetch
  stub — confirm they are fixture strings only.
- 14 test files define their own `boot`/`buildApp`; a shared `bootApp(plugins[])` would
  cut them. A `globalSetup` pinning `BACKUP_PATH` to a temp dir removes the
  `rescueStrandedBackups` footgun documented in CLAUDE.md.
- Web tests are good quality (189 `*ByRole` vs 50 `querySelector`, 0 snapshots, unmocked
  `fetch` throws loudly) but cover ≈4.8 % of source lines.

Coverage gaps ranked by risk (server): the SSRF layer `core/safe-fetch.ts` +
`shared/remote-image.ts` (zero tests; already crashed the process once); the global error
handler and plugin rate limiter (zero); `modules/uploads/index.ts` and its consumers incl.
the unauthenticated `/drop/:token` (0/3 routes); `users/groups.ts` (0/4) and
`shared/members.ts`; `gallery/duplicates/job-routes.ts` (0/17); `audiobook/mp4-chapters.ts`
(the Audible `mdat`-before-`moov` case is in project memory, not in a fixture); a full
migration walk; `gallery/slideshow-routes.ts` (0/12), `inbox-routes.ts` (0/5),
`app-storage-routes.ts` (0/8), `audiobook/categories-routes.ts` (0/9); ~90 routes total
with no HTTP test, mostly admin/destructive. Web: the shared primitives `Modal`,
`ConfirmDialog`, `Button`, `MessageBox`, `SelectMenu`, `SortMenu`, `LibraryPageToolbar`
(every convention rests on them, none tested); `GalleryPage`, the catalog pair and
`useMediaCatalog`, `AudioPlayer`, `EbookReader`, `App.tsx` session bootstrap,
`offline/downloads.ts`, `familytree/`, `collections/`.

### 9.7 Branches

Working tree clean at `3b65e6c9` except the untracked review doc noted in §8.3. Merged
and deletable: local `release/3.58.0`, `release/3.61.0`; remote `origin/release/3.58.0`,
`3.61.0`, `3.62.0`, `3.65.2`. Stale: six `origin/dependabot/*` and
`origin/docs/scan-rules-guide` (check whether it landed in `a5dcc122`).

---

## 10. Beta labelling and docs

### 10.1 Versioning

Versions are already `3.90.0` with ~200 releases in the 3.x line and `latest` following
every tag. Recommended: cut the Beta as **`4.0.0`** with plain tags and add
`"stage": "beta"` to the root `package.json`, surfaced in `/api/about` → About page
("4.0.0 · Beta"), the README badge row and the Unraid `<Overview>`. A `-beta.1` suffix
would force `docker.yml` to gate `latest` and `{{major}}.{{minor}}` on "no `-` in ref" and
would silently stop `:latest` Unraid users receiving updates. Keeping the stage out of the
version string makes "stable" a one-line flip. Also: render `CHANGELOG.md` from
`changelog.ts` in the release step (`scripts/changelog-md.mjs`) and create a GitHub Release
per tag; add a per-user `last_seen_version` so Home can show "Updated to X — what changed".

### 10.2 Every place that says "experimental"

| File:line | Text |
|---|---|
| `README.md:3-5, 7, 13` | banner "Under active construction… experimental… not a stable release" |
| `SECURITY.md:5` | "even though this is an experimental personal project" |
| `CONTRIBUTING.md:5-7` | "not stable… breaking changes and without migrations" (the migrations clause is false now) |
| `docs/architecture.md:33` | "Status snapshot: June 16, 2026 — v0.31.0" |
| `docs/database.md:7-9` | "target design… from-scratch rebuild" |
| `isputnik-home.xml` `<Overview>` | no maturity wording |
| `locales/*/controlDash.json` `dupes.experimental`, `locales/*/galleryModals.json` `faceSettings.experimental`, `docs/users/control-panel.md:521` | feature-level badges (Duplicates, faces) — can stay under a project-level Beta |

### 10.3 README

Zero screenshots while 66 curated "Demo Admin" shots exist; no badges; no quick-start
compose snippet; no requirements (amd64, RAM for faces, disk for the model). Feature list
omits Stories/Recipes, Photo Inbox + drop links, Photo review / For you, App storage,
Passkeys, Link a device, scan layouts, Russian UI, Memories / Year in review, voice notes,
the home feed, social notes, three backup kinds; "In Development" still lists Notes and
Document management.

### 10.4 Other docs

- `docs/architecture.md`: status ~60 releases stale; backend tree omits `modules/social/`,
  `home`, `library/{app-storage*,quotes*,works}.ts` and most of `core/` (csrf, mfa,
  webauthn, device-link, geoip, ip-reputation, security-*, mail, notifications,
  api-tokens, app-storage, compression, cookies); release process names `core/status.ts`
  for the changelog (it is `changelog.ts`); Related Documents table omits ~15 docs.
- `docs/database.md`: says 2.0.0 reset the baseline (it was 3.0.0 → 32); table reference
  stops at stories.
- `CONTRIBUTING.md`: `npm test` described as server-only; omits `test:server`/`test:web`,
  `CRASH_LOG`, `docs:shots`, the backups test hazard.
- `AGENTS.md` is a stale six-bullet subset of `CLAUDE.md` (missing the i18n, toolbar,
  control-panel, core-vs-modules and test-safety rules) → one-line pointer.
- License is consistent (AGPL-3.0-only everywhere); CoC, issue and PR templates present.
- Missing user guides: a backup-and-upgrade guide (currently a section of
  `control-panel.md`) and the configuration reference.

---

## 11. Security posture (for the record)

All controls in `docs/security-remediation-2026-08-17.md` are present in code: CSRF
double-submit with `__Host-` on HTTPS (`core/csrf.ts` — the project memory saying "CSRF
remains" is stale), enforced CSP with `script-src 'self'` and `form-action 'self'`, global
1000/min/IP limiter plus 25 per-route tightenings with trusted-network exemption,
`httpOnly`/`sameSite:lax`/`__Host-` cookies, TOTP + email + backup codes + passkeys, lockout /
IP block / trusted zones / alerts, per-route upload caps, `pathIsInside` at 71 sites, SSRF
pinning, sealed SMTP/AbuseIPDB secrets, `security.txt`, token redaction in logs. No tracked
`.env`, no secret literals, no default admin credentials.

Remaining for a Beta: the 429/413 flattening (§3.1, which also makes the limiter invisible);
one CSRF test only, no negatives; the SSRF layer untested; request logs and
`activity_logs.ip_address` (365-day default) keep visitor IPs including guests on share
links — say so in the control-panel guide and expose the retention knob; `SECURITY.md`
should list the accepted risks (adm-zip transitive, lexical `pathIsInside`, TOTP replay
window) and link `/.well-known/security.txt`; `DEVICE_SESSION_DAYS` (365) is invisible to
operators.

---

## 12. Suggested sequence

**Week 1 — Beta.0 gate (M1–M16).** All S/M items, none structural. Order: M1 error handler
(then M2, M11 next to it in `index.ts`), M3 + M4 shutdown and health, M5 CI gate, M16 flaky
test, M15 NUL bytes, M9 confirmations, M7 Modal, M8 precache, M10 `datetime` sweep, M6
rollback, M14 config reference, M12 labelling, M13 README. Tag `v4.0.0`.

**Beta.1 — tooling and hygiene (S1, S10–S16).** ESLint + editorconfig + the two tsconfig
flags first so every later refactor is checked; then the orphan/asset/locale/docs
cleanups, which are mechanical and low-risk.

**Beta.2 — structure (S2–S9).** `parseQuery`; the media-type registry (breaks the cycle
and unblocks `trash.ts` tests); the four module moves; then the file splits, starting with
`shares.ts` and `audiobook/scanner.ts` because a Beta bug is most likely to land there;
web `CatalogPage` + `usePlayback` + `GalleryPage` split; CSS dead code, tokens, z-index,
barrels; the ranked test list.

**Later** as listed in §2.3.

---

## Appendix — method and artefacts

Five read-only review passes, each with scripted evidence: import graphs with cycle
detection (Tarjan) for both workspaces; dead-export and reachability scans; a CSS parser
producing class usage, duplicate rule bodies, breakpoint and z-index inventories; a locale
key scan with plural/context suffix collapsing and dynamic-prefix detection; asset and
dependency reference scans; `EXPLAIN QUERY PLAN` against `schema.sql` in an in-memory
better-sqlite3; a Fastify reproduction of the error handler using the repo's own
`node_modules`; `tsc --noUnusedLocals --noUnusedParameters` in both workspaces; both test
suites run once; grep distributions for every style claim. Every Critical/High item was
re-verified by hand against `main@3b65e6c9` before inclusion. One reviewer claim was
corrected during verification: the "invalid nodemailer install" is local-only (the lockfile
is correct), so it is a local `npm install`, not a release blocker.
