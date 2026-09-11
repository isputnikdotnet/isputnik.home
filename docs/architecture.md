# isputnik.home — Architecture

**Slogan:** our world revolves around you.

## Overview

isputnik.home is a private, self-hosted web app for friends and family. It provides a shared digital space built around a **Digital Library** for media — audiobooks, ebooks, and a photo/video gallery — plus a **Family tree** beside it, with a **Notes** module planned. Everything runs on a home server — no cloud accounts, no external services required.

---

## Goals

- Private and self-hosted — no third-party cloud dependency
- Simple enough for non-technical family members
- Modular — new features can be added without restructuring the codebase
- Shared and personal content — each module supports both private and family-wide access
- Minimal infrastructure — no external services required to run

---

## Design Principles

- **Self-contained.** SQLite for storage, filesystem for files. One process, no external database server or queue.
- **Modular.** Each feature registers itself. Adding Notes or a new library type does not touch existing code.
- **Safe with originals.** Library source files are read-only. The app indexes them in place and writes only to its own managed folders.
- **Invite-only.** No public registration. Accounts are created through admin-issued invite links.
- **Progressive enhancement.** Content becomes browsable as background jobs finish — scans and metadata do not block the UI.

---

## Implementation Status

**Current release line: 4.0.0 — Beta** (September 2026). The lists below are a
snapshot from June 2026 (v0.31.0) and are out of date: much of *Planned* and
*Future Updates* has shipped since — the gallery with face recognition and a map,
shareable albums, the family tree, stories and more. The user guides in
[`users/`](users/README.md) and the changelog in `apps/server/src/changelog.ts`
describe the app as it is now.

**Status snapshot: June 16, 2026 — v0.31.0**

### Completed

- React + TypeScript frontend, Node.js + Fastify + TypeScript backend, SQLite database
- Admin setup, email/password login (scrypt), cookie sessions, invite-only registration, protected routes
- App shell: shared left navigation on desktop, native-style bottom navigation for phone/PWA use, profile dropdown, light/dark/system themes
- Control panel: user/role/session management, invite links, activity logs, system status, About
- Digital Library infrastructure: storage roots, thumbnail configuration, audiobook and ebook library registration and scan
- Audiobook library — metadata lookup/enrichment (OpenLibrary, LibriVox, Audible, FantLab), author/narrator photos, sidecar import, m4b chapter reading, manual metadata editor, playback resume, position bookmarks, and a saved-books "My List"
- Ebook library — EPUB/PDF catalog, in-app EPUB reader (foliate-js), per-type series, reading progress, and cross-type reader bookmarks
- Uploads — audiobook and ebook upload (single + folder), companion files, and bulk delete (policy-gated; [`uploads.md`](uploads.md))
- Sharing & access control — unified per-object role model with public/private libraries, user-to-user item shares, and guest share links ([`permissions.md`](permissions.md), [`sharing.md`](sharing.md))
- Recycle Bin — delete moves source files to a hidden `.trash` folder; restore/purge across library types ([`recycle-bin.md`](recycle-bin.md))
- Backup & restore tooling — download/upload backups with staged restore-on-restart
- Categories & Tags — fixed navigation **categories** (keyword-matched per scan) plus global, cross-type **tags**, with global cross-type browse and admin management
- Cross-type Likes and Collections — user-curated lists spanning audiobooks and ebooks
- Home feed — one ranked card feed (`/api/home/feed`): sticky "Sent to you" cards, an "On this day" photo-memory card, per-day "books joined the library" batch cards, family-activity cards, and a rotating next-in-series suggestion, with a pinned resume hero above it
- PWA/offline — installable app shell, account-aware cache cleanup, durable downloaded-book metadata, offline player/detail fallback, reconnect progress sync, and cover-cache revalidation
- Security hardening — per-IP rate limiting (tight on auth endpoints), optional TOTP two-factor auth, security headers (helmet), scoped proxy trust (`TRUST_PROXY_HOPS`), SSRF DNS-rebinding fix on remote image fetches, ReDoS fixes, and path-traversal-safe static serving

### Planned

- Notes module — rich text, tags, visibility, full-text search
- Group ownership / membership for libraries (the `assignments` engine already supports group subjects)

### Future Updates

- Gallery enhancements — map view (GPS), face detection / semantic search, shareable albums
- Mobile app

---

## Users and Roles

