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

- Build the Library upload foundation and background job processing
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

A flexible media store that accepts any supported file type. The application automatically detects the file type on upload and processes it accordingly. Supported file types and extensions are configurable.

**Supported formats (configurable):**

| Category | Formats |
|---|---|
| Images | jpg, png, heic, webp |
| Video | mp4, mov, mkv |
| Documents | pdf, docx, xlsx |
| Audio | mp3, m4a, flac |
| Archives | zip |
| Unknown | stored safely, basic metadata only |

**Upload processing pipeline:**

```
User uploads file
→ detect MIME type
→ classify content
→ save file to disk
→ enqueue background processing jobs
→ immediate response to user
→ (background) generate thumbnail / preview
→ (background) extract metadata
→ (background) index for search
```

**Upload safety rules:**

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

**Assets table:**

```sql
assets
------
id, owner_id, file_name_original, file_name_storage,
mime_type, extension, category, size,
visibility, status, created_at, updated_at, deleted_at
```

**Organisation:** Collections rather than traditional folders. One asset can belong to multiple collections simultaneously (e.g. a photo in both "Summer 2024" and "Kids"). More flexible and easier for non-technical users than a rigid folder hierarchy.

**Sharing:** uses the shared `shares` table, also intended for the future Notes module.

---

## Background Job System

A lightweight SQLite-backed job queue handles all slow processing tasks asynchronously. Files are saved and the user gets an immediate response — processing happens in the background.

Jobs used for:
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

Because the application state is primarily the SQLite database, media folder, and app configuration, a full backup is straightforward, but live backups must be created consistently.

**A complete backup includes:**
- SQLite database file
- `/data/media/` folder
- App configuration/settings

**Goal:** one-click export and import. If the server fails, restoring a backup brings the application back immediately with all data intact.

Backups should use SQLite's backup API or an application-controlled maintenance window so the database snapshot is consistent. Media files should be copied from a stable point in time, and uploads should either complete before the backup starts or be excluded and retried later.

A restore validates that the database, media folder, and configuration belong to the same backup set before replacing the active application state.

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

```
/data
  /db         ← SQLite database files
  /media
    /library  ← original files + thumbnails, per user
    /notes    ← any attachments
```

---

## Technology Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript | Component reuse, potential mobile app later |
| Backend | Node.js + Fastify | Fast, TypeScript-native, plugin architecture |
| Database | SQLite + WAL; FTS5 planned | Simple, file-based, no separate DB server, future full-text search |
| File handling (planned) | @fastify/multipart + Sharp | Upload handling and image thumbnail generation |
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
  /media              ← uploaded files and thumbnails
```

---

## Initial Version Scope

The first production-ready version should focus on a small reliable core:

- Invite-only accounts, cookie sessions, and roles
- App shell with profile and theme settings (implemented)
- Admin panel with user/invite/session management, logs, system status, and an About page available across the app (implemented foundation)
- Library uploads with basic image thumbnails and metadata
- Background job queue for thumbnail and metadata work
- Manual backup/export and restore validation

MFA and Notes are future updates rather than part of this first scope. Advanced processors such as OCR, video previews, document previews, face recognition, and mobile app support are also deferred until the core app is stable.

---

## Suggested Build Order

1. Done: Auth and user-management foundation — setup admin, session login/logout, invitation links, account listing and deactivation
2. Done: App shell — navigation, profile and theme settings, protected routes, control-panel navigation
3. Done: Admin panel and About page — user/session administration, logs, base system status, application/version information
4. Next: Library module — file upload pipeline, background jobs, thumbnails
5. Planned: Collections and advanced sharing
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
