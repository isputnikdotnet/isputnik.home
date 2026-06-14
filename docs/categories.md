# Categories

A **category** is the single, primary genre of a book — one fixed slot per item, drawn from a
small **global taxonomy** (Fiction, Sci-Fi & Fantasy, History, …). Categories are
**system-assigned** at scan time and **shared across every book-like library type**
(audiobooks and ebooks today; any future [`BOOK_LIBRARY_TYPES`](../apps/server/src/modules/library/shared/library-types.ts)),
so one Fiction bucket spans the whole digital library.

Categories are distinct from [tags](tags.md): a book has exactly **one** category (a single
FK), whereas tags are a polymorphic many-to-many label set.

## Data model

- **`categories`** — the taxonomy: `key`, `name`, `sort_order`, `icon`, `image_storage_key`.
  Seeded from [`categories-seed.ts`](../apps/server/src/categories-seed.ts) (13 categories +
  the protected `general_other` fallback). No library-type column — the list is global.
- **`category_aliases`** — `keyword → category_id` with a `priority`; drives scan-time matching.
- **`book_metadata.category_id`** — the one-per-book link ([`db.ts`](../apps/server/src/db.ts)).
  Because it lives on `book_metadata`, only `books`-backed types can carry a category today
  (see *Extending* below).

## Auto-assignment at scan

Both scanners classify through the same engine,
[`matchCategoryId(genres)`](../apps/server/src/modules/library/audiobook/categorize.ts): incoming
genre/subject strings are normalized and matched against the alias table; the highest-priority
match wins, else `general_other`. The audiobook scanner feeds it genre tags; the ebook scanner
feeds it `meta.subjects`. Editing aliases and running **Re-match**
(`rematchAllCategories`) recomputes every non-manual book of **every** book-like type from its
existing tags — no rescan.

## Browse — two scopes

- **Per-page filter (type-scoped).** The Audiobooks / Ebooks catalog filter offers a
  *Categories* facet built from that page's libraries only
  ([`catalog-core.ts`](../apps/server/src/modules/library/shared/catalog-core.ts),
  per-type configs). The Ebooks filter lists only categories present on ebooks, etc.
- **Global Categories page (cross-type).** A single taxonomy view spanning all book-like types,
  surfaced in the account menu. The list shows every category with a combined count; a category's
  detail page shows audiobooks **and** ebooks together, each badged by media type with an
  audiobook/ebook filter toggle.

The cross-type browse lives at the library level in
[`categories.ts`](../apps/server/src/modules/library/categories.ts) and reuses the shared
[`bookLibraryIds`](../apps/server/src/modules/library/feed.ts) +
[`crossTypeBooksByFilter`](../apps/server/src/modules/library/feed.ts) helpers (the same engine
that powers the home feeds and tag browse). The web pages are
[`CategoryListPage.tsx`](../apps/web/src/features/audiobooks/CategoryListPage.tsx) and
[`CategoryDetailPage.tsx`](../apps/web/src/features/audiobooks/CategoryDetailPage.tsx); icons come
from [`categoryIcons.tsx`](../apps/web/src/features/audiobooks/categoryIcons.tsx). Category chips on
the shared book-detail page link to `/categories/:key`, so an ebook's category resolves to the
cross-type list.

## Admin management

The taxonomy and the alias keyword table are admin-only, in
[`categories-routes.ts`](../apps/server/src/modules/library/audiobook/categories-routes.ts) (the
**Categories** control-panel section): create / rename / reorder / icon / image, manage aliases,
and **Re-match**. Deleting a category reassigns its books to `general_other` (no type filter, so
ebooks are swept up correctly); `general_other` itself cannot be deleted.

## Endpoints

| Method & path | Action | Scope |
|---|---|---|
| `GET /api/library/categories` | List categories + combined book counts | book-like types (also feeds the metadata-editor picker) |
| `GET /api/library/categories/:key/books` | Books in a category, cross-type (`FeedItem` shape) | book-like types |
| `GET /api/library/{audiobooks,ebooks}/facets` | Filter facet options (incl. categories) | one type / library |
| `GET/POST/PATCH/DELETE /api/library/manage/categories[...]` | Taxonomy CRUD + image | admin |
| `GET/POST/PATCH/DELETE /api/library/manage/aliases[...]` | Alias keyword CRUD | admin |
| `POST /api/library/manage/rematch` | Re-match all book-like books from tags | admin |

## Extending to other library types

Unlike tags, a category is a **single FK on `book_metadata`**, so a non-`books` type (Gallery,
Documents) has nowhere to store one. Giving those types categories would mean making the link
**polymorphic** — a `categorizables(category_id, entity_type, entity_id)` table mirroring
`taggables` / `collection_items` — and pointing the browse engine at it. Until then, categories
are intentionally limited to book-like media; tags and collections are the ready-made cross-type
organizers for everything else.
