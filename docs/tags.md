# Tags

A **tag** is a free-form label that can be attached to many items, and an item can carry many
tags. Unlike a [category](categories.md) (one fixed genre per book), tags are a **polymorphic
many-to-many** set — and the one organizer that already spans **every** library type and is ready
for future ones (Gallery, Documents) with no schema change.

## Data model

- **`tags`** — `key` (normalized) + `display_name`. Global; merging renames collapse onto the key.
- **`taggables`** — the link: `(tag_id, entity_type, entity_id)`
  ([`db.ts`](../apps/server/src/db.ts)). The `entity_type` column is the key design choice — the
  schema comment notes *"any entity type (book, photo, note, …) can be tagged."* Links are
  `entity_type = 'library_item'` (audiobooks and ebooks alike) or `'family_tree_person'` —
  family-branch tags that also scope edit rights (see
  [`familytree/access.ts`](../apps/server/src/modules/familytree/access.ts): assignments with
  `object_type = 'family_tree_tag'` grant a user/group edit access to every person carrying the
  tag). Because tags carry permissions there, tagging family persons is admin-only, and the admin
  tag manager's delete/merge/prune handle `family_tree_tag` assignments and non-book usage counts.

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
- **Global Tags page (cross-type).** A searchable cloud of every tag in use anywhere, surfaced in
  the account menu. A filter row — All / Audiobooks / Ebooks / Gallery / Family tree — narrows the
  cloud to where a tag is actually used, and each chip then shows that scope's count. The list
  renders the 100 most-used with "Show all N", and a sort control switches most-used ↔ A–Z. A
  tag's detail page shows books, gallery photos, and family members together, each in its own
  section, with the same filter across the types that tag actually spans. Photos there open in a
  lightbox in place; family members link to their profile.

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
| `GET /api/library/tags` | List tags + per-type counts (`audiobookCount`, `ebookCount`, `galleryCount`, `familyCount`) | everything the viewer can see (also feeds editor autocomplete) |
| `GET /api/library/tags/:name/books` | Everything carrying a tag: `books` (`FeedItem`), `photos` (gallery assets), `people` (family members) | all types |
| `GET /api/library/{audiobooks,ebooks}/facets` | Filter facet options (incl. tags) | one type / library |
| `GET/POST/PATCH/DELETE /api/library/manage/tags[...]` | Tag CRUD + merge | admin |
| `POST /api/library/manage/tags/prune` | Delete tags with no live books | admin |

## Extending to other entity types

Because `taggables` is polymorphic, a new type joins tag browse with **no migration** — it writes
links with its own `entity_type` and the browse queries pick it up. This is why tags, not
categories, are the natural cross-library label; categories are book-shaped, tags aren't.

Two types have already been added this way:

- **Gallery** — photos and videos are `library_item` rows like books, so they are separated by
  their library's `type` rather than a distinct `entity_type`.
- **Family tree** — `entity_type = 'family_tree_person'`. These tags also carry permissions
  (an `assignments` row on `object_type = 'family_tree_tag'` grants branch edit rights), which is
  why assigning them is admin-only. See [family-tree.md](family-tree.md).

The permission twist is worth remembering when touching the admin tag manager: **delete, merge and
prune are family-tag aware**. Merging moves grants onto the surviving tag, deleting clears them,
and prune counts non-book usage so a family-only tag isn't treated as unused.
