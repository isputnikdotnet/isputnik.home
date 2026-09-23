# Sharing photos by person — plan

Status: **phases 3 and 4 released in 4.21.0** (2026-09-22): migration 82,
`familytree/portraits.ts`, `shared/ImageCropper`, `PortraitCropModal`. Phases 1
and 2 (people access) are still a proposal. Written 2026-09-22 from a
conversation about adding a cousin to the app without giving him the whole
family photo library.

As built, differing from the text below: `portrait_item_id` was **kept** as the
source photo rather than renamed to `portrait_source_item_id` (a column rename
rewrites child FKs), and the App files copy is tied to the person by a new
`portrait_file_item_id`, which App files' owner rules (`app-files-access.ts`,
`app-storage-contents.ts`) now read. Only the **face scan** skips derived
items; the duplicate scan needs nothing, since a crop is never byte-identical
and the near-duplicate tier is not built. A plain pick (PATCH
`portraitItemId`) is cut to the linked face when the photo shows it.

**Groundwork for phase 1, done 2026-09-23 (4.21.1):** the browse queries
(`catalog.ts`, `catalog-memories.ts`, `memories.ts`, `people.ts`, the Home
feed's photo cards) used to write their own `library_id IN (...)` and so could
not see any per-item rule. They all ask through `galleryScopeSql` now, and skip
themselves on `scopeIsEmpty(libIds)`, never `libIds.length === 0` — a relative
with no library but a person grant has an empty list and a rule. The first rule
on the browse scope is family-tree uploads (`withFamilyUploads`, attached by
`resolveGalleryBrowseLibraryIds`). Since 4.21.2 it is opt-in: only when the
library filter carries `FAMILY_TREE_SCOPE` ("family-tree"); the pickers send
`ALL_LIBRARIES_SCOPE` + it, the Gallery's Libraries facet offers it as an entry.
The people rule goes beside it — and must be ON by default, unlike this one. Note that it must NOT reach `queryGalleryFolders` /
`searchGalleryFolders` (folder names; see the privacy table), which today take
the same scope — give the people rule a flag the folder queries leave off.
Uploaded portraits (pre-4.21) get a source photo in App files → `Family
tree/Uploaded portraits` (`portraitSourcePhoto`) — on the first Adjust, and since
4.21.2 for all of them at startup (`keepUploadedPortraitsAsPhotos`), so the
Gallery shows them.

Companion to [permissions.md](permissions.md) (the assignments engine
this extends), [gallery-library.md](gallery-library.md),
[family-tree.md](family-tree.md), [photo-review-plan.md](photo-review-plan.md)
(voice notes) and [family-sharing-proposal.md](family-sharing-proposal.md)
(notes). Like the other plans, decisions are recorded so they need not be
re-argued; open questions are recorded so they are not silently answered by
whoever writes the code first.

## Goal

The owner adds a relative as a user and says **"he may see photos of Ivan and
Olga"**. From then on the relative sees every photo where Ivan or Olga is a
confirmed face — the ones there today and the ones tagged tomorrow — in the
**ordinary Gallery**, can download them, and can leave a written note or a voice
recording on any of them. He sees nothing else of the family's photos. Every
portrait in the family tree is visible to him, and portraits can be cut out of a
group photo around one face.

Three parts:

1. **People access** — a person becomes something photo access can be granted on,
   next to a library.
2. **Portraits everyone can see** — a family-tree portrait stops depending on
   access to the library its photo came from.
3. **Portrait crop** — pick a face in a group photo, adjust a square, save it to
   App files.

## Decisions

Answered in the conversation; not to be re-argued.

| # | Decision | Why |
| --- | --- | --- |
| D1 | **People access is part of the viewer's photo scope, not a separate page.** What a user can see = the libraries they have **+** every photo showing a person granted to them. | A relative with no library would otherwise open Gallery to an empty page while their photos sat on a side page without timeline, map, search, memories or slideshows. To them these *are* their photos. |
| D2 | **No albums are created.** The owner's own views do not change at all. | The owner does not want per-person albums cluttering Albums. |
| D3 | **Any granted person in the photo is enough.** A party photo with the granted uncle and ten guests is shared. | Requiring *every* face to be granted would hide nearly every group photo. The owner accepts that guests come along. |
| D4 | **View and download.** No tagging, editing, moving, deleting, rotating, or face confirmation. | |
| D5 | **Notes and voice notes are allowed** on a people-shared photo, by the relative, removable by their author and by admins. | The point of sharing with family is hearing what they remember. |
| D6 | **Only `assignment = 'confirmed'` faces count** (manual whole-photo tags included). `auto` and `suggested` never share. | A wrong automatic match must never expose a photo. |
| D7 | **Live, not a snapshot.** Access is a query over faces, evaluated per request. Unlinking a person, un-confirming a face, excluding or deleting a photo takes it away at once. | No stored copy of "what was shared" to go stale or leak. |
| D8 | **Grants live in `assignments`** (`object_type = 'gallery_person'`), so the subject is a **user or a group**, and `deny` works as it does for libraries. | One access engine (permissions.md). "Petrov family (group) → sees Ivan" comes free. |
| D9 | **Portraits are published, not referenced.** Setting a portrait renders a copy into the family tree's own thumbnail bucket, visible to every tree reader. | Choosing a portrait is already a deliberate editor act; today a gallery-item portrait 404s for anyone without that library (`covers.ts` gates library buckets). |

## What exists (audit, so nothing is re-invented)

| Piece | Where | Relevance |
| --- | --- | --- |
| Grant engine, users + groups + deny | `assignments` table, `permissions.md` | D8. `object_type` is open. |
| Central photo scope | `resolveGalleryScopeLibraryIds` / `resolveGalleryBrowseLibraryIds` (`gallery/catalog-scope.ts`) + `galleryScopeSql` (`gallery/app-files-access.ts`) | **Already carries a per-item rule** (App files by owner) attached to the scope array via `withAppFileOwners`. People access is a second rule of the same shape. Used by browse, people, albums, slideshows, stories, review, Home feed. |
| Per-item checks | `canUserAccessBook(…, "gallery")` in `asset-routes`, `stream`, `voice-note-routes`, `social/subjects.ts`; `getAccessibleLibrary` in `covers.ts` | Every one must learn the people rule — see phase 1. |
| Faces with boxes | `gallery_faces` (`person_id`, `box_*` normalised, `assignment`) | D6 predicate; crop presets (phase 3). |
| Notes on a photo | `notes` + `social/notes.ts`, visibility through `subjects.ts` | Works once `subjects.ts` uses the unified check. |
| Voice notes | `gallery_voice_notes`, audio in App files `Voice notes/<year>`, streamed through the photo | Posting requires **write** access today (`voice-note-routes.ts:27`) — phase 1 relaxes that for D5. |
| Tree photo walls | `familytree/photos.ts` | Uses `accessibleLibraryIds` **directly** (lines ~118, ~160), bypassing the scope helper — must switch, or shared photos won't reach the walls. |
| Portrait storage | `family_tree_persons.portrait_storage_key` (bucket `familytree`, not library-gated) / `portrait_item_id` (library-gated) | D9. |
| App files folder for the tree | `HOUSE_FOLDERS.familyTree` = "Family tree" | Crop output lands here (phase 3). |
| Crop UI | none | New shared component. |

---

## Phase 1 — People access (server)

### Storage

- Grants: `assignments(subject_type, subject_id, 'gallery_person', <gallery_people.id>, 'member')`.
  `member` = view + download (D4). `deny` on a person for a user/group overrides
  their group grants, as for libraries.
- Exclusions: new table `gallery_share_exclusions (item_id PK → library_items ON DELETE CASCADE, created_by, created_at)`
  — "never share this photo by person". Library access is unaffected.
- Index: `gallery_faces(person_id, assignment, item_id)` (replaces the lookup
  on `idx_gallery_faces_person` for this query).
- New tables go straight into `schema.sql`; no column is added to an existing
  table, so no migration is needed for this phase.

### Lifecycle

- **Person merge** moves grants from the merged-away person to the keeper
  (dedupe on the primary key). **Person delete** removes its grants. Both in the
  same transaction as the merge/delete.
- **User delete / group delete** already clear `assignments` rows by subject;
  confirm with a test.

### The rule

`sharedPeopleFor(user)` → the gallery person ids granted to the user or any of
their groups, minus denies; cached per request like the App files rule.

The people predicate, in the style of `VISIBLE_APP_FILES_SQL`:

```sql
li.id IN (
  SELECT f.item_id FROM gallery_faces f
  WHERE f.person_id IN (SELECT value FROM json_each(?))
    AND f.assignment = 'confirmed'
) AND li.id NOT IN (SELECT item_id FROM gallery_share_exclusions)
  AND li.library_id NOT IN (<Photo Inbox + App files library ids>)
```

Photo Inbox (not kept yet) and App files (the app's own files) are never shared
by person, and trashed items are already excluded by the scope queries.

### Wiring

1. `withSharedPeople(user, libIds)` attaches the rule to the scope array next to
   `withAppFileOwners`, and `galleryScopeSql` ORs it in. Both
   `resolveGalleryScopeLibraryIds` and `resolveGalleryBrowseLibraryIds` attach
   it, so every surface that already goes through the helper gets it at once:
   timeline, map, memories, facets, search, People, Home feed, albums the user
   can open, slideshows, stories' photo blocks.
2. **One per-item check**, `canSeeGalleryItem(user, itemId)` (library access OR
   App files rule OR people rule), replacing the gallery calls of
   `canUserAccessBook` in `asset-routes`, `stream` (original, preview,
   transcode), `voice-note-routes` (listen), `social/subjects.ts`, and any
   download route.
3. **`covers.ts`**: when the library-bucket check fails, resolve the item the
   thumbnail belongs to (cover or preview key, like `appFileItemForThumbnail`)
   and allow it through the people rule. **Face-crop thumbnails** of *other*
   people in a shared photo stay refused.
4. **`familytree/photos.ts`** switches to `resolveGalleryScopeLibraryIds` +
   `galleryScopeSql`.
5. **Rights on a people-shared photo** (not in a library the user has):
   view, download, add/remove *own* note, add/remove *own* voice note, Send to.
   Everything else answers 403 regardless of what the client shows. The
   voice-note POST accepts `canSeeGalleryItem` **when** the route's write check
   fails only because of this; recordings still land in App files under the
   photo, exactly as today.

### What the relative sees — privacy rules

Enforced on the server, not only hidden in the client:

| Surface | Rule for a photo seen only through people access |
| --- | --- |
| **Faces / People** | Names and face boxes only for granted people. Other faces are not listed. The People page lists only granted people. |
| **Folders view** | Not shown for these photos — folder names reveal things ("Hospital 2019"). Folders show only libraries the user actually has. |
| **Library filter facet** | The source libraries are not named. One pseudo-entry, "Shared with you", narrows to people-shared photos. |
| **Lightbox → File panel** | No path, folder or library name; file type, size, dimensions and date are fine. |
| **Details** (date, place, caption, tags, map) | Shown — it is their photo to look at. |
| **Albums / slideshows** they can open | Show the photos they can see; others in the album stay hidden, as today. |
| **Creating** albums, slideshows, stories from them | Not in v1 (open question Q3). |

### Tests

- The permission matrix in the style of the family-tree access tests: a user
  with no library + one person grant sees exactly the confirmed-face photos, not
  `suggested`/`auto`, not excluded, not Inbox/App files, not trashed; group grant;
  deny beats group; merge carries grants; unlink/un-confirm/exclude remove access.
- Every per-item route (asset, original, preview, stream, download, cover,
  face thumb, voice-note audio) for an allowed and a refused photo.
- Other faces' names/thumbs are absent from the asset payload.
- Folder routes and the library facet leak no library id or path.

## Phase 2 — People access (UI)

### For the admin — two places, one grant

- **Control → Members → Users → (user) → Photo access** (a card on the existing
  user page, not a new tab): libraries as today, plus **Photos of people** — a
  person picker over gallery People with face thumbnails. Same card on a
  **group**.
- **Gallery → People → (person) → Who can see photos of …** — users and groups
  granted this person, add/remove.
- **Preview before saving:** "Olga will see 1,284 photos" with a strip of the
  most recent, and a **View as Olga** link opening the timeline in her scope
  (read-only admin preview; the server takes the target user's scope, never
  their session).
- **Don't share this photo** in the lightbox's ⋯ menu and on the multi-select
  bar (admins, and managers of the photo's library), with a clear badge on
  excluded photos in the admin's view.
- Search terms in `features/control/search-index.ts` ("share photos of person",
  "people access"), with an anchor on the card.

### For the relative

- Gallery appears in their nav as soon as they have a library **or** a person
  grant.
- First visit: a one-time notice (`MessageBox` info): "Photos of Ivan and Olga are
  shared with you. New photos appear here as they are tagged." Dismissed for good.
- The **For you** page gets a "New photos of Ivan" card when photos arrive for a
  granted person (derived from face confirmation time, no stored feed — the
  family-sharing rule).
- Lightbox: Download, Note, Record, Send to; no edit controls.

### Owner hears back

A note or voice note on a photo appears in the existing activity/family row, and
— when the `shareNotifications` email flag is on — mails the photo library's
managers. No new notification system.

### i18n / conventions

All strings as keys in `locales/en/common.json` + `ru/` (counts via
`t(key, { count })` — "1 284 фотографии"); dialogs through `shared/Modal`,
removals through `ConfirmDialog`; a new guide section in `docs/users/` and its
Help-page entry (`check:ui` enforces both).

## Phase 3 — Portraits everyone can see

- Setting a portrait from a gallery item (**and** every existing
  `portrait_item_id` portrait, via a one-time startup backfill) renders a
  portrait image into the `familytree` bucket — the same bucket uploaded
  portraits use, which the covers route does not gate by library.
- `family_tree_persons` keeps where it came from for re-cropping:
  `portrait_source_item_id` and `portrait_crop_json` (`{x,y,w,h}` normalised).
  These are **new columns on an existing table → a migration** (never edit
  `migrate.ts` while `npm run dev` runs — the tsx-watch footgun).
  `portrait_item_id` retires into `portrait_source_item_id`.
- When the source photo is deleted, the portrait stays (it is a published copy),
  and the "re-crop" action says the original is gone.
- Renders go through `renderInTurn()` and read the source as a **Buffer**
  (the two sharp rules in CLAUDE.md).
- The **photo walls** stay viewer-scoped (they now include people-shared photos,
  phase 1); only the portrait is universal.

## Phase 4 — Portrait crop

### Component

`shared/ImageCropper` (new; no crop exists in the app): the photo, a square
frame the user drags and zooms (pointer + wheel + pinch, keyboard arrows for
nudging), rule-of-thirds guides, a live round preview as the tree chart shows
it. Aspect ratio is a prop, so story covers and gallery person covers can reuse
it later.

### Pick a face

After a photo is chosen in the portrait picker (`FamilyPhotoPicker` → all three
sources), its detected faces are drawn as outlined boxes with names where known.
**Clicking a face** sets the frame: square, centred slightly above the face, the
face box about 45% of the frame's height so hair and shoulders fit, clamped to
the image. The face linked to this tree member (`gallery_person_id`) is
preselected when present. Then the user adjusts and saves.

### Saving

`POST /api/family-tree/persons/:id/portrait/crop { itemId, crop }` (editor
rights as for the portrait today):

1. Read the original as a Buffer, apply EXIF orientation, extract the crop,
   resize to 1024 px, encode JPEG q88 — inside `renderInTurn()`.
2. Write the file to **App files → Family tree → Portraits/** as
   `<person name> (<source file name>).jpg`, catalogued as a gallery item
   marked **derived** (`gallery_details.derived_from_item_id`) — see the risk
   below.
3. Render the portrait thumbnail into the `familytree` bucket (phase 3) and set
   `portrait_source_item_id` / `portrait_crop_json`.

**Re-crop** opens the cropper on the original with the saved frame.

### Risk: a crop is a new photo of the same face

A catalogued crop would be face-scanned, grow a second copy of Ivan's face,
appear in his photo wall and in duplicate detection. Derived items
(`derived_from_item_id IS NOT NULL`) are therefore **skipped by the face
scanner, the duplicate scan, memories and the timeline**; they are reachable
only as the portrait and in App files' contents page. (Same migration as
phase 3.)

## Order and size

| Phase | Needs | Size |
| --- | --- | --- |
| 1 People access — server | — | Large: the rule is small, the test matrix and the per-item audit are the work |
| 2 People access — UI | 1 | Medium |
| 3 Portraits everyone can see | — | Small |
| 4 Portrait crop | 3 | Medium |

3 and 4 are independent of 1–2 and can ship first if wanted: they already fix
the blank portraits for any member who lacks a library today.

## Open questions

- **Q1 — Themselves.** A relative linked to their own gallery person (their own
  face): see photos of themselves automatically, or only when granted? Suggest:
  offered as a checkbox on the grant card, off by default.
- **Q2 — Family-tree branches as grants.** `object_type = 'family_tree_tag'`
  would share every member of a branch, including relatives added later, through
  their `gallery_person_id`. Worth it, but after v1 — the grant-by-person path
  has to be right first.
- **Q3 — Making things from shared photos.** Should a relative be able to build
  an album or slideshow of their shared photos? Suggest later; view, download,
  notes and voice notes first.
- **Q4 — Guest links.** Should a people-shared photo be sendable onward by the
  relative as a guest link? Suggest **no**: Send to other *users* only, so
  sharing never escapes the owner's control.
- **Q5 — Cropper: in-house vs a dependency** (`react-easy-crop`). Suggest
  in-house — one square, pointer events, face presets — unless pinch/zoom
  polish on tablets turns out costly.