| Role | Access |
|---|---|
| Admin | Invite users, manage accounts, view logs, configure app, monitor status |
| Member | Use all modules, manage own profile and content |

Registration is invite-only. Admins generate a single-use invite link and share it directly. No SMTP required. See [`auth.md`](auth.md) for session, invite, and MFA detail.

---

## Modules

### Digital Library

The primary content module. Supports multiple **library types** — each type has its own scanner, metadata jobs, display logic, and database tables. The `libraries` table is shared; type-specific tables live alongside it.

**Library types:**

| Type | Status | Detail |
|---|---|---|
| Audiobook | Active | [`audiobook-library.md`](audiobook-library.md) |
| Ebook | Active (EPUB/PDF, in-app reader) | [`ebook-library.md`](ebook-library.md) |
| Gallery | Active (photos + videos, timeline + folder views) | [`gallery-library.md`](gallery-library.md) |
| Podcast | Future | — |

The **Family tree** sits beside these rather than among them: it is a module, not a
library type — no source folder, no scanner, no files of its own. It borrows photos
from gallery libraries by reference. See [`family-tree.md`](family-tree.md).

**Shared across all library types:**

- Background job queue for scans, metadata extraction, thumbnail generation
- Sharded thumbnail cache at `THUMBNAIL_PATH`
- Access via the unified permission model — per-object role assignments (Everyone group = public, owner = manager) with per-library write policies; item-level sharing via `shares` and `share_links` ([`permissions.md`](permissions.md))
- Collections, Likes, and Tags — cross-type, shared across all library types
- Recycle Bin — deleting moves source files to a hidden `.trash` folder and removes the row; restore or purge later ([`recycle-bin.md`](recycle-bin.md))
- Safety rule — source files are never renamed, moved, or deleted (uploads add; the Recycle Bin relocates within the source volume)

**General delivery path across library types:**

1. **Phase 1 — Index existing libraries.** Admin registers a source path. App scans, indexes metadata from audio tags and folder names. Files are read-only.
2. **Metadata and thumbnails.** Type-specific scanners extract embedded metadata and generate browse artwork.
3. **Enrichment.** Per-item lookup from external providers where useful — user selects a match, metadata applied and locked against future scans.
4. **Sharing.** Libraries made public/private and individual items shared with specific users (or via guest links) through the unified permission model.
5. **Uploads.** Contributors upload their own content into a managed library's source folder; policy-gated and refused on external (read-only) libraries (see [`uploads.md`](uploads.md)).

### Notes

Personal and collaborative note-taking. Rich text, collections, visibility levels matching the sharing model, and full-text search via SQLite FTS5. Grouped by category. Detail document to be written when development begins.

### Background Jobs

A SQLite-backed job queue handles all slow work — scans, metadata extraction, thumbnail generation. No external infrastructure required. Workers claim jobs transactionally. Each starts its queue loop by recovering what a restart interrupted — a job left `running` by a dead process goes back to `pending`, unless it has used every attempt, in which case it is failed rather than resurrected (an out-of-memory job would otherwise restart the crash on every boot). Whatever is given up on releases the entity it belongs to, so nothing is left claiming to be mid-scan or mid-render. All job handlers are designed to be idempotent.

---

## Sharing and Permissions

Access runs through one unified model (the `assignments` table — see [`permissions.md`](permissions.md)). A single row means "this subject (a user or a group) holds this role on this object." Roles, weakest to strongest: `viewer`, `member`, `contributor`, `manager`; plus `deny` as an explicit block. An action is allowed when the user's resolved role permits it **and** the object's policy permits it.

- **Public vs private** is the presence of an `Everyone`-group grant on the library; the owner is just a `manager` assignment. There is no separate `visibility` column.
- **Server admins** act as `manager` on every object except a private one they hold no grant on (until they take ownership). `deny` does not affect admins.
- **Write policies** per library (`mode: managed | external`, `allowUpload`, `allowDelete`) gate only the source-touching actions (upload/delete); reads and metadata edits are never policy-blocked.

**Item-level sharing** is module-agnostic via `(module, resource_id)`. User-to-user shares (`shares`, permission `read`/`edit`/`manage`) grant a specific account access to one item; guest links (`share_links`, hashed token, required expiry) grant anyone with the link.

See [`permissions.md`](permissions.md) for the access engine, [`sharing.md`](sharing.md) for the item-sharing schema, and [`library-sharing.md`](library-sharing.md) for the library access roadmap.

