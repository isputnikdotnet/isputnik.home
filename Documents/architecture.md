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

- Build Digital Library Phase 1: add existing on-disk libraries, scan and index their content, and generate thumbnails through background jobs
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

## Modules

### Digital Library

A flexible media catalogue for photos, video, and other supported files. The first milestone indexes files that already exist on the home server rather than requiring users to upload or reorganise their media.

#### Delivery Phases

**Phase 1 - Add Existing Libraries**

- An administrator creates a library by choosing a display name and a server-accessible source path, for example an existing photos or videos folder.
- The administrator must configure a writable thumbnail/preview storage path before scanning a library. Generated files from every library use this shared application-managed location.
- The application scans the library path recursively, identifies supported files, and adds references and metadata to SQLite. Original files remain in their current location.
- The first implementation treats source folders as read-only: deleting an item from the catalogue must not delete the original file.
- A rescan discovers new and changed files and marks missing files unavailable without losing historical metadata immediately.
- Thumbnail and metadata jobs run asynchronously after discovery so a large existing collection can be added without blocking the UI.

**Phase 2 - Users and Sharing**

- Make libraries available to selected existing users or all family members.
- Support private, family, and user-specific access using the common sharing and permission model.
- Add collections and asset-level sharing after library-level access is reliable.

Managed uploads can be added later as a second ingestion source, without changing how indexed assets, previews, collections, or sharing are presented.

**Supported formats (configurable):**

| Category | Formats |
|---|---|
| Images | jpg, png, heic, webp |
| Video | mp4, mov, mkv |
| Documents | pdf, docx, xlsx |
| Audio | mp3, m4a, flac |
| Archives | zip |
| Unknown | stored safely, basic metadata only |

**Existing-library scan pipeline (Phase 1):**

```
Admin adds a library source path
→ validate the path and create a library record
→ scan files beneath the configured root
→ detect MIME type and file identity
→ classify content
→ store a database reference to the original file
→ enqueue background processing jobs
→ show discovered content as scanning continues
→ (background) generate thumbnail / preview
→ (background) extract metadata
→ (background) index for search
```

**Existing-library safety rules:**

- Permit only validated server-side paths configured by an administrator
- Store the library root and relative asset path; do not expose arbitrary filesystem paths to regular users
- Resolve paths during scans and do not follow links outside the approved library root
- Read originals for scanning and display only; do not rename, move, or delete source files in Phase 1
- Detect additions, changes, and missing files during rescans using path, size, modified time, and later an optional content hash
- Keep generated thumbnails outside source folders so the application does not alter existing photo and video organisation

**Managed upload safety rules (later ingestion source):**

- Enforce configurable max file size and per-user storage quotas
- Store files using generated storage names, never user-provided paths
- Detect file type from content where possible, not only from extension
- Keep original filenames only as display metadata
- Reject or quarantine files that fail validation
- Clean up partial files if upload or database insert fails
- Treat archives as stored files only; do not automatically extract them

**Processing per type:**

- Photos — thumbnail, EXIF metadata, dimensions, optional face recognition
- Video — preview image, duration, resolution
- Documents — preview, metadata extraction, optional OCR, text indexed for search
- Audio / Audiobooks — metadata, chapters, cover art
- Unknown — stored safely, no preview

Some processors are optional and can be enabled only when their dependencies are installed:

- Image thumbnails: Sharp
- Video previews and metadata: FFmpeg / ffprobe
- HEIC support: platform image codec or Sharp/libvips support
- Document text/preview extraction: PDF and Office document tooling
- OCR: Tesseract or a later AI/OCR service
- Audio metadata and cover art: media metadata parser
- Face recognition: optional Python sidecar

**Library and asset tables:**

