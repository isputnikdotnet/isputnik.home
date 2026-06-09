# Library Access and Sharing

Libraries use an ownership model for access control. This is separate from the item-level `shares` table (see [`sharing.md`](sharing.md)), which handles sharing individual books, photos, and so on in later phases.

> **Current model:** ownership/visibility (Phases 1–2 below) is the baseline, now extended by graduated **role grants** — see [Phase 4: Graduated Roles and Capabilities](#phase-4-graduated-roles-and-capabilities). The simple "owner edits, others read" rules in Phase 1 are superseded by the capability ladder there.

---

## Phase 1: Ownership and Visibility

### Visibility

| Value | Who can access |
|---|---|
| `public` | All active users (browse, stream, download, save personal progress) |
| `private` | Owner and admins only |

### Ownership

Every library has an optional `owner_id` and `owner_type`. The owner has full edit rights (metadata, covers). Non-owners can only read.

| owner_type | Meaning |
|---|---|
| `user` | A specific user owns the library |
| `group` | A group owns the library (Phase 2) |
| `NULL` | No owner — system library, admin-managed |

Each user can own at most one library per type (e.g. one audiobook library). Enforced at the application layer.

Admins create all libraries and always have full access regardless of ownership or visibility.

### Edit rights

| Who | Can edit? |
|---|---|
| Admin | Always |
| Owner user | Always |
| Non-owner member on public library | No — read only |
| Non-owner on private library | No access |

Edit operations: book metadata, author info, covers, metadata-reset.

Source files are never modified. They are always read-only per the core safety rule.

### Schema

```sql
ALTER TABLE libraries ADD COLUMN owner_id   TEXT;
ALTER TABLE libraries ADD COLUMN owner_type TEXT CHECK (owner_type IN ('user', 'group'));
ALTER TABLE libraries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('private', 'public'));

CREATE INDEX IF NOT EXISTS idx_libraries_owner      ON libraries(owner_id);
CREATE INDEX IF NOT EXISTS idx_libraries_visibility ON libraries(visibility);
```

`owner_id` carries no FK constraint so it can reference either `users` or `groups` (Phase 2) without a schema change.

### Access resolution

Evaluated in order, first match wins:

1. **Admin** — full access to all libraries
2. **Owner** — full access (`owner_type = 'user'` and `owner_id = userId` in Phase 1)
3. **Public library** — all active users, read-only
4. **Deny**

---

## Phase 2: Group Ownership (planned)

Groups allow a library to be owned and managed by a named subset of users (`family`, `friends`, etc.). A group-owned library gives all group members read access; members with a `manager` role get edit access.

### Schema additions

```sql
CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
  joined_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id)
);
```

`owner_type = 'group'` on a library — group members can access it; managers can edit it. `visibility` still controls whether the library is visible to all users (`public`) or group members only (`private`).

Updated access resolution:

1. Admin — full access
2. Owner user — full access
3. **Group member** — `owner_type = 'group'` and user is in owner group → read; manager role → edit
4. Public library — all active users, read-only
5. Deny

---

## Phase 4: Graduated Roles and Capabilities

Ownership/visibility is now the *baseline* layer; on top of it, libraries support fine-grained
**role grants** to additional users and groups. Resolved in [`library-access.ts`](../apps/server/src/modules/library/shared/library-access.ts)
(`resolveLibraryRole`), enforced per-capability across the library routes, and surfaced to the
client via `myRole` + `canDownload`/`canUpload`/`canCurate`/… on each serialized library.

### Roles → capabilities

Each role grants its own capability plus every one below it (a strict ladder):

| Capability | Viewer | Subscriber | Contributor | Curator | Library Admin |
|---|:-:|:-:|:-:|:-:|:-:|
| **view** (browse, stream/read in-app) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **download** (export files / ZIP / `?download`) | | ✓ | ✓ | ✓ | ✓ |
| **upload** (add books/files — reserved) | | | ✓ | ✓ | ✓ |
| **edit** (item metadata, covers, reset) | | | ✓ | ✓ | ✓ |
| **curate** (series/structure management) | | | | ✓ | ✓ |
| **manage members** (grant/revoke roles) | | | | | ✓ |
| **manage library** (settings, owner, visibility, delete) | | | | | ✓ |

`upload` is defined but not yet wired (no library upload endpoint exists yet).

### Role resolution

`resolveLibraryRole(library, userId, userRole)` returns the **strongest** applicable role, or null:

1. App-admin → `admin`
2. Owner user → `admin`; owning-group **manager** → `curator`, owning-group member → `subscriber`
3. Explicit grants in `library_members` (matching the user, or any group the user belongs to)
4. `visibility = 'public'` → `subscriber` (baseline: every signed-in user can view **and** download)
5. None of the above → no access

The owner and app-admins are implicit Library Admins and are **not** stored as grants.

### Schema

```sql
CREATE TABLE library_members (
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
  subject_id   TEXT NOT NULL,                       -- polymorphic, no FK
  role         TEXT NOT NULL CHECK (role IN ('viewer','subscriber','contributor','curator','admin')),
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (library_id, subject_type, subject_id)
);
```

`subject_id` has no FK (it points at either `users` or `user_groups`), so grants are cleaned up
in app code via `deleteLibraryMembersForSubject()` when a group is deleted. Soft-deleted users'
grants stay inert (they cannot sign in).

### API

`manage_members`-gated, in [`shared/members.ts`](../apps/server/src/modules/library/shared/members.ts):

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/library/libraries/:id/members` | List grants (resolved names; `missing` flags deleted subjects). |
| `POST` | `/api/library/libraries/:id/members` | Upsert `{ subjectType, subjectId, role }`. |
| `DELETE` | `/api/library/libraries/:id/members/:subjectType/:subjectId` | Revoke a grant. |

Managed from the Control Panel → Libraries / Ebooks rows via the **Members** (users) button,
which opens `LibraryMembersModal`.

### Interaction with item-level shares

Item-level sharing (guest links + user-to-user shares, see [`sharing.md`](sharing.md)) is bounded
by the new capability model:

- **Creating or managing a share requires the `curate` capability** (Curator or Library Admin,
  plus owner/app-admin). A Viewer/Subscriber/Contributor can *consume* a library but cannot hand
  out external access — this closes the escalation where a non-downloader could mint a guest link
  and download through it. Enforced in `getShareableBook()` ([`shares.ts`](../apps/server/src/modules/library/audiobook/shares.ts)),
  which returns 404 (no access — existence hidden) vs 403 (can view, lacks curate).
- **A share grants the recipient view + download** of that one book (matching the guest-page
  behaviour: `permission = 'read'` = playback *and* file download). `canUserAccessBook` /
  `canUserDownloadBook` therefore honour an active share as full single-book access.
- The book-detail endpoint returns `capabilities` (`canEdit`/`canDownload`/`canShare`) so the
  client hides the edit/download/share buttons a user can't use; the server still enforces each.

---

## Phase 3: Invite Provisioning (future)

When an admin creates an invite link, they may attach a group. On first sign-in, the user is automatically added to that group. Future extension: auto-provision the user's private libraries (one per type) — the server creates the filesystem subfolder and database record without manual admin steps.

Path convention for auto-provisioned user libraries:
```
{user_content_root}/{userId}/{library_type}/
```
`user_content_root` is a storage root configured by the admin for this purpose.

---

## Related Documents

- [`sharing.md`](sharing.md) — general `shares` / `share_links` model for item-level sharing
- [`auth.md`](auth.md) — invite flow, which will eventually carry group and provisioning metadata
- [`architecture.md`](architecture.md) — overview and build order