---

## Technology Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript | Component reuse, potential mobile app later |
| Backend | Node.js + Fastify | Fast, TypeScript-native, plugin architecture |
| Database | SQLite (WAL mode) + FTS5 planned | File-based, no separate DB server, future full-text search |
| Audio metadata | `music-metadata` (npm) | Reads ID3, MP4, FLAC, OGG tags |
| Image processing | `sharp` (npm) | Thumbnail generation and WebP conversion |
| Auth | Session cookies + `scrypt` | Simple, secure, easy revocation |
| MFA | `otplib` + `qrcode` | TOTP two-factor, no external service |
| Background jobs | SQLite job queue | No external infrastructure |
| Metadata providers | `undici` / native `fetch` | OpenLibrary, LibriVox, Audible, FantLab, iTunes; SSRF-pinned remote image fetch |

---

## Architecture

```
React + TypeScript
        ↓  HTTP + cookies
Node.js + Fastify + TypeScript
        ↓
SQLite (WAL mode)
        ↓
Filesystem  ←→  Background job workers
```

### Backend structure

Routes are registered as Fastify plugins, grouped by domain:

```
apps/server/src/
  index.ts                    ← the Fastify instance (logger, helmet/CSP, CORS, CSRF,
                                 rate limit, multipart, error handler, static web app)
                                 and the plugins, in order: corePlugin,
                                 dashboardPlugin, usersPlugin, backupsPlugin,
                                 libraryPlugin, collectionsPlugin, storiesPlugin,
                                 socialPlugin, homePlugin, familyTreePlugin,
                                 maintenancePlugin
  core/                       ← platform infrastructure ONLY — no product knowledge
    index.ts                  ← corePlugin: registers the route plugins below
    health.ts                 ← GET /api/health, unauthenticated liveness for the
                                 Docker HEALTHCHECK / compose / Unraid probe
    error-handler.ts          ← the last stop for anything thrown: a 4xx stays that
                                 status, a real fault is logged and answered 500
    logger.ts                 ← the shared pino logger for code outside a request
                                 (workers, job recovery, backups)
    setup.ts, app-config.ts   ← first-run setup flag; install-wide default theme
    auth-routes.ts, sessions.ts, cookies.ts, csrf.ts
                              ← sign-in/out, live sessions (admin view + Profile →
                                 Devices), __Host- cookies, double-submit CSRF
    mfa.ts, mfa-routes.ts     ← TOTP, emailed codes, backup codes (see auth.md)
    webauthn.ts, webauthn-routes.ts   ← passkeys
    device-link.ts, device-link-routes.ts
                              ← sign a TV in by QR, and the admin's one-person
                                 remote window (see auth.md)
    api-tokens.ts             ← personal access tokens for non-cookie clients (OPDS)
    password-policy.ts        ← admin-tunable password rules
    permissions.ts            ← the unified assignments engine (see permissions.md)
    security.ts, security-routes.ts, security-alerts.ts
                              ← lockout, IP block, trusted networks, alert mail
    cidr.ts, probes.ts, blocked-page.ts
                              ← CIDR matching, scanner-probe paths, what a blocked
                                 address is shown
    ip-reputation.ts, geoip.ts ← AbuseIPDB lookups, on-disk GeoIP
    security-txt.ts           ← RFC 9116 /.well-known/security.txt
    safe-fetch.ts             ← SSRF-safe outbound HTTP (every hop checked, pinned)
    log-redaction.ts, logs.ts ← token masking in request logs; the activity-log API
    status.ts, status-contributors.ts
                              ← /api/status and the changelog feed; the registry
                                 media types add their counters to
    mail.ts, mail-routes.ts, email-template.ts, notifications.ts, notification-routes.ts
                              ← SMTP settings and sending, the house mail style,
                                 which notices may go out
    routing.ts, routing-routes.ts     ← road routing for story maps
    app-storage.ts            ← the App storage folder setting (its rooms are
                                 modules/library/app-storage*.ts)
    compression.ts            ← response compression for JSON and text
    shared.ts                 ← request helpers: parseBody / parseQuery, link origin
  modules/                    ← product features
    dashboard/                ← the control-panel Dashboard: sign-ins, activity
                                 charts, the Locations map and where "home" is on
                                 it (home-location.ts)
    users/                    ← profile, users, invites, groups (aggregate usersPlugin)
    uploads/                  ← the streaming upload primitive (see uploads.md)
    backups/                  ← index.ts routes, run.ts (the three kinds and how one
                                 is taken), zip-read.ts (restore without loading
                                 the archive into memory)
    collections/              ← cross-type user collections + membership cleanup
    stories/                  ← authored narrative pages over existing content:
                                 chapters (partial dates + place) holding text /
                                 photo / album / slideshow / map blocks, all by
                                 reference; story collections and their access,
                                 narration (recordings.ts, audio.ts), guest links
                                 (share.ts, share-routes.ts), recipe import, map
                                 route geometry
    social/                   ← Send to (routes.ts), notes on things (notes.ts), the
                                 subject resolver every cross-content feature asks
                                 (subjects.ts), the For you page, the activity cards,
                                 send-to email
    home/                     ← the home feed composer (ranked typed cards over
                                 library / gallery / social loaders) and the
                                 "Updated to X — what changed" note (whats-new.ts)
    familytree/               ← family members, unions/children, events, sources,
                                 gallery photo links, GEDCOM (see family-tree.md).
                                 View: any user. Edit: admin, or tag-scoped "branch
                                 editors" (access.ts). Persons can link to a gallery
                                 face cluster to auto-surface tagged photos.
    maintenance/              ← scheduled upkeep jobs + the Tasks view over the job queue
    library/
      shared/                 ← the cross-type layer: media-types (the registry
                                 each type fills in from its plugin, so trash, scan
                                 rules and the schedule never import a scanner),
                                 library crud / access / serializer / settings /
                                 source / types, members, metadata, thumbnail
                                 (+ audit), storage-roots (pathIsInside),
                                 remote-image, scan-lock (one library job at a
                                 time), job-progress / job-recovery, trash (+ move,
                                 routes), tagging (the cross-type tags engine),
                                 shares (the guest-link engine) / share-kinds /
                                 share-access / share-notify, scan-rules +
                                 scan-rule-pattern (scan layouts), folder locks,
                                 folder-move / storage-move, alphabet (+ index),
                                 series, book-helpers, catalog-core,
                                 document-stream, send-to-ereader
      audiobook/              ← media-type, scanner, enrich, mp4-chapters, people,
                                 saves, stats, providers/, stream, routes (books,
                                 series, metadata, source, categories)
      ebook/                  ← media-type, scanner, catalog, OPDS, routes, bookmarks
      gallery/  └ faces/ duplicates/
                              ← media-type, photo/video scanner, files (writing
                                 into a gallery library), albums, slideshows + render,
                                 memories, year in review, music, Photo Inbox
                                 (+ drop links), review mode, voice notes, face
                                 recognition, duplicate cleanup jobs (see
                                 gallery-library.md, duplicate-detection.md)
      app-storage.ts, app-storage-routes.ts, app-storage-contents.ts
                              ← App storage's rooms, their switches, and what each holds
      quotes.ts, quotes-import.ts, quotes-daily.ts
                              ← cross-type quotes, pack import, quote of the day
      works.ts                ← editions: one work over several items of the same book
      categories.ts, tags.ts, bookmarks.ts, covers.ts, feed.ts, settings.ts, storage.ts
  db.ts                       ← SQLite singleton: staged restore, pre-upgrade copy,
                                 schema + migrations, seed
  db/                         ← schema.sql (the whole schema), migrate.ts,
                                 pre-upgrade.ts, seed.ts (see database.md)
  changelog.ts                ← VERSION_UPDATES, the in-app changelog
  auth.ts, config.ts, crypto.ts, categories-seed.ts, types.ts
```

