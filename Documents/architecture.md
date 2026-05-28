# isputnik.home — Project Summary

**Slogan:** our world revolves around you.

## Overview

isputnik.home is a self-hosted web application designed for private use by friends and family. It provides a shared digital space with planned personal and collaborative modules including a media library and notes. The application runs on a home server and is accessible via web browser, with a mobile app as a potential future extension.

---

## Goals

- Private, self-hosted — no third-party cloud dependency
- Simple enough for non-technical family members to use
- Modular by design — new features can be added without restructuring the codebase
- Shared and personal content — each module supports both private and family-wide access
- Minimal infrastructure — no external services required to run

---

## Design Principles

- Private and self-hosted
- Family-friendly
- Simple to maintain
- Modular and extensible
- Smart file processing
- Minimal infrastructure dependencies
- Future-ready for additional modules

---

## Implementation Status

**Status snapshot: May 26, 2026**

### Completed Foundation

- React and TypeScript frontend with a Node.js, Fastify, TypeScript, and SQLite backend
- Initial admin setup, email/password sign-in, logout, cookie-backed sessions, and protected routes
- Invite-only registration with invitation creation, link copying, active/expired/used status, and revocation
- App shell with consistent top navigation, control-panel navigation, profile access, and role-protected admin pages
- User profile editing and light, dark, and system theme preferences
- Admin panel: account roles/deactivation, invite management, active session revocation, logs, system status, and About page

### Completed Admin Panel Foundation

- The existing control panel groups Application pages (Status, Logs, About) and User administration pages (Users, Invite links, Sessions); Status is the default entry point
- Administrators can assign roles, deactivate non-protected accounts, and revoke other active sessions
- Logs record authentication and administrative events in SQLite, with search, pagination, and manual retention cleanup
- Status reports application health, database size, counts, and server uptime
- About is available from both the main app and control panel and shows application identity, version, runtime/stack information, and version update notes

### Next Core Milestone

- Build Digital Library Phase 1: audiobook library type — existing-folder registration, scan and index, background metadata extraction, cover art thumbnails, and OpenLibrary enrichment
- Extend system status with storage, asset, and job information as those services exist

### Future Updates

- MFA with TOTP setup, verification, and backup recovery codes
- Notes with visibility, sharing, tagging, and search

---

## Users and Roles

| Role | Capabilities |
|---|---|
| Admin | Invite users, manage accounts, view logs, configure app, monitor system status |
| Member | Use all modules, manage own profile and content |

Registration is invite-only. The admin generates an invite link (e.g. `https://yourapp/invite/abc123`) which is shared directly — via message, email, or in person. No SMTP or external email service required.

Invite links are single-use by default and expire after a configurable period. The token hash is used for validation, while the token is retained so admins can copy existing invitation links from the control panel. Admins can revoke pending invites at any time.

---

## Core Features

### Authentication

Session-based authentication using secure httpOnly cookies. Simpler than JWT for a single-server home app, with straightforward session revocation.

**Implemented:**

- Initial setup creates the protected administrator account
- Email and password login with Node.js `scrypt` password hashing
- Sessions stored in SQLite and identified by a hashed secure cookie token
- Logout revokes the current session; deactivating a user revokes that user's sessions
- Authentication and administrator route guards
- Single-use invitation acceptance for creating member accounts

Session cookies are configured with:

- `HttpOnly` so client-side JavaScript cannot read them
- `Secure` in production so cookies are only sent over HTTPS
- `SameSite=Lax`
- Configurable expiration backed by the SQLite session record

**Planned hardening and administration:**

- Admin view and revocation of active sessions per user
- CSRF protection for mutating authenticated routes
- Rate limiting for login, invitation acceptance, and future recovery flows
- Session ID rotation for any future multi-step authentication flow

Session table:

```sql
sessions
--------
id, user_id, created_at, expires_at, last_seen,
device_name, ip_address, revoked_at
```

#### MFA (Future Update)

- Optional MFA per user (TOTP - Google Authenticator, Authy, Apple Passwords)
- Backup recovery codes generated during setup, shown once, and available if the authenticator app is unavailable

**Login flow with MFA enabled:**

