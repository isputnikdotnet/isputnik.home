# Sharing and Permissions

A single sharing model is reused across all modules — Digital Library, Notes, and any future module. This keeps sharing behaviour consistent everywhere and avoids duplicating permission logic.

---

## Visibility Levels

| Level | Meaning |
|---|---|
| `private` | Owner only |
| `family` | All registered users |
| `shared` | Specific users granted access |
| `link` | Anyone with the link |

## Permission Levels

| Level | Meaning |
|---|---|
| `read` | View only |
| `edit` | Modify content |
| `manage` | Edit plus share with others |

---

## Schema

### User shares

```sql
shares
------
id, module, resource_id,
user_id,              -- the recipient account
permission,           -- 'read' | 'edit' | 'manage'
created_by,
created_at,
expires_at,           -- nullable; NULL = permanent (user shares only)
revoked_at,
UNIQUE (module, resource_id, user_id)
```

### Public link shares

```sql
share_links
-----------
id, module, resource_id,
token_hash,           -- raw token never stored
permission,
expires_at,
created_by,
created_at,
revoked_at
```

Public link tokens are stored as SHA-256 hashes. The raw token is returned once on creation and is the user's responsibility to store (same model as invite links).

### Required indexes

```sql
CREATE INDEX idx_shares_resource    ON shares(module, resource_id);
CREATE INDEX idx_shares_user        ON shares(user_id);
CREATE INDEX idx_share_links_token  ON share_links(token_hash);
CREATE INDEX idx_share_links_resource ON share_links(module, resource_id);
```

---

## Access Resolution Order

Effective access is resolved in this order, first match wins:

1. Owner — always has full access to their own content
2. Admin — always has full access to all content
3. Family visibility — resource has `visibility = 'family'`
4. Explicit user share — a `shares` row for this user and resource
5. Valid link share — a non-expired, non-revoked `share_links` row matching the token

---

## Referential Integrity

`shares` and `share_links` reference resources by `module` + `resource_id` rather than database foreign keys. This allows the sharing tables to be shared across all modules without knowing every resource table's schema. When a resource is deleted or purged, its shares and link shares must be deleted in the same transaction by the module's service code.

---

## Library Access Model

Library-level access uses a separate ownership model — libraries have an `owner_id` and a `visibility` field rather than `shares` rows. The `shares` table applies at the item level (individual books, photos, etc.) in later phases.

See [`library-sharing.md`](library-sharing.md) for the full schema, access resolution, and roadmap.

---

## Option A — Item-Level Media Sharing (current build)

