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
user_id,              -- nullable; set for user-specific shares
permission,           -- 'read' | 'edit' | 'manage'
created_by,
created_at,
revoked_at
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
