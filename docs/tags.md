# Tags

A **tag** is a free-form label that can be attached to many items, and an item can carry many
tags. Unlike a [category](categories.md) (one fixed genre per book), tags are a **polymorphic
many-to-many** set — and the one organizer that already spans **every** library type and is ready
for future ones (Gallery, Documents) with no schema change.

## Data model

- **`tags`** — `key` (normalized) + `display_name`. Global; merging renames collapse onto the key.
- **`taggables`** — the link: `(tag_id, entity_type, entity_id)`
  ([`db.ts`](../apps/server/src/db.ts)). The `entity_type` column is the key design choice — the
  schema comment notes *"any entity type (book, photo, note, …) can be tagged."* Today every link
  is `entity_type = 'book'`, covering audiobooks and ebooks alike.

## Auto-tagging at scan

Both scanners store their source genres/subjects as tags via
[`setEntityTags("book", id, names)`](../apps/server/src/modules/library/audiobook/categorize.ts)
(audiobook genres; ebook `meta.subjects`). Tags also seed category matching — see
[categories.md](categories.md).

## Browse — two scopes

- **Per-page filter (type-scoped).** The Audiobooks / Ebooks catalog filter offers a *Tags* facet
  built from that page's libraries only, and even narrows to a single library when one is selected
  ([`catalog-core.ts`](../apps/server/src/modules/library/shared/catalog-core.ts)). The Ebooks
  filter lists only tags present on ebooks; an audiobook-only tag never appears there. A tag shared
  by both types correctly appears in both filters.
- **Global Tags page (cross-type).** A searchable cloud of every tag across all book-like
  libraries, surfaced in the account menu. A tag's detail page shows audiobooks **and** ebooks
  together, each badged by media type with an audiobook/ebook filter toggle.

The cross-type browse lives at the library level in
[`tags.ts`](../apps/server/src/modules/library/tags.ts) and reuses the shared
[`bookLibraryIds`](../apps/server/src/modules/library/feed.ts) +
[`crossTypeBooksByFilter`](../apps/server/src/modules/library/feed.ts) helpers. The web pages are
[`TagListPage.tsx`](../apps/web/src/features/audiobooks/TagListPage.tsx) and
[`TagDetailPage.tsx`](../apps/web/src/features/audiobooks/TagDetailPage.tsx). Tag chips on the
shared book-detail page link to `/tags/:name`, so an ebook's tag resolves to the cross-type list.

The cross-type `GET /api/library/tags` list also feeds the **tag autocomplete in the shared
metadata editor** ([`EditMetadataModal.tsx`](../apps/web/src/features/audiobooks/EditMetadataModal.tsx)),
so editing an audiobook or an ebook suggests the same tag vocabulary.

## Admin management

Global tag management is admin-only, in
[`categories-routes.ts`](../apps/server/src/modules/library/audiobook/categories-routes.ts) (the
**Tags** control-panel section): create, rename (renaming onto an existing key **merges** the two,
moving links and de-duping), delete, and **prune** unused tags. Promoting a scanned tag into a
category alias lives in the Categories section.

## Endpoints

| Method & path | Action | Scope |
|---|---|---|
| `GET /api/library/tags` | List tags + combined usage counts | book-like types (also feeds editor autocomplete) |
| `GET /api/library/tags/:name/books` | Books carrying a tag, cross-type (`FeedItem` shape) | book-like types |
| `GET /api/library/{audiobooks,ebooks}/facets` | Filter facet options (incl. tags) | one type / library |
| `GET/POST/PATCH/DELETE /api/library/manage/tags[...]` | Tag CRUD + merge | admin |
| `POST /api/library/manage/tags/prune` | Delete tags with no live books | admin |

## Extending to other library types

Because `taggables` is already polymorphic, a new type joins tag browse with **no migration**: its
scanner writes links with its own `entity_type`, and the cross-type query includes that type's
items (today the helper is scoped to `bookLibraryIds`; widening it is a small, additive change).
This is why tags — not categories — are the natural cross-library label for Gallery and Documents.