```
POST /auth/login
  → verify email + password
  → if mfa_enabled: issue short-lived mfa_pending cookie (5 min)
  → frontend shows 6-digit code entry screen

POST /auth/mfa/verify
  → validate mfa_pending cookie
  → verify TOTP code against stored secret
  → if valid: create full session
  → if invalid: increment attempt counter (lock after 5 failures)
```

MFA fields on the users table:

```sql
users (additions)
-----------------
mfa_enabled           -- 0 or 1
mfa_secret_encrypted  -- encrypted TOTP secret, set during setup
mfa_backup_codes      -- JSON array of hashed one-time recovery codes
```

Recovery codes are single-use. When a recovery code is used successfully, it is removed or marked as consumed and a new set can be generated from the profile security screen.

### User Profiles

- Implemented: display-name editing, email display, account icon, and personal theme preference
- Future update: MFA setup and management - enable/disable, view backup codes, regenerate codes

### Themes (Implemented)

- Light, dark, and system-default modes
- Preference stored per user and applied on login

### User Management (Admin) - Implemented Foundation

**Implemented:**

- Generate, list, copy, and revoke invite links - no email infrastructure needed
- Display active, expired, and already-used invitation status
- List and deactivate accounts with delete confirmation and protected setup-admin handling
- Assign member or administrator roles
- View and revoke active sessions

**Future MFA work:**

- Optionally enforce MFA for specific accounts or all admins

### Logs (Admin) - Implemented Foundation

- Login, invite, profile, role, session, and account-administration events
- Stored in the main SQLite database
- Compact searchable and paged viewer
- Manual deletion of entries older than a selected retention period, defaulting to 365 days
- Future content modules can add uploads and sharing actions

### System Status (Admin) - Implemented Foundation

- Current health, database size, user/session/invitation counts, log entry count, and server uptime
- Future Library and backup work adds total asset count, media disk usage, background job queue status, and last backup date

### About Page - Implemented

- Application name and version
- Build/runtime details useful for administration and support
- Version update notes describing completed product changes
- Project and license information where appropriate

---

## Sharing and Permissions

A single `shares` table is reused across all modules, keeping sharing behaviour consistent everywhere.

### Visibility levels

| Level | Meaning |
|---|---|
| `private` | Owner only |
| `family` | All registered users |
| `shared` | Specific users granted access |
| `link` | Anyone with the link |

### Permission levels

| Level | Meaning |
|---|---|
| `read` | View only |
| `edit` | Modify content |
| `manage` | Edit plus share with others |

```sql
shares
------
id, module, resource_id,
user_id,              -- nullable; set for user-specific shares
permission,
created_by,
created_at,
revoked_at
```

Public link sharing is tracked separately so links can be revoked, expired, and stored safely without exposing raw tokens in the database.

```sql
share_links
-----------
id, module, resource_id,
token_hash,
permission,
expires_at,
created_by,
created_at,
revoked_at
```

Effective access is resolved in this order: owner access, admin access, family visibility, explicit user share, then valid link share.

Because `shares` and `share_links` reference resources by `module` and `resource_id`, referential integrity is enforced by module services rather than direct database foreign keys. When a resource is deleted or purged, its shares and link shares are deleted in the same transaction.

Indexes are required on:
- `shares(module, resource_id)`
- `shares(user_id)`
- `share_links(token_hash)`
- `share_links(module, resource_id)`

---

## Tags

User-defined tags are a shared system used across all modules — the Digital Library, Notes, and any future module. Tags are freeform labels created by users, separate from structured metadata such as genres.

Tags are global. The same tag (e.g. "family favourite") can be applied to an audiobook, a photo, and a note. The `module` column on `resource_tags` scopes queries per module without isolating the tags themselves.

```sql
tags
----
id, name, created_by, created_at

UNIQUE (name)


resource_tags
-------------
id, module, resource_id, tag_id, created_by, created_at

UNIQUE (module, resource_id, tag_id)
```

A `tag_usage` view provides per-module counts for the UI so popular tags surface and orphaned ones can be hidden.

Full schema, indexes, and usage view are defined in each module's detail document.

---

## Modules

### Digital Library