See CLAUDE.md ("Server architecture") for the core-vs-modules rule new code must follow.

### Frontend structure

```
apps/web/src/
  main.tsx                    ← createRoot mount + global styles
  app/                        ← App (session + routing), Shell, DashboardShell
  router.ts, api.ts           ← route types/navigation, API client
  pages/                      ← Login, Invite, Install, Home, Profile, About, Share, Theme
  shared/                     ← Modal, Button, ConfirmDialog, MessageBox, Field, … (see UI-CONVENTIONS.md)
  features/
    audiobooks/  └ reader/    ← audiobook pages + in-app reader
    library/                  ← cross-type library feed / tiles
    collections/  share/      ← collections UI, share dialogs
    stories/                  ← story index, reading view, block editor
    familytree/               ← person-centered SVG chart, people list, profiles
    control/  └ libraries/ sections/   ← control panel (admin)
  offline/  pwa/              ← installable-app + offline concerns
  assets/  └ backgrounds/ categories/
  vendor/foliate-js/          ← vendored EPUB reader
```

### Database

SQLite with WAL mode, `synchronous = NORMAL`, and `foreign_keys = ON`. All file content lives on disk — only metadata is in SQLite. Library type is enforced at the application layer (Zod) rather than a database CHECK constraint so new types can be added without a table rebuild.

