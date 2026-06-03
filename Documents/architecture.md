# isputnik.home — Architecture

**Slogan:** our world revolves around you.

## Overview

isputnik.home is a private, self-hosted web app for friends and family. It provides a shared digital space built around a **Digital Library** for media and a **Notes** module for personal and shared writing. Everything runs on a home server — no cloud accounts, no external services required.

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

**Status snapshot: June 1, 2026**

### Completed

- React + TypeScript frontend, Node.js + Fastify + TypeScript backend, SQLite database
- Admin setup, email/password login, cookie sessions, invite-only registration, protected routes
- App shell: navigation, profile, light/dark/system themes
- Control panel: user/role/session management, invite links, activity logs, system status, About
- Digital Library infrastructure: storage containers, thumbnail configuration, audiobook library registration and scan

- Audiobook playback — resume progress, per-user position bookmarks with notes, and a saved-books "My List"
- Genre model — fixed navigation **categories** (keyword-matched per scan with English default aliases) plus global, cross-type **tags**; admin Control Panel screen to manage categories, edit per-category mappings, promote scanned tags into keywords, and instantly re-match existing books
- Special Sections — group audiobook libraries under a master sidebar entry with their books hidden from the main grid, plus per-library overwrite-on-add for Author, Narrator, Description, Category, and Tags

### In Progress

- Audiobook library Phase 3 — metadata lookup and sidecar import are active; manual edit UI polish remains

### Planned

- Digital Library sharing — library and item access control
- Notes module — rich text, tags, visibility, full-text search
- Backup and restore tooling

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
- Library-level access via ownership model (`owner_id` + `visibility`); item-level sharing via `shares` and `share_links` (planned)
- Collections — user-curated lists shared across all library types and Notes
- Soft delete — `deleted_at` on all content, 30-day retention before purge
- Safety rule — source files are never renamed, moved, or deleted

**General delivery path across library types:**

1. **Phase 1 — Index existing libraries.** Admin registers a source path. App scans, indexes metadata from audio tags and folder names. Files are read-only.
2. **Metadata and thumbnails.** Type-specific scanners extract embedded metadata and generate browse artwork.
3. **Enrichment.** Per-item lookup from external providers where useful — user selects a match, metadata applied and locked against future scans.
4. **Sharing.** Libraries and items shared with users or family via the common permission model.
5. **Later — Managed uploads.** Users upload their own content into `/data/media/`.

### Notes

Personal and collaborative note-taking. Rich text, collections, visibility levels matching the sharing model, and full-text search via SQLite FTS5. Grouped by category. Detail document to be written when development begins.

### Background Jobs

A SQLite-backed job queue handles all slow work — scans, metadata extraction, thumbnail generation. No external infrastructure required. Workers claim jobs transactionally; stale locks are released after a timeout so jobs can be retried. All job handlers are designed to be idempotent.

---

## Sharing and Permissions

A single `shares` table is reused across all modules for item-level sharing. Visibility levels: `private`, `family`, `shared` (specific users), `link` (anyone with the link). Permission levels: `read`, `edit`, `manage`. Public link tokens are stored hashed in `share_links`.

**Library-level access** uses an ownership model. Each library has an `owner_id`, an `owner_type` (`user` or `group`), and a `visibility` (`private` or `public`). Public libraries are accessible to all active users. Private libraries are accessible to the owner and admins only. Only the owner or an admin can edit library content — non-owners are always read-only. Group ownership is planned for Phase 2.

See [`sharing.md`](sharing.md) for the general sharing schema and [`library-sharing.md`](library-sharing.md) for the library access model and roadmap.

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
| OpenLibrary API | Native `fetch` | Free metadata enrichment, no key required |

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
  index.ts                    ← registers corePlugin + libraryPlugin
  core/                       ← auth, setup, users, sessions, invites, logs, status
  modules/
    library/
      shared/                 ← thumbnail helpers, storage-root helpers, library-types
      audiobook/              ← scanner, enricher, routes, serializers
      settings.ts, covers.ts, storage.ts
  db.ts                       ← SQLite singleton, schema, migrations
  auth.ts, config.ts, crypto.ts, types.ts
```

### Frontend structure

```
apps/web/src/
  main.tsx                    ← createRoot mount only
  app/                        ← App (session + routing), Shell, DashboardShell
  router.ts                   ← Route types, navigate, useRoute
  pages/                      ← Install, Login, Invite, Home, Profile, About
  shared/                     ← Field, MessageBox, AccountForm, AboutDetails, utils
  features/
    audiobooks/               ← AudiobooksPage, types
    control/                  ← ControlPanelPage (nav dispatcher)
      sections/               ← Users, Invites, Sessions, Logs, Status, About, Storage, Libraries
```

### Database

SQLite with WAL mode, `synchronous = NORMAL`, and `foreign_keys = ON`. All file content lives on disk — only metadata is in SQLite. Library type is enforced at the application layer (Zod) rather than a database CHECK constraint so new types can be added without a table rebuild.

### File storage

| Path | Purpose |
|---|---|
| `data/db/isputnik.sqlite` | Application database |
| `data/cache/thumbnails/` | Generated covers and previews (sharded by resource ID) |
| `data/media/` | Future managed uploads |
| Configured library roots | Original media files — read-only |

---

## Build Order

1. **Done** — Auth and user management (setup admin, sessions, invites, account management)
2. **Done** — App shell (navigation, profile, themes, protected routes)
3. **Done** — Control panel (user/session admin, logs, status, About)
4. **Done** — Digital Library infrastructure (storage containers, thumbnail config, audiobook scan)
5. **Done** — Audiobook library Phase 2 (metadata, covers, async scan)
6. **Next** — Audiobook library Phase 3 (lookup/enrichment and manual metadata)
7. **Planned** — Digital Library sharing Phase 1 — library ownership and visibility (private / public)
8. **Planned** — Backup and restore tooling
9. **Future** — Notes module
10. **Future** — MFA
11. **Future** — Photo and video library types

---

## Related Documents

| Document | Contents |
|---|---|
| [`audiobook-library.md`](audiobook-library.md) | Audiobook library type — scan pipeline, metadata, phases, schema |
| [`audiobook-db.md`](audiobook-db.md) | Audiobook database ER diagram and table reference |
| [`special-section.md`](special-section.md) | Special Sections — library grouping and per-library metadata overrides |
| [`auth.md`](auth.md) | Authentication detail — sessions, invite flow, future MFA |
| [`sharing.md`](sharing.md) | Sharing model — general `shares` / `share_links` schema, access resolution |
| [`library-sharing.md`](library-sharing.md) | Library access model — ownership, visibility, Phase 1 schema, roadmap |