The Digital Library supports multiple library types. Each type has its own metadata schema, scan behaviour, background processing jobs, display logic, and settings. The library type is set when an administrator creates a library and determines how the folder is scanned, what metadata is extracted, and how content is presented.

#### Library types

| Type | Status | Detail document |
|---|---|---|
| Audiobook | Phase 1 — next milestone | `Documents/digital-library-audiobook.md` |
| Photo | Planned | — |
| Video | Planned | — |
| Podcast | Future consideration | — |

#### Shared infrastructure across all library types

All library types share the following:

- The `libraries` table — name, type, source path, type-specific settings stored as JSON, scan status
- A background job queue for all slow work — scans, metadata extraction, thumbnail generation
- Sharded thumbnail cache at `THUMBNAIL_PATH` — generated previews for every library type stored in one application-managed location
- The `shares` and `share_links` tables for library and item-level access control
- The global `tags` and `resource_tags` tables for user-defined labels
- Soft delete — `deleted_at` on all content records, 30-day retention before purge
- Safety rules — original source files are never renamed, moved, or deleted; only paths beneath a registered `source_path` are accessed

#### Delivery phases (all library types follow this pattern)

**Phase 1 — Index existing libraries**

An administrator registers a source path on the server. The application scans the path, creates database records referencing the original files in place, and runs background jobs to extract metadata and generate thumbnails. Original files are read-only throughout Phase 1.

**Phase 2 — Users and sharing**

Libraries and individual items are made available to selected users or all family members using the common sharing and permission model.

**Later — Managed uploads**

Users upload their own content directly into the application. Stored under `/data/media/` rather than indexed in place. The same metadata, preview, and sharing model applies.

#### Existing-library safety rules (all types)

- Permit only validated server-side paths configured by an administrator
- Store the library root and relative item path; do not expose arbitrary filesystem paths to regular users
- Resolve paths during scans and do not follow symbolic links outside the approved library root
- Read originals for scanning and display only — do not rename, move, or delete source files in Phase 1
- Detect additions, changes, and missing files during rescans using path, size, modified time, and content hash
- Keep generated thumbnails outside source folders

#### Managed upload safety rules (all types, later)

- Enforce configurable max file size and per-user storage quotas
- Store files using generated storage names, never user-provided paths
- Detect file type from content, not only from extension
- Keep original filenames only as display metadata
- Reject or quarantine files that fail validation
- Clean up partial files if upload or database insert fails

#### Audiobook library — summary

The audiobook library type treats a **folder** as the primary unit, not a file. Each subfolder containing audio files becomes one book. The scanner indexes book folders, extracts embedded audio metadata (ID3, MP4 tags), finds or generates cover art, groups books into series and author records, and optionally enriches metadata from the OpenLibrary API.

Key characteristics:

- Book = folder; files within the folder are the book's chapters or parts
- First-class support for series, authors, narrators, and genres
- Playback progress tracked per user per book — position in seconds, percent complete, completed flag
- OpenLibrary enrichment for description, ISBN, genres, and cover art (free API, no key required)
- User-defined tags via the shared tags system
- Recommended folder structure: `Author / Book title / audio files`

For full schema, scan pipeline, metadata priority rules, OpenLibrary integration, rescan behaviour, thumbnail storage, and technology dependencies, see:

> **`Documents/digital-library-audiobook.md`**

---

## Background Job System

A lightweight SQLite-backed job queue handles all slow processing tasks asynchronously. A library can be registered immediately while scanning and preview generation continue in the background.

Jobs used for:
- Library initial scans and rescans (all types)
- Thumbnail and preview generation
- Audio metadata extraction
- Cover art extraction
- OpenLibrary enrichment
- Video preview generation (future)
- OCR (future)
- Face recognition scans (optional, future)
- Cleanup and maintenance tasks

```sql
jobs
----
id, type, payload,
status,
attempts,
max_attempts,
run_at,
locked_at,
locked_by,
created_at,
completed_at,
failed_at,
error
```

Workers claim jobs by setting `locked_at` and `locked_by` inside a transaction. If a worker crashes, stale locks can be released after a timeout and the job retried. Job handlers should be idempotent where possible because a job may be attempted more than once.

No external queue infrastructure (Redis, etc.) is needed at this scale.

---

## Soft Delete / Trash