### File storage

| Path | Purpose |
|---|---|
| `data/db/isputnik.sqlite` | Application database (WAL) |
| `data/cache/thumbnails/` (`THUMBNAIL_PATH`) | Generated covers and previews (sharded by resource ID) |
| `data/backups/` (`BACKUP_PATH`) | Backup archives and staged restores |
| `METADATA_PATH` (optional) | Imported/derived metadata assets |
| Configured library roots | Original media files — read-only to scans; uploads add here, the Recycle Bin relocates within them |

---

## Build Order

1. **Done** — Auth and user management (setup admin, sessions, invites, account management)
2. **Done** — App shell (navigation, profile, themes, protected routes)
3. **Done** — Control panel (user/session admin, logs, status, About)
4. **Done** — Digital Library infrastructure (storage roots, thumbnail config, audiobook + ebook scan)
5. **Done** — Audiobook library (metadata/enrichment, m4b chapters, manual editor, playback, bookmarks)
6. **Done** — Uploads and Recycle Bin across library types
7. **Done** — Sharing & access control — unified permission model, public/private libraries, item shares + guest links
8. **Done** — Backup and restore tooling
9. **Done** — Ebook library + in-app EPUB reader (foliate-js)
10. **Done** — Cross-type browse — Categories, Tags, Likes, Collections, Home feeds
11. **Done** — Security hardening — rate limiting, SSRF/ReDoS/path-traversal fixes
12. **Future** — Notes module
13. **Future** — Group ownership/membership for libraries
14. **Future** — Photo/video library types, mobile app

---

## Release process

A release is five things, in this order:

1. Bump `version` in all three `package.json` files (root, `apps/server`, `apps/web`)
   and in `package-lock.json`. The root one is what the running server reports, with
   its `stage` field (`"beta"`) shown beside it on the About page — the stage is kept
   out of the version string so `latest` keeps following every tag.
2. Add the entry to `VERSION_UPDATES` at the top of `apps/server/src/changelog.ts` —
   that array is the changelog the About page shows, and the one source of truth.
3. Run `npm run changelog`. It regenerates the repo-root `CHANGELOG.md` from
   `changelog.ts` (`scripts/changelog-md.mjs`); never edit `CHANGELOG.md` by hand.
4. Commit all of it together, on its own, subject `release: <version> - <label>`.
5. Push main, then push an annotated `v<version>` tag.

