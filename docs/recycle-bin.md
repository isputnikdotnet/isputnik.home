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
catalogued. Per-user listening/reading progress, bookmarks, likes, shares, and
collection entries from before are **not** resurrected (they were cleared on delete, just
like a hard delete + re-add). In-app metadata that wasn't written to disk is re-derived by
the rescan. Restoring needs the original library to still exist.

## Retention & auto-purge

**Each row carries its own purge date** (`trashed_items.expires_at`), written when the item
is trashed rather than derived at sweep time. That is the whole point of the column: with the
date computed from the current setting, lowering the window from 30 days to 7 retroactively
condemned everything already in the bin older than 7 days — including items deleted under a
promise of 30. Changing either setting now governs only what goes in from that moment.
`NULL` means keep until emptied by hand.

**Two clocks**, chosen by `trashed_items.source`:

| Source | Setting | Default |
|---|---|---|
| `manual` — someone pressed Delete | `app_settings.trash_retention_days` | `30` |
| `duplicate_cleanup` — a cleanup removed it | `app_settings.trash_retention_days_duplicate_cleanup` | unset → follows the bin |

`0` in either means never auto-purge. The cleanup key is stored as `""` when unset, so
"I never chose" (follow the bin) stays distinguishable from "I chose 0" (never purge). A
cleanup can put thousands of files in the bin at once, which is why it gets its own — holding
all of them for a month is a lot of disk, while a hand delete is a mistake you might only
notice weeks later.

`source` also earns its keep in the UI: the bin filters by it, so a hand delete can still be
found under a cleanup's thousands of rows.

- A sweeper (`startTrashPurgeWorker`, started in
  [`library/index.ts`](../apps/server/src/modules/library/index.ts)) runs ~30 s after boot
  and every 6 hours, permanently deleting items whose `expires_at` has passed. Items whose
  source volume is currently offline are **skipped** (not orphaned) and retried next sweep.
- Permanent delete (`DELETE /api/library/trash/:id`) and **Empty** remove the `.trash`
  files and the row immediately — irreversible.

## Permissions

Trashing reuses the library **delete** capability — manager+ on a **managed** library with
`allowDelete` (see [permissions.md](permissions.md)); external/read-only libraries refuse it.
**Folder locks** are the same rule one level down: an admin locks a `(library, folder)` pair
(`library_folder_locks`, managed from the Gallery Folders view), and `trashBook` refuses any
item at or below that path with **423 Locked** — whoever asks, whatever the caller. The lock
gates trashing only: purge, empty and restore are unaffected, since a trashed item has
already left the folder.
Restoring and purging need **manage**. Server admins manage every item, including orphans
whose library was later deleted. The Recycle Bin screen sits in the **Control Panel**
(admin-only); the API also serves non-admin managers their own libraries' items for any
future surface.

## Endpoints

| Method & path | Action | Needs |
|---|---|---|
| `DELETE /api/library/books/:id` | Move one item to the bin | library `delete` |
| `POST /api/library/books/bulk-delete` | Move many (per-item gated) | library `delete` |
| `GET /api/library/trash` | List manageable items + both retention windows | any signed-in (scoped) |
| `PUT /api/library/trash/retention` | Set the bin and cleanup windows | admin |
| `POST /api/library/trash/:id/restore` | Restore one item | `manage` |
| `DELETE /api/library/trash/:id` | Permanently delete one item | `manage` |
| `POST /api/library/trash/empty` | Empty (one library, or all = admin) | `manage` / admin |

## Where the files go

By default, inside the library itself: `<source>/.trash/<token>/`. Same volume, so the
move is an instant rename, and the scanner skips dot-folders so nothing is re-indexed.

One folder for the whole install can be chosen instead, on the **Storage** page
(`app_settings.trash_root_path`, `PUT /api/storage/trash-root`). Then files go to
`<bin>/<library id>/<token>/`. The library id keeps two libraries' tokens in separate
folders, and both layouts end in `<container>/<token>`, which is what prune and restore
walk up from.

**Every row records its own bin** in `trashed_items.trash_root` (NULL = the library's
own `.trash`). Resolution is always `path.resolve(trash_root ?? source_path, trash_path)`,
so a row can still be found by the app that wrote it regardless of what the setting says
later — the column, not the setting, is what makes a purge safe.

**Rules on the chosen folder** (`validateTrashRootPath`): inside a configured storage
container, not inside a library (its files would be scanned straight back in), and not
a parent of one (emptying the bin would then be aimed at live files).

**It can only change while the bin is completely empty.** Existing rows would in fact
still resolve — that is what `trash_root` is for — but a bin whose files are split across
two places is one nobody can reason about, least of all from the page that names where
the files are. There is deliberately no combined "empty and change" action: emptying
destroys files, and it should never be a step inside another operation.

**Cross-volume moves.** An install-wide bin is very likely on a different filesystem from
some library, where `rename()` fails with `EXDEV`. `moveEntry()` falls back to copy +
delete, which reads and rewrites every byte — hence the Storage page's warning that a bin
on other storage makes deleting slow instead of instant. It wraps all three move sites
(into the bin, back out on restore, and the root-grouped file loop).

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

# with an install-wide bin (Storage page):
<bin>/
  <library id>/
    a1b2c3d4e5f6/             ← same token dir, outside the library tree
      Author/Book Title/
```

Schema: the `trashed_items` table in [`db.ts`](../apps/server/src/db.ts).