Content is never permanently deleted immediately. A `deleted_at` timestamp is set instead. Items are automatically purged after 30 days.

Applies to: books, assets, notes, and optionally user accounts (deactivation).

---

## Backup and Restore

Because the application state is primarily the SQLite database, configured media sources, generated preview cache, and app configuration, backups must clearly distinguish managed application data from externally stored originals.

**A complete backup includes:**
- SQLite database file
- Any future application-managed upload folder
- App configuration/settings
- Original library source folders, when they are not already protected by the user's existing backup solution

The configured `THUMBNAIL_PATH` cache can be included for faster restoration or regenerated from restored originals. It is not the authoritative copy of library content. In Docker deployments, it must be mounted outside the disposable container if the operator wants to retain generated previews across upgrades.

**Goal:** one-click export and import for application-managed data, together with a clear warning when externally indexed library sources are outside that backup. If the server fails, restoring the database and accessible original sources lets the application rebuild previews and resume normally.

Backups should use SQLite's backup API or an application-controlled maintenance window so the database snapshot is consistent. External library originals remain the responsibility of their configured backup location.

A restore validates that the database, managed media folder, and configuration belong to the same backup set before replacing active application state, then checks that configured external library roots are reachable before rescanning.

---

## Architecture

```
React + TypeScript
        ↓
Node.js + Fastify + TypeScript
        ↓
SQLite (WAL mode + FTS5)
        ↓
Filesystem storage
        ↓
Background job workers
        ↓
Optional Python AI services (face recognition)
```

### Frontend — React + TypeScript

- Single-page application
- Session-based auth context guards all routes
- Theme system built on CSS variables
- Structured for potential extraction into a monorepo shared package if a second app is built later

### Backend — Node.js + Fastify + TypeScript

- Implemented: SQLite-backed hashed session tokens with `@fastify/cookie`
- Implemented: Zod validation on current routes
- Implemented: auth guard as a Fastify decorator, applied per protected route
- Planned: plugin-based module route registration as content modules are added
- Planned: `@fastify/multipart` for file uploads

### Database — SQLite

Configured at startup:

```sql
PRAGMA journal_mode=WAL;      -- concurrent reads and writes
PRAGMA synchronous=NORMAL;    -- safe and fast
PRAGMA foreign_keys=ON;       -- enforce referential integrity
```

WAL mode is active now. As content modules are added, it will allow background workers to write while users are browsing without locking. FTS5 is planned for future Notes, document text, and OCR search.

### File storage

Files are stored on disk — never in SQLite. Only metadata lives in the database.

Configurable storage paths:

| Setting | Default container path | Access | Purpose |
|---|---|---|---|
| `DB_PATH` | `/data/db/isputnik.sqlite` | Read/write | Application SQLite database |
| `THUMBNAIL_PATH` | `/data/cache/thumbnails` | Read/write | Shared sharded thumbnail and preview cache for all library types |
| Library source paths | `/libraries/<name>` | Read-only in Phase 1 | Existing original media files |

```
/data
  /db                  ← SQLite database files
  /media               ← future application-managed uploads and note attachments
  /cache
    /thumbnails        ← sharded generated previews for all Digital Libraries

Configured external library roots (read-only, indexed in place)
  /libraries/audiobooks  ← existing audiobook folders
  /libraries/photos      ← future photo library
  /libraries/videos      ← future video library
```

**Docker storage model:**

```yaml
services:
  isputnik:
    environment:
      THUMBNAIL_PATH: /data/cache/thumbnails
    volumes:
      - ./data/cache/thumbnails:/data/cache/thumbnails
      - /host/audiobooks:/libraries/audiobooks:ro
      - /host/photos:/libraries/photos:ro
```

- Mount `THUMBNAIL_PATH` read/write on persistent storage — container replacement removes all generated previews otherwise
- Mount existing source libraries read-only, then register the container-visible path in the application
- Store container-visible paths in the database, not host paths

---