```sql
libraries
---------
id, name, source_path, source_type,
scan_status, last_scanned_at,
created_by, created_at, updated_at

assets
------
id, library_id, owner_id,
relative_path, file_name_original,
mime_type, extension, category, size,
modified_at, content_hash,
visibility, status, discovered_at, updated_at, deleted_at

asset_previews
--------------
id, asset_id, kind, format,
storage_key, width, height, size,
created_at, updated_at
```

Assets require a unique constraint on `(library_id, relative_path)` so rescans update an existing record instead of duplicating content.

`owner_id` and per-asset `visibility` become important in Phase 2. Phase 1 can restrict library administration to administrators while the access model is completed.

**Thumbnail and preview storage:**

Thumbnails are derived files and should be kept in one application-managed location, separate from every original library source. A sharded directory layout prevents one directory from accumulating an impractical number of files:

```
/data/cache/thumbnails/
  /ab/cd/<asset-id>-thumbnail.webp
  /ab/cd/<asset-id>-preview.webp
```

The shard path is derived from a stable asset identifier or hash, for example the first four hexadecimal characters split across two directory levels. `asset_previews.storage_key` records the generated location. Generated previews can be deleted and rebuilt, so they do not need the same backup priority as original files and the database.

The thumbnail root must be configurable at deployment time:

```env
THUMBNAIL_PATH=/data/cache/thumbnails
```

The default should be `/data/cache/thumbnails`, with startup validation that the directory exists or can be created and is writable. SQLite stores only each preview's relative `storage_key`, not the absolute thumbnail root, so an administrator can move the mounted preview storage later without rewriting database records.

**Docker storage model:**

When deployed in Docker, paths entered in the application refer to locations inside the container. The operator maps persistent host directories or named volumes to those container locations:

```yaml
services:
  isputnik:
    environment:
      THUMBNAIL_PATH: /data/cache/thumbnails
    volumes:
      - ./data/cache/thumbnails:/data/cache/thumbnails
      - /host/photos:/libraries/photos:ro
      - /host/videos:/libraries/videos:ro
```

- Mount `THUMBNAIL_PATH` read/write and keep it on persistent storage; otherwise container replacement removes all generated previews and forces a rebuild.
- Mount existing source libraries read-only in Phase 1, then register container paths such as `/libraries/photos` in the application.
- Do not store host filesystem paths in the application when running in Docker; store the mounted container-visible library path.
- A named Docker volume is acceptable for thumbnails, while a bind mount makes inspection, migration, and optional cache backup easier for a home server.

**Organisation:** Collections rather than traditional folders. One asset can belong to multiple collections simultaneously (e.g. a photo in both "Summer 2024" and "Kids"). More flexible and easier for non-technical users than a rigid folder hierarchy.

**Sharing (Phase 2):** uses the shared `shares` table, also intended for the future Notes module.

---

## Background Job System

A lightweight SQLite-backed job queue handles all slow processing tasks asynchronously. A library can be registered immediately while scanning and preview generation continue in the background.

Jobs used for:
- Existing-library initial scans and rescans
- Thumbnail generation
- Metadata extraction
- OCR
- Video preview generation
- Face recognition scans
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

Workers claim jobs by setting `locked_at` and `locked_by` inside a transaction. If a worker crashes, stale locks can be released after a timeout and the job can be retried. Job handlers should be idempotent where possible because a job may be attempted more than once.

No external queue infrastructure (Redis, etc.) is needed at this scale.

---

## Soft Delete / Trash

Content is never permanently deleted immediately. A `deleted_at` timestamp is set instead. Items are automatically purged after 30 days.

Applies to: assets, notes, collections, and optionally user accounts (deactivation).

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

Backups should use SQLite's backup API or an application-controlled maintenance window so the database snapshot is consistent. Future managed uploads should either complete before the backup starts or be excluded and retried later. External library originals remain the responsibility of their configured backup location.

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
| `THUMBNAIL_PATH` | `/data/cache/thumbnails` | Read/write | Shared sharded thumbnail and preview cache |
| Library source paths | `/libraries/<name>` | Read-only in Phase 1 | Existing original photos and videos |