The `release:` prefix is load-bearing, not decoration: `.github/workflows/docker.yml`
builds every push to main as a dry run (packaging is the one thing tests can't catch)
and publishes on tags. Since a release pushes the commit and then the tag seconds
apart, the workflow skips the dry run for a commit whose subject starts with
`release:` — otherwise the same tree is built twice, back to back. A tag first runs
the full test workflow (`test.yml`, called from `docker.yml`) and publishes the
image only when it passes. Once the image is out, a last job creates the tag's
GitHub Release (or updates it, on a re-run), its notes that version's entry from
`changelog.ts` (`node scripts/changelog-md.mjs --version <tag>`) — so a tag whose
image failed to publish never gets a release page, and a tag with no changelog
entry fails that job rather than publishing empty notes.

---

## Related Documents

| Document | Contents |
|---|---|
| [`permissions.md`](permissions.md) | Access engine — unified `assignments` model, roles, write policies, admin rules |
| [`sharing.md`](sharing.md) | Item-level sharing — `shares` / `share_links` schema, access resolution |
| [`library-sharing.md`](library-sharing.md) | Library access model and roadmap |
| [`auth.md`](auth.md) | Authentication detail — sessions, invite flow, MFA (TOTP), hardening status |
| [`audiobook-library.md`](audiobook-library.md) | Audiobook library type — scan pipeline, metadata, phases, schema |
| [`database.md`](database.md) | Database schema — unified `library_items` model, conventions, old→new map, table reference |
| [`ebook-library.md`](ebook-library.md) | Ebook library type — EPUB/PDF catalog, in-app reader, per-type series |
| [`gallery-library.md`](gallery-library.md) | Gallery library type — photos/videos, asset-as-item, timeline + folder views |
| [`duplicate-detection.md`](duplicate-detection.md) | Duplicate detection — fingerprints, the five tiers, keeper scoring, cleanup jobs |
| [`family-tree.md`](family-tree.md) | Family tree — people/unions/events, borrowed gallery photos, branch permissions, GEDCOM |
| [`categories.md`](categories.md) | Categories — global genre taxonomy, scan matching, cross-type browse |
| [`tags.md`](tags.md) | Tags — polymorphic labels, cross-type browse, admin management |
| [`uploads.md`](uploads.md) | Upload process — end-to-end flow, streaming primitive, adding consumers |
| [`recycle-bin.md`](recycle-bin.md) | Recycle Bin — trash / restore / purge across library types |
| [`scanner.md`](scanner.md) | How the scanners walk, group, ingest and reconcile files; job queue + worker |
| [`gallery-slideshows.md`](gallery-slideshows.md) | Slideshows — editor, music, title and closing cards, MP4 render |
| [`lightbox-panel.md`](lightbox-panel.md) | The gallery lightbox's side panel and the shared recorder / wave player |
| [`UI-CONVENTIONS.md`](UI-CONVENTIONS.md) | Frontend UI conventions — shared Modal / Button / ConfirmDialog / MessageBox |
| [`css-map.md`](css-map.md) | Stylesheet map — import order, what each file styles, the two barrels, themes |
| [`configuration.md`](configuration.md) | Every environment variable — defaults, and where the image, compose and Unraid set them |
| [`rollback.md`](rollback.md) | Upgrading and rolling back — the automatic pre-upgrade copy, image tags, restoring by hand |
| [`hosting.md`](hosting.md) | Reverse-proxy trust — `TRUST_PROXY` / `TRUST_PROXY_HOPS` semantics |
| [`users/`](users/README.md) | The user guides — the same pages the in-app Help lists |

**Design records.** Plans and proposals for features that have shipped, kept for the
decisions and reasoning behind them. Each opens with a `Status:` line saying what
shipped and what, if anything, is still open; where one disagrees with the code or
the living docs above, those win.

| Document | Feature |
|---|---|
| [`scan-layout-plan.md`](scan-layout-plan.md), [`custom-scan-rules-proposal.md`](custom-scan-rules-proposal.md) | Scan layouts (3.62.0) and the proposal they superseded |
| [`alphabet-approach-proposal.md`](alphabet-approach-proposal.md) | The A–Z strip and script-aware alphabets (3.4.0) |
| [`iSputnik-Remote-Device-Linking-Plan.md`](iSputnik-Remote-Device-Linking-Plan.md) | Linking a device from outside the house (3.6.0) |
| [`gallery-slideshows-proposal.md`](gallery-slideshows-proposal.md) | Custom slideshows and rich Memories (by 1.11.0) |
| [`gallery-memories-albums-proposal.md`](gallery-memories-albums-proposal.md) | Memories, multi-select, share links, albums |
| [`family-sharing-proposal.md`](family-sharing-proposal.md) | Send to, notes, the subject resolver |
| [`stories-proposal.md`](stories-proposal.md), [`stories-v2-proposal.md`](stories-v2-proposal.md) | Stories (3.43.0) and v2: collections, chapter pages, kinds (3.44.0–3.50.1) |
| [`recipes-plan.md`](recipes-plan.md) | Recipes as a story kind (3.66.0) |
| [`quotes-plan.md`](quotes-plan.md) | Quote import, quote of the day, family-tree speakers (3.32.0–3.34.0) |
| [`photo-inbox-proposal.md`](photo-inbox-proposal.md) | Photo Inbox and drop links (3.67.0) |
| [`photo-review-plan.md`](photo-review-plan.md), [`for-you-plan.md`](for-you-plan.md) | Review mode, Ask someone, voice notes (3.71.0–3.76.1); the For you page (3.74.0) |
| [`app-storage-plan.md`](app-storage-plan.md) | App storage and its rooms (3.77.0 onwards) |
| [`i18n-plan.md`](i18n-plan.md) | The Russian UI and the `t()` sweep (complete 2026-08-27) |
| [`archive/`](archive/README.md) | Older records nothing in the code points at any more |