## Technology Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript | Component reuse, potential mobile app later |
| Backend | Node.js + Fastify | Fast, TypeScript-native, plugin architecture |
| Database | SQLite + WAL; FTS5 planned | Simple, file-based, no separate DB server, future full-text search |
| Audio metadata | `music-metadata` (npm) | Reads ID3, MP4, FLAC, OGG tags for audiobook library |
| File handling (planned) | Filesystem scanner + Sharp; `@fastify/multipart` later | Index existing libraries and generate thumbnails before optional uploads |
| Auth | Session cookies + Node.js `scrypt` | Simple, secure, easy revocation |
| MFA (future update) | `otplib` + `qrcode` | TOTP-based two-factor auth, no external service needed |
| Background jobs (planned) | SQLite job queue | No external infrastructure needed |
| OpenLibrary API | Native `fetch` | Free audiobook metadata enrichment, no key required |
| Face recognition | Python sidecar (optional) | Keeps main stack clean; easy to omit initially |

---

## Folder Structure

```
/apps
  /web                   ← React frontend
  /server                ← Node.js Fastify backend
    /core                ← auth, users, themes, logs, sessions
    /modules
      /library           ← Library routes, type registry, shared infrastructure
        /types
          /audiobook     ← audiobook scanner, metadata jobs, OpenLibrary
          /photo         ← future
          /video         ← future
      /notes             ← Notes routes, search, DB tables
    /workers             ← background job processors
  /face-service          ← optional Python microservice
/data
  /db                    ← SQLite database files
  /media                 ← future managed uploads and attachments
  /cache/thumbnails      ← sharded generated previews for all libraries
/Documents
  /architecture.md                     ← this file
  /digital-library-audiobook.md        ← audiobook library type detail
```

---

## Initial Version Scope

The first production-ready version should focus on a small reliable core:

- Invite-only accounts, cookie sessions, and roles (implemented)
- App shell with profile and theme settings (implemented)
- Admin panel with user/invite/session management, logs, system status, and About page (implemented)
- Digital Library Phase 1 — audiobook library type with existing-folder registration, background scans, metadata extraction, OpenLibrary enrichment, and cover art thumbnails
- Background job queue for scanning, metadata, and thumbnail work
- Manual backup/export and restore validation

MFA and Notes are future updates. Advanced processors such as OCR, video previews, document previews, face recognition, and mobile app support are deferred until the core app is stable.

---

## Suggested Build Order

1. Done: Auth and user-management foundation — setup admin, session login/logout, invitation links, account listing and deactivation
2. Done: App shell — navigation, profile and theme settings, protected routes, control-panel navigation
3. Done: Admin panel and About page — user/session administration, logs, base system status, application/version information
4. Next: Digital Library Phase 1 — audiobook library type; existing-folder registration, background scans, metadata extraction, OpenLibrary enrichment, cover art thumbnails, playback progress
5. Planned: Digital Library Phase 2 — library and book sharing, user access control
6. Planned: Backup and restore tooling
7. Future update: MFA — TOTP setup, verification flow, backup codes
8. Future update: Notes module — CRUD, visibility/sharing, tags, and full-text search
9. Future update: Photo and video library types
10. Optional: Face recognition sidecar, last

---

## Future Updates

### MFA

TOTP-based multi-factor authentication and recovery codes are documented in the Authentication section, but implementation is deferred until the current administration and core-content milestones are stable.

### Notes

A flexible note-taking module suitable for multiple purposes — work notes, recipes, personal journal, and so on.

- Rich text content with tags
- Notes grouped by category (e.g. "Kitchen", "Work", "Personal")
- Same visibility and permission model as the Library
- Full-text search via SQLite FTS5
- CRUD with search and filtering
- User-defined tags via the shared tags system

### Future Library Types

- **Photo library** — folder-based, EXIF metadata, GPS data, HEIC support, optional face recognition
- **Video library** — folder-based, FFmpeg for previews and duration, resolution metadata
- **Podcast library** — RSS feed subscription, episode tracking, download management, per-episode playback progress

Each new library type registers itself in the library type registry and provides its own scanner, metadata jobs, and display configuration. No changes to shared infrastructure are required.

### Longer-Term Considerations

- Monorepo extraction — auth and UI components can be moved to shared packages if a second app is built
- Mobile app — React Native can reuse the same API client and session logic
- Additional modules — the plugin architecture makes it straightforward to add new modules without touching existing code
- Email support — can be added to the invite system later without restructuring auth