```
/data
  /db         ← SQLite database files
  /media      ← future application-managed uploads and note attachments
  /cache
    /thumbnails  ← sharded, generated previews for all Digital Libraries

Configured external library roots
  /photos     ← existing originals; indexed in place and not modified by Phase 1
  /videos     ← existing originals; indexed in place and not modified by Phase 1
```

---

## Technology Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript | Component reuse, potential mobile app later |
| Backend | Node.js + Fastify | Fast, TypeScript-native, plugin architecture |
| Database | SQLite + WAL; FTS5 planned | Simple, file-based, no separate DB server, future full-text search |
| File handling (planned) | Filesystem scanner + Sharp; @fastify/multipart later | Index existing libraries and generate thumbnails before optional uploads |
| Auth | Session cookies + Node.js `scrypt` | Simple, secure, easy revocation |
| MFA (future update) | otplib + qrcode | TOTP-based two-factor auth, no external service needed |
| Background jobs (planned) | SQLite job queue | No external infrastructure needed |
| Face recognition | Python sidecar (optional) | Keeps main stack clean; easy to omit initially |

---

## Folder Structure

```
/apps
  /web                ← React frontend
  /server             ← Node.js Fastify backend
    /core             ← auth, users, themes, logs, sessions
    /modules
      /library        ← Library routes, processing pipeline, DB tables
      /notes          ← Notes routes, search, DB tables
    /workers          ← background job processors
  /face-service       ← optional Python microservice
/data
  /db                 ← SQLite database files
  /media              ← future managed uploads and attachments
  /cache/thumbnails   ← sharded generated Digital Library previews
```

---

## Initial Version Scope

The first production-ready version should focus on a small reliable core:

- Invite-only accounts, cookie sessions, and roles
- App shell with profile and theme settings (implemented)
- Admin panel with user/invite/session management, logs, system status, and an About page available across the app (implemented foundation)
- Digital Library Phase 1 with existing-folder registration, scans, basic image thumbnails, and metadata
- Background job queue for scanning, thumbnail, and metadata work
- Manual backup/export and restore validation

MFA and Notes are future updates rather than part of this first scope. Advanced processors such as OCR, video previews, document previews, face recognition, and mobile app support are also deferred until the core app is stable.

---

## Suggested Build Order

1. Done: Auth and user-management foundation — setup admin, session login/logout, invitation links, account listing and deactivation
2. Done: App shell — navigation, profile and theme settings, protected routes, control-panel navigation
3. Done: Admin panel and About page — user/session administration, logs, base system status, application/version information
4. Next: Digital Library Phase 1 — existing-folder registration, indexed references, background scans, and sharded thumbnail storage
5. Planned: Digital Library Phase 2 — existing-user access, library sharing, collections, and asset sharing
6. Planned: Backup and restore tooling
7. Future update: MFA — TOTP setup, verification flow, backup codes
8. Future update: Notes module — CRUD, visibility/sharing, tags, and full-text search
9. Future update: Full-text search across notes and documents
10. Optional: Face recognition sidecar, last

---

## Future Updates

### MFA

TOTP-based multi-factor authentication and recovery codes are documented in the Authentication section, but implementation is deferred until the current administration and core-content milestones are stable.

### Notes

A flexible note-taking module suitable for multiple purposes - work notes, recipes, personal journal, and so on.

- Rich text content with tags
- Notes grouped by category (e.g. "Kitchen", "Work", "Personal")
- Same visibility and permission model as the Library
- Full-text search via SQLite FTS5
- CRUD with search and filtering

### Longer-Term Considerations

- Monorepo extraction — auth and UI components can be moved to shared packages if a second app is built
- Mobile app — React Native can reuse the same API client and session logic
- Additional modules — the plugin architecture makes it straightforward to add new modules without touching existing code
- Email support — can be added to the invite system later without restructuring auth