> **Status: implemented** (audiobooks). See [Implementation](#implementation) at the end of this section for the actual files, endpoints, and behaviour as shipped.

An owner shares a **single media item** (an audiobook today; photos, notes, any module later) with a specific person. This is the "recommend / give a book to someone" flow, not social activity sharing. Both share types below are built on the generic tables above (`module` + `resource_id`), so implementing them for audiobooks makes them reusable for every future module without schema changes.

There are **two share types**, for two different recipients:

| Type | Table | Recipient | Functionality |
|---|---|---|---|
| **Guest link share** | `share_links` | Anyone with the link, no account | Stream + download only, no progress |
| **User-to-user share** | `shares` | A specific registered user | **Full** — streams, downloads, *and* the recipient's own progress, bookmarks, and saves all work |

The difference is the recipient's identity. A guest is anonymous, so there is nothing to attach progress to. A user-to-user share grants an existing account access to an item it otherwise couldn't see; because the recipient is signed in as themselves, every per-user feature works automatically — the share only adds *visibility*, not a reduced mode.

### Guest link share

| Topic | Decision |
|---|---|
| **Recipient** | **Guest sharing** — anyone with the link can open it, no account and no sign-in required. |
| **Capabilities** | **Stream and download** are both allowed. For a media item, `permission = 'read'` grants playback *and* file download. |
| **Progress** | **Not tracked.** No server-side progress and no client cookie sync — each visit starts fresh. |
| **Logging** | **Every link access is logged** (see below), so the owner can see that and when a share was opened. |

> Guest reach is identical to Audiobookshelf's model — anyone with the link who can reach the server can open it, *including anyone on the internet if the server is publicly exposed*. Expiry and revocation are the only access controls; treat the token as the secret.

### Schema

Reuses `share_links` as defined above. For media items the only permission used is `read`; `edit`/`manage` are not applicable to a link share of a single item. One optional column supports the recommend-to-a-person flow:

```sql
ALTER TABLE share_links ADD COLUMN label TEXT;   -- optional note, e.g. "For Dad"
```

**Token storage is hash-only / show-once.** Generation matches `invites`: `nanoid(36)`, stored as `sha256(token)` in `token_hash` — the raw token is **never** persisted. The full URL is returned exactly once on creation and shown with a copy button; it cannot be re-displayed later. A guest link is a bearer secret reachable by anyone on the internet, so a DB read must not expose working links (same reasoning as password hashing). If an owner loses a link, they revoke and create a new one — cheap, since links last at most 30 days. Resource is referenced by `module = 'audiobook'` + `resource_id = <bookId>`.

### Access logging

No new table. Reuse `activity_logs` via the existing `logActivity()` helper — `actor_user_id` is nullable, so guest hits record with only an IP address:

```ts
logActivity({
  event: "share.accessed",
  actorUserId: null,              // guest
  targetType: "share_link",
  targetId: shareLinkId,
  detail: "Opened a shared audiobook.",
  ipAddress: request.ip
});
```

Events: `share.created`, `share.revoked`, `share.accessed` (and optionally `share.downloaded` to distinguish stream from download).

### API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/shares` | owner/admin | Create a share link for a resource (`{ module, resourceId, expiresInDays?, label? }`); returns the URL once. |
| `GET` | `/api/shares` | owner/admin | List the caller's active shares (status: active / expired / revoked). |
| `DELETE` | `/api/shares/:id` | owner/admin | Revoke (`revoked_at = now`). |
| `GET` | `/api/share/:token` | public | Resolve token → item metadata + file list for the guest player. Logs `share.accessed`. |
| `GET` | `/api/share/:token/cover` | public | Cover image for the guest page (guests can't use the auth-gated cover route). |
| `GET` | `/api/share/:token/stream/:fileId` | public | Stream one audio file (direct play, no transcode, range supported). |
| `GET` | `/api/share/:token/download` | public | Download the book as a ZIP. Logs `share.downloaded`. |

A `share-access.ts` resolver mirrors [`library-access.ts`](library-sharing.md): given a token it returns the live `share_links` row (non-expired, non-revoked) and the target resource, or `null`. All three public routes go through it so expiry/revocation is enforced in one place.

#### Expiration

A guest link is a bearer secret reachable by anyone on the internet, so **expiry is required** — there is no "never" option for link shares.

| Setting | Value |
|---|---|
| Presets | 24h / 7d / 30d |
| Default | 30 days |
| Maximum | 30 days |
| Enforcement | Resolver checks `datetime(expires_at) > CURRENT_TIMESTAMP AND revoked_at IS NULL`, same pattern as `invites`. |

`expiresInDays` on `POST /api/shares` is validated `min 1, max 30, default 30` (mirrors the invite schema). Expired rows are **not** deleted — they remain so access logs still resolve which share was hit; the owner sees status `expired` in their list. Renewing means creating a new link.

### User-to-user share

The owner shares an item with a **specific registered user**, who then accesses it with full functionality inside the normal app — not a stripped-down guest player.

| Topic | Decision |
|---|---|
| **Recipient** | A specific user account (`shares.user_id`). |
| **Capabilities** | **Full.** Stream, download, plus the recipient's own progress, bookmarks, and saves — all the normal per-user features, because they are signed in as themselves. |
| **Grant** | `permission = 'read'`. The share adds *visibility* of one item; it never grants edit rights or exposes the rest of the owner's library. |
| **Who can share** | Requires the `curate` capability on the item's library (Curator / Library Admin / owner / app-admin) — see [`library-sharing.md`](library-sharing.md#interaction-with-item-level-shares). Mere view/download access is not enough to re-share. |
| **Expiry** | Optional — may be permanent (`expires_at = NULL`) since access is gated to a real account; revocable any time via `revoked_at`. |
| **Logging** | `share.granted` / `share.revoked`. Ongoing access is ordinary authenticated activity, already covered by existing logs. |

**Schema** — uses the `shares` table as defined above, with `module = 'audiobook'` + `resource_id = <bookId>` and `user_id = <recipient>`. No new columns.

**Access resolution** — the book-access check must consult shares, not just library ownership. Today [`getLibraryForBook`](../apps/server/src/modules/library/shared/library-access.ts) + `canUserAccessLibrary` gate a book purely by its library's owner/visibility. Add one path: a non-expired, non-revoked `shares` row for `(audiobook, bookId, userId)` grants `read` to that single book **even when the library itself is private or unowned by the user**. This slots in as step 4 of the Access Resolution Order above (explicit user share), ahead of the library visibility check.

**UI** — shared items surface in a "Shared with me" view for the recipient and are otherwise playable wherever a book link resolves. The owner manages grants from the item (share with user → pick user → optional expiry).

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/shares/user` | owner/admin | Grant a user access (`{ module, resourceId, userId, expiresInDays? }`). |
| `GET` | `/api/shares/user?resourceId=` | owner/admin | List who an item is shared with. |
| `GET` | `/api/shared-with-me` | any user | Items shared *to* the caller. |
| `DELETE` | `/api/shares/user/:id` | owner/admin | Revoke the grant. |

### Out of scope (Option A)

- Listening-activity / social sharing (separate feature, design-blocked upstream).
- Synced progress for guests.
- Per-recipient identity or accounts — guests are anonymous by design.

### Implementation

What actually shipped for audiobooks, and where it lives.

**Server**

- `share-access.ts` ([`apps/server/src/modules/library/shared/`](../apps/server/src/modules/library/shared/share-access.ts)) — the resolver: `resolveShareLink(token)`, `userHasItemShare(module, resourceId, userId)`, plus cleanup helpers `deleteSharesForResource(module, resourceId)` and `deleteSharesForLibrary(module, libraryId)`.
- `shares.ts` ([`apps/server/src/modules/library/audiobook/`](../apps/server/src/modules/library/audiobook/shares.ts)) — all share routes (owner + public), registered in that module's `index.ts`.
- `library-access.ts` gained `canUserAccessBook()` = library access **OR** active user share. Wired into the authenticated stream + download endpoints in `stream.ts`.
- Tables `shares` and `share_links` are created in `db.ts` via `CREATE TABLE IF NOT EXISTS` (no migration needed).

**Endpoints** (as built; superset of the API table above)

| Method | Route | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/shares` | signed-in | Create guest link. URL returned **once**, built from `config.appUrl` (not the request Host — a dev proxy reports the wrong port). |
| `GET` / `DELETE` | `/api/shares` · `/api/shares/:id` | signed-in | List / revoke own links. |
| `POST` / `GET` | `/api/shares/user` · `?bookId=` | signed-in | Grant / list user shares for a book. |
| `DELETE` | `/api/shares/user/:id` | signed-in | Revoke a user share. |
| `GET` | `/api/shares/directory` | signed-in | Minimal user list (id + display name) for the recipient picker. |
| `GET` | `/api/shared-with-me` | signed-in | Items shared *to* the caller. |
| `GET` | `/api/share/:token` · `/cover` · `/stream/:fileId` · `/download` | public | Guest resolve, cover, per-file stream (range), ZIP download. Logs `share.accessed` / `share.downloaded`. |

**Cleanup** — shares are polymorphic (no FK), so module code removes them, passing its own `module` namespace: `deleteSharesForLibrary(module, libraryId)` runs in the library hard-delete transaction (`routes.ts`), and `deleteSharesForResource(module, resourceId)` runs when the scanner soft-deletes a book whose files vanished (`scanner.ts`).

**Web**

- Public guest page `/share/:token` ([`pages/SharePage.tsx`](../apps/web/src/pages/SharePage.tsx)) — self-contained lightweight player (no progress/bookmarks), its own seekbar with a real progress fill, and a Download button. Rendered before the auth gate so guests reach it without an account.
- Share dialog ([`features/share/ShareModal.tsx`](../apps/web/src/features/share/ShareModal.tsx)) — Guest link + People tabs, opened from the **Share** button on the book detail page.
- "Shared with me" page ([`features/audiobooks/SharedWithMePage.tsx`](../apps/web/src/features/audiobooks/SharedWithMePage.tsx)) with a sidebar nav entry.

---
