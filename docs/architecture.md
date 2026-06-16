# isputnik.home — Architecture

**Slogan:** our world revolves around you.

## Overview

isputnik.home is a private, self-hosted web app for friends and family. It provides a shared digital space built around a **Digital Library** for media — audiobooks and ebooks today, with photo/video types and a **Notes** module planned. Everything runs on a home server — no cloud accounts, no external services required.

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
- Cross-type Favorites and Collections — user-curated lists spanning audiobooks and ebooks
- Home dashboard — Continue and Recently added feeds across types
- PWA/offline — installable app shell, account-aware cache cleanup, durable downloaded-book metadata, offline player/detail fallback, reconnect progress sync, and cover-cache revalidation
- Security hardening — per-IP rate limiting, SSRF DNS-rebinding fix on remote image fetches, ReDoS fixes, and path-traversal-safe static serving

### Planned

- Notes module — rich text, tags, visibility, full-text search
- Group ownership / membership for libraries (the `assignments` engine already supports group subjects)

### Future Updates

- MFA (TOTP) — see [`auth.md`](auth.md)
- Photo and video library types
- Mobile app

---

## Users and Roles

| Role | Access |
|---|---|
| Admin | Invite users, manage accounts, view logs, configure app, monitor status |
| Member | Use all modules, manage own profile and content |

Registration is invite-only. Admins generate a single-use invite link and share it directly. No SMTP required. See [`auth.md`](auth.md) for session, invite, and future MFA detail.

---

## Modules

### Digital Library

The primary content module. Supports multiple **library types** — each type has its own scanner, metadata jobs, display logic, and database tables. The `libraries` table is shared; type-specific tables live alongside it.

**Library types:**

| Type | Status | Detail |
|---|---|---|
| Audiobook | Active | [`audiobook-library.md`](audiobook-library.md) |
| Ebook | Active (EPUB/PDF, in-app reader) | [`ebook-library.md`](ebook-library.md) |
| Photo | Planned | — |
| Video | Planned | — |
| Podcast | Future | — |

**Shared across all library types:**

- Background job queue for scans, metadata extraction, thumbnail generation
- Sharded thumbnail cache at `THUMBNAIL_PATH`
- Access via the unified permission model — per-object role assignments (Everyone group = public, owner = manager) with per-library write policies; item-level sharing via `shares` and `share_links` ([`permissions.md`](permissions.md))
- Collections, Favorites, and Tags — cross-type, shared across all library types
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

A SQLite-backed job queue handles all slow work — scans, metadata extraction, thumbnail generation. No external infrastructure required. Workers claim jobs transactionally; stale locks are released after a timeout so jobs can be retried. All job handlers are designed to be idempotent.

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
| MFA (future) | `otplib` + `qrcode` | TOTP, no external service |
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
  index.ts                    ← registers corePlugin, usersPlugin, backupsPlugin,
                                 libraryPlugin, collectionsPlugin
  core/                       ← platform infrastructure ONLY: auth-routes, sessions,
                                 permissions, app-config, setup, logs, status, shared
  modules/                    ← product features
    users/                    ← profile, users, invites, groups (aggregate usersPlugin)
    uploads/                  ← upload streaming helpers
    backups/                  ← backup / restore
    collections/              ← cross-type user collections
    library/
      shared/                 ← library crud / access / serializer, trash, members,
                                 metadata, thumbnail, storage-roots, remote-image
      audiobook/              ← scanner, enrich, chapters, people, providers/, routes
      ebook/                  ← scanner, catalog, routes, bookmarks
      categories.ts, tags.ts, bookmarks.ts, covers.ts, feed.ts, settings.ts, storage.ts
  db.ts                       ← SQLite singleton, schema, migrations
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
10. **Done** — Cross-type browse — Categories, Tags, Favorites, Collections, Home feeds
11. **Done** — Security hardening — rate limiting, SSRF/ReDoS/path-traversal fixes
12. **Future** — Notes module
13. **Future** — Group ownership/membership for libraries
14. **Future** — MFA, photo/video library types, mobile app

---

## Related Documents

| Document | Contents |
|---|---|
| [`permissions.md`](permissions.md) | Access engine — unified `assignments` model, roles, write policies, admin rules |
| [`sharing.md`](sharing.md) | Item-level sharing — `shares` / `share_links` schema, access resolution |
| [`library-sharing.md`](library-sharing.md) | Library access model and roadmap |
| [`auth.md`](auth.md) | Authentication detail — sessions, invite flow, future MFA |
| [`audiobook-library.md`](audiobook-library.md) | Audiobook library type — scan pipeline, metadata, phases, schema |
| [`audiobook-db.md`](audiobook-db.md) | Audiobook database ER diagram and table reference |
| [`ebook-library.md`](ebook-library.md) | Ebook library type — EPUB/PDF catalog, in-app reader, per-type series |
| [`categories.md`](categories.md) | Categories — global genre taxonomy, scan matching, cross-type browse |
| [`tags.md`](tags.md) | Tags — polymorphic labels, cross-type browse, admin management |
| [`uploads.md`](uploads.md) | Upload process — end-to-end flow, streaming primitive, adding consumers |
| [`recycle-bin.md`](recycle-bin.md) | Recycle Bin — trash / restore / purge across library types |
| [`UI-CONVENTIONS.md`](UI-CONVENTIONS.md) | Frontend UI conventions — shared Modal / Button / ConfirmDialog / MessageBox |
