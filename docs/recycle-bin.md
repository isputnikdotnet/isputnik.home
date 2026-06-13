# Recycle Bin

Deleting a catalogued item (an audiobook or ebook today; any future library type) is a
**soft delete**: the item's files are moved into the library's hidden trash folder and the
item leaves the catalog, but it can be **restored** until it's permanently removed —
manually or by the retention sweep. This replaces the old irreversible hard delete.

The engine is type-agnostic and lives in
[`shared/trash.ts`](../apps/server/src/modules/library/shared/trash.ts); its HTTP surface is
[`shared/trash-routes.ts`](../apps/server/src/modules/library/shared/trash-routes.ts); the
admin UI is
[`RecycleBinSection.tsx`](../apps/web/src/features/control/sections/RecycleBinSection.tsx).

## How a delete works

1. The item's on-disk **entry** is moved into `<library source>/.trash/<token>/`, keeping
   its original source-relative path. The scanner ignores every dot-folder
   (`scanner.ts`, ebook `scanner.ts`), so trashed files are never re-indexed, and the move
   is an instant same-volume rename (no copy, even for a 600 MB book).
2. The `books` row is removed and its children cascade away **exactly as the old hard
   delete did** — including the polymorphic cleanups (taggables, shares, collection items).
   So no "live" catalog query has to know about trashed state.
3. A row is written to `trashed_items` snapshotting everything needed to restore or purge
   later (title, library, the source root, the origin path, the trash path, size/counts).

### The trash unit differs by type

The entry moved is the book's `books.folder_path`, which means something different per type:

- **Audiobook** — `folder_path` is the book's **folder**; the whole folder moves (tracks,
  covers, sidecars and all).
- **Ebook** — one file = one book, and the ebook scanner stores `folder_path` as the
  **file's path** (e.g. `Sci-Fi/Dune.epub`). Only that file moves; other ebooks sharing the
  same directory are untouched. (Moving the directory would wrongly take the siblings.)
- **Root-grouped** (`folder_path === "."`) — the book owns individual files at the library
  root rather than a folder; each catalogued file is moved individually.

### Not the same as `deleted_at`

`books.deleted_at` already means "the scanner couldn't find this on disk" (a missing drive,
a removed folder) and is cleared when the file reappears. The Recycle Bin is deliberately a
**separate** mechanism (`trashed_items`) so a trashed item and a temporarily-missing one are
never confused.

## Restore

`POST /api/library/trash/:id/restore` moves the files back to their original path (deduping
`Name (2)` if that path has since been reused) and re-catalogues from disk —
`rescanSingleBook` for audiobooks, a library rescan for ebooks.

**What restore does and doesn't bring back:** the **files and the item** come back, freshly
catalogued. Per-user listening/reading progress, bookmarks, favorites, shares, and
collection entries from before are **not** resurrected (they were cleared on delete, just
like a hard delete + re-add). In-app metadata that wasn't written to disk is re-derived by
the rescan. Restoring needs the original library to still exist.

## Retention & auto-purge

- `app_settings.trash_retention_days` controls how long items are kept. **Default `30`.**
  Set it to `0` to disable auto-purge (keep until emptied by hand).
- A sweeper (`startTrashPurgeWorker`, started in
  [`library/index.ts`](../apps/server/src/modules/library/index.ts)) runs ~30 s after boot
  and every 6 hours, permanently deleting items older than the window. Items whose source
  volume is currently offline are **skipped** (not orphaned) and retried next sweep.
- Permanent delete (`DELETE /api/library/trash/:id`) and **Empty** remove the `.trash`
  files and the row immediately — irreversible.

## Permissions

Trashing reuses the library **delete** capability — manager+ on a **managed** library with
`allowDelete` (see [permissions.md](permissions.md)); external/read-only libraries refuse it.
Restoring and purging need **manage**. Server admins manage every item, including orphans
whose library was later deleted. The Recycle Bin screen sits in the **Control Panel**
(admin-only); the API also serves non-admin managers their own libraries' items for any
future surface.

## Endpoints

| Method & path | Action | Needs |
|---|---|---|
| `DELETE /api/library/books/:id` | Move one item to the bin | library `delete` |
| `POST /api/library/books/bulk-delete` | Move many (per-item gated) | library `delete` |
| `GET /api/library/trash` | List manageable items + `retentionDays` | any signed-in (scoped) |
| `POST /api/library/trash/:id/restore` | Restore one item | `manage` |
| `DELETE /api/library/trash/:id` | Permanently delete one item | `manage` |
| `POST /api/library/trash/empty` | Empty (one library, or all = admin) | `manage` / admin |

## Storage layout

```
<library source>/
  Author/Book Title/          ← live audiobook
  Sci-Fi/Dune.epub            ← live ebook
  .trash/
    a1b2c3d4e5f6/             ← one trashed item (token)
      Author/Book Title/      ← moved at its original relative path
    9f8e7d6c5b4a/
      Sci-Fi/Dune.epub
```

Schema: the `trashed_items` table in [`db.ts`](../apps/server/src/db.ts).
