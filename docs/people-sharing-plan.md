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

**Reviewed 2026-09-23** against an outside proposal
(`isputnik_person_identity_photo_sharing_proposal.md`, not in the repo) and the
live schema; what was taken from it and what was not is under
[Outside proposal](#outside-proposal-what-was-taken). The admin side was
redesigned the same day around **one place for everything a person can reach**:
the [Access dialog](#the-access-dialog), phase 2.

**Phase 1 built in-code 2026-09-23; phase 2 and Family tree access built in-code
2026-09-24** (all uncommitted). As built — see [Phase 1 as built](#phase-1-as-built)
and [Phase 2 as built](#phase-2-as-built). Released as 4.22.0. **Preview as …** built after it (core/preview.ts: a
session cookie an admin's session honours for an active member; request.user
becomes the member, request.previewBy the admin; everything but GET/HEAD, routes
marked `config.previewSafe` (the POST catalogues, timeline, lookups), `/api/preview`
and sign-out answers 403; `logActivity` skips; the web never caches a previewed
user). The For you "New photos of Ivan" row built after that (modules/social/for-you.ts
`personRows`: photos whose confirmed face's `updated_at` is later than the grant
reaching the viewer — a group grant from when they joined — or than the row's
`shared_person_seen.cleared_at`; See photos opens `/gallery/people/<id>`, and
it and Not now both clear). The People page's "Shown as living to others" filter
followed (a `living` flag from `decoratePersons`, an admin-only chip in the strip).
The plan is fully built.

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
| D6 | **Only `assignment = 'confirmed'` faces count** (manual whole-photo tags included). `auto` and `suggested` never share — and **confirming is part of sharing**: the grant shows how many of a person's photos are only auto-matched ("Review 12"), and the review confirms the right ones and rejects the wrong ones in one pass (2026-09-23). | A wrong automatic match must never expose a photo. And naming a face group or merging two does NOT confirm its faces (only assigning one face, moving photos, a hand tag or accepting a suggestion does), so on the dev data all 115 faces are `auto`: without the review step a grant would share nothing. |
| D7 | **Live, not a snapshot.** Access is a query over faces, evaluated per request. Unlinking a person, un-confirming a face, excluding or deleting a photo takes it away at once. | No stored copy of "what was shared" to go stale or leak. |
| D8 | **Grants live in `assignments`** (`object_type = 'gallery_person'`), so the subject is a **user or a group**, and `deny` works as it does for libraries. | One access engine (permissions.md). "Petrov family (group) → sees Ivan" comes free. |
| D9 | **Portraits are published, not referenced.** Setting a portrait renders a copy into the family tree's own thumbnail bucket, visible to every tree reader. | Choosing a portrait is already a deliberate editor act; today a gallery-item portrait 404s for anyone without that library (`covers.ts` gates library buckets). |
| D10 | **Location is a toggle per grant, off by default**: "Show where photos were taken" on the recipient (user or group). Off hides, for photos seen ONLY through people access, the GPS, the place name, the map pins and the Places / place filter entries they would add. On any grant path = on. | Coordinates show where the family lives and goes; the owner chose a toggle (2026-09-23). |
| D11 | **Existing notes and voice recordings on a shared photo are visible** to the relative, as well as their own. | The owner's answer (2026-09-23): a photo's notes are about the photo, and hearing them is the point. |
| D12 | **No identity registry.** Records stay linked in pairs as today (tree member → face group → author). An **account → family-tree person** link comes later, with Q1, and never grants anything by itself. | Agreed 2026-09-23 after reviewing the outside proposal: a registry table plus links from every record is a lot of machinery for a household. |
| D13 | **One place for everything a person can reach**: the Access dialog (phase 2), opened from Members → Users. The per-object editors stay; they edit the same rows. | Today access is set in seven places, each from the object's side, and nothing answers "what can Michael see?". |
| D14 | **Seeing the family tree is a grant**, like a library: `assignments(…, 'family_tree', 'tree', viewer or deny)`. Everyone keeps view by default, so nothing changes for the household; a person or group can be switched to "can't see it". | Today every signed-in user sees all of it (2026-09-23). |
| D15 | **Living relatives are protected.** For a viewer who does not edit that person's branch, a living person shows name, place in the tree and portrait only — no dates, places, biography, events, notes, quotes or map pins. A per-recipient toggle "Show details of living relatives": on for the household as it is, off by default for anyone added later. | The standard genealogy rule; lets a distant relative see ancestors in full without seeing a child's birth date (2026-09-23). |
| D16 | **Living = no death date, not marked deceased, and not born more than 100 years ago.** No dates at all counts as living until someone says otherwise, through a new "Deceased (date unknown)" mark. | Safe by default. 47 of the 99 dev tree members have no dates at all, so the mark (with a bulk action) is what keeps old ancestors readable. |
| D17 | **GEDCOM export: admins and branch editors only** (was any signed-in user). An editor's export privatises living people outside their branches, as D15. | A whole-tree file is a copy of everyone's data, not a view. |
| D18 | **Groups first.** The usual way to give a relative access is a group ("Petrov family") with its grants, and adding the person to it. Direct grants on a person stay possible. | The owner's answer to Q6 (2026-09-23). |
| D19 | **Invites carry groups.** An invite names the groups its person joins on sign-up, so a relative arrives with access in place. | The owner's answer to Q7. With D18, groups are all an invite needs to carry. |
| D20 | **The Libraries tab lists every library**, "no access" included. | Q8: it is clearer about what someone can NOT see. |
| D21 | **Shared directly is a tab**, each item with Remove. | Q9: the admin sees and can undo everything sent to one person. |

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
- Settings per recipient: new table `access_settings (subject_type, subject_id, show_location INTEGER NOT NULL DEFAULT 0, show_living_details INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (subject_type, subject_id))`
  — D10 and D15 (see Family tree access). No row = defaults. Removed with the subject.
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
| **Details** (date, caption, tags) | Shown — it is their photo to look at. |
| **Location** (GPS, place name, map pin, Places, place filter) | Only when the grant's "Show where photos were taken" is on (D10). The server drops the fields; the map and the place facets skip these photos. |
| **Notes and voice notes** | All of the photo's notes and recordings, and their own (D11). |
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

### Phase 1 as built

- **Files.** `gallery/people-access.ts` (the rule, grants, settings, exclusions,
  counts, review list, thumbnail check, redaction), `gallery/people-access-routes.ts`
  (admin API below), new tables `access_settings` (with `show_living_details`
  already, for the tree section) and `gallery_share_exclusions` plus the index —
  straight into `schema.sql`, no migration.
- **Who is asking: `core/viewer-context.ts`.** Every route handler now runs in an
  AsyncLocalStorage context (wired in `registerAuthDecorators`), so `mapAsset` —
  the one function every photo list goes through (timeline, albums, stories,
  feed, tags, …) — redacts for the viewer without each route passing the user.
  `runAsViewer(user, fn)` for tests and jobs. Outside a request nothing is redacted.
- **Scope options** on `galleryScopeSql`: `{ people: false }` (Folders and folder
  search), `{ location: true }` (map, places, place facet, the GPS count — shared
  photos join only with D10 on), `{ faceAlias }` (People list, people facet — on a
  shared photo only granted faces count), `{ onlyForPerson }` (one person's photos).
  Empty-scope shortcuts everywhere became `scopeIsEmpty(libIds)`: a relative with
  no library has an empty list and a rule.
- **Resolver.** Shared photos are in the default browse scope and `ALL_LIBRARIES_SCOPE`;
  `SHARED_PEOPLE_SCOPE` ("shared-people") narrows to them; naming libraries leaves
  them out. The reachable scope carries them too (viewer, albums, stories).
- **One-photo checks.** `canUserAccessBook` and `canUserDownloadBook` learnt the
  rule, so the viewer, the file stream, notes (through `social/subjects.ts`) and
  Send to follow. Voice notes: a relative may record on a shared photo and remove
  only their own. Thumbnails (`covers.ts`): a shared photo's cover and preview,
  and a SHARED person's face crop — never another guest's; sent `max-age=300`
  instead of a year.
- **Tree photo walls** (`familytree/photos.ts`) include shared photos.
- **Merge** moves grants (a deny on either side survives); **deleting a person**
  removes them; deleting a group removes its settings row. Only a NAMED person
  can be granted — clustering deletes unnamed groups on its own. Everyone-group
  rows on a person are ignored.
- **Admin API** (all `requireAdmin` except the exclusion, which a library manager
  may set): `GET /api/library/gallery/people/:id/sharing`, `PUT|DELETE
  …/people/:id/sharing/:subjectType/:subjectId`, `GET /api/library/gallery/access/
  :subjectType/:subjectId` (people direct + via groups, counts, settings, photo
  count), `PUT …/access/:subjectType/:subjectId/settings { showLocation }`, `GET
  …/people/:id/review`, `POST …/people/:id/confirm { confirm, reject }`, `PUT|DELETE
  /api/library/gallery/assets/:id/share-exclusion`. Every write is an activity event.
- **Known and accepted:** the timeline's text search and people filter still match
  an unshared person's NAME on a shared photo when typed by hand (the facet no
  longer offers those names; the face itself is visible anyway), and the "has a
  location" filter tells a shared photo has coordinates without saying where.
- **Tests:** `apps/server/test/gallery-people-access.test.ts` — the rule, groups and
  deny, review/confirm/reject, exclusion, merge/delete, group deletion,
  redaction (folder, library, location, other faces, People, facets), folders,
  the shared-people filter, thumbnails, and the HTTP path end to end.

## Phase 2 — People access (UI)

### The Access dialog

Where access is set today — seven places, each from the object's side:

| What | Set in | Stored as |
| --- | --- | --- |
| Admin or member | Members → Users (Edit) | `users.role` |
| Group membership | Members → Groups | `group_members` |
| Libraries | Library → Libraries → a library → Members | `assignments` (library) |
| Photo Inbox reviewers | Library → Storage → Inbox reviewers | `assignments` (photo_inbox) |
| Story collections | Stories → a collection → Access | `assignments` (story_collection) |
| Family tree branch editors | Family tree → Settings → Security | `assignments` (family_tree_tag) |
| Albums, slideshows, items sent to one person | on each of them | `shares` |

Photos of people would be an eighth. Instead, **Members → Users → Edit** grows
into one dialog that shows and changes all of it for one person (D13). A
`panel` Modal with a tab row, like the family-tree settings and book metadata
dialogs — the control panel's "no second row of views inside a page" rule is
about pages, and a dialog with tabs is an existing pattern.

```
┌ Michael Johnson ─────────────────────────── [Preview as Michael] [×] ┐
│ Member · 1 library · photos of 2 people · edits Petrov branch        │
│ Account │ Groups 1 │ Libraries 1 │ Photos of people 79 │ Family and  │
│ stories │ Shared directly 2                                           │
├───────────────────────────────────────────────────────────────────────┤
│ Michael sees every photo where one of these people is confirmed.      │
│                                                        [+ Add people] │
│ Ivan Petrov                           48 photos        [Review 12]    │
│ Olga Petrova · via Petrov family      31 photos        All confirmed  │
│ ☐ Show where photos were taken                                        │
│ 79 photos in his Gallery · 3 excluded · reads and adds notes          │
└───────────────────────────────────────────────────────────────── Close┘
```

(An interactive version was shown in the conversation of 2026-09-23; this
sketch is its record.)

| Tab | Holds |
| --- | --- |
| **Account** | Today's Edit dialog: name, email, admin or member, password, two-factor, sessions, lock or delete |
| **Groups** | The groups they are in, each with a line of what it gives; add, remove |
| **Libraries** | Every library: **given directly** (editable) and **what they get** with where it comes from ("View · via Everyone", "via Petrov family", "denied") |
| **Photos of people** | The people granted (direct or via a group), photo counts, **Review N** for auto-only matches (D6), the location toggle (D10), excluded photos; Add people opens a person picker over gallery People with face thumbnails |
| **Family and stories** | Branches they can edit, story collections and their role, Photo Inbox reviewer level |
| **Shared directly** | Albums, slideshows and books sent to them (`shares`), who sent each and when; Remove |

Rules for it:

- **Direct vs. what they get.** Only a direct grant is edited here. An inherited
  one names its source and links to it (the group, Everyone), so changing it is
  a visible choice that affects other people, never a side effect.
- **Same rows everywhere.** The per-object editors (a library's Members, a
  collection's Access, the tree's branch editors, Inbox reviewers) stay and
  edit the same `assignments` rows, so both sides always agree. Each gains a
  link from a person's row to their Access dialog.
- **A group has the same dialog**, from Members → Groups: Members instead of
  Account, then the same grant tabs.
- **The header says it in one line**: the summary under the name, and counts
  on the tabs, stand in for the overview a long page would have given.
- **It has an address.** `CONTROL_PATHS.users` + `?user=<id>&tab=photos`
  (seeded through `initialParam`, linked through `links.ts`), so other pages
  open it on a tab: a person's page in the Gallery ("Michael and the Petrov
  family can see these"), a library's Members dialog, the activity log.
- **Review opens over it** — a Modal on top (the stack supports it): the
  person's auto-only photos in a grid, untick the wrong ones, **Confirm N**;
  closing returns to the Photos tab with the counts updated.
- **Preview as Michael** closes the dialog and opens the Gallery in his scope,
  read-only, with a banner to leave (the server takes the target's scope, never
  their session).
- **Don't share this photo** stays where the photo is: the lightbox's ⋯ menu and
  the multi-select bar (admins and managers of the photo's library), with a
  badge on excluded photos in the admin's view. The Photos tab lists them.
- **Activity.** Every grant, removal, review and toggle is a `logActivity` event
  (`access.person.granted`, …), so the log answers who shared what, when.
- **Search.** `search-index.ts` terms ("share photos of person", "user access",
  "what can this user see") open Members → Users.

Server side of it: `GET /api/admin/users/:id/access` (and `/groups/:id/access`)
returns every tab in one read — groups, each library with its direct role and
effective role + source (from `resolveObjectRole`), person grants with counts
(confirmed, auto-only, excluded) per D6, the settings row, tree tags, story
collections, Inbox level, shares. Writes reuse the existing per-object routes
where there are some; new ones for person grants, the settings row and the
review (`POST …/gallery/people/:id/confirm { itemIds, rejectIds }`).

### Groups first (D18)

- **Members → Groups** is where a relative's access is usually set: create
  "Petrov family", give it photos of Ivan and Olga, the Petrov archive library,
  the tree with living relatives protected, then add people to it. The group's
  Access dialog is the same as a person's, with **Members** first.
- In a person's dialog, each grant tab leads with what their groups give
  ("via Petrov family") and offers **Add to group** before **Add directly**; a
  direct grant is still one click, for the exception.
- New groups start with the safe defaults: location off (D10), living details
  off (D15).

### Invites (D19)

- New table `invite_groups (invite_id → invites ON DELETE CASCADE, group_id →
  user_groups ON DELETE CASCADE, PRIMARY KEY (invite_id, group_id))` — a new
  table, so straight into `schema.sql`.
- **Members → Invites → Create invite** gets a "Joins these groups" picker, and
  the invite list shows them. Accepting the invite adds the new account to
  those groups in the same transaction that creates it; a group deleted
  meanwhile is simply skipped.
- The invite's own page (what the relative sees before signing up) says nothing
  about groups or access — that is for the admin to know.
- After sign-up the admin's activity log shows "Michael joined, into Petrov
  family", linking to his Access dialog.

### Also from the person's side

- **Gallery → People → (person) → Who can see photos of …**: the users and
  groups granted this person, add or remove, each opening their Access dialog.

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

### Phase 2 as built

- **Access dialog:** `features/control/access/AccessDialog.tsx` (+ `types.ts`,
  `PeopleReviewModal.tsx`), from Members → Users (Edit, ⋮ → Access and permissions,
  or the name) and Members → Groups (Manage, which replaced the old members modal).
  `?user=` / `?group=` + `&tab=` open it (`userAccessHref` / `groupAccessHref`).
  One read: `GET /api/access/:subjectType/:subjectId` (`modules/users/access-routes.ts`)
  — libraries (all, D20), branches, collections, Inbox, the tree, shares — each as
  direct + inherited (+ effective for a user). Writes go through the existing routes.
- **Invites carry groups** (D19): `invite_groups` table, `groupIds` on create,
  joined in the accept transaction.
- **Relative's side:** `/api/library/gallery-libraries` returns `sharedPeople`; the
  Gallery opens with no library when there are some, with a one-time notice.
- **Person's side:** `PersonSharingModal` ("Who can see photos of …") on the People
  page; "Don't share this photo" in the lightbox ⋯ menu, from `asset.shareControl`
  (library managers and admins).
- **Family tree access:** `familytree/tree-access.ts` — the tree is open unless a
  `deny` on `('family_tree','tree')` covers the viewer (so no seeding, same on fresh
  installs); every tree route is `[authenticate, requireTreeView]`; the portrait
  bucket and tree subjects follow. Living redaction lives in `decoratePersons`
  (`restricted` flag) plus marriages, profile events/citations and the map;
  migration 83 adds `deceased` and turns `show_living_details` on for every user and
  group that existed. `PUT /api/family-tree/viewers/:type/:id { canSee?,
  showLivingDetails? }`, `POST /api/family-tree/persons/deceased`. GEDCOM export:
  admins and branch editors, privatised by the same `restricted` rule.
- **Tests:** `access-overview.test.ts`, `family-tree-privacy.test.ts`.

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

## Family tree access

Decided with the owner on 2026-09-23 (D14–D17), to ship **with** phases 1–2: a
relative invited for photos also reaches the tree, which today shows every
member's details to any signed-in user and lets them export it. The first
recipient (the cousin) keeps seeing the tree, living relatives protected.

**What stays as it is:** branch editing by tag (`family_tree_tag` grants,
`access.ts`) and its rules; the tree is still one tree — **no branch-only
view**, because hiding people breaks the chart (parents vanish, marriages point
at nobody) and the gaps still tell that someone is there. D15 covers the real
risk instead.

### Server

- **Storage.** The view grant is an `assignments` row (`object_type =
  'family_tree'`, one object id `'tree'`); a startup step writes
  `Everyone → viewer` if there is no row yet, so an upgrade changes nothing.
  The living toggle goes into the same `access_settings` row as the location
  one (Phase 1 → Storage). `show_living_details`
  defaults to 1 for subjects that exist at the upgrade (the household) and 0 for
  users and groups created after it. New column `family_tree_persons.deceased
  INTEGER NOT NULL DEFAULT 0` (a migration: a column on an existing table).
- **`isLiving(person)`** in `familytree/persons.ts`: `death_date IS NULL AND
  deceased = 0 AND (birth_date IS NULL OR birth_date > <today − 100 years>)`,
  in SQL too, so lists filter without loading everyone.
- **`canSeeTree(user)`** gates every `/api/family-tree/*` read, the family
  map, the tree's photo walls and the portraits in the `familytree` bucket
  (`covers.ts` learns that bucket's rule). Search, the People list, stories
  and notes that name a tree member degrade to "unavailable" through
  `social/subjects.ts`, as a hidden book does.
- **One redaction point.** `decoratePersons` (already per viewer, for
  `canEdit`) also redacts: for a living person the viewer does not edit, and
  without `show_living_details`, it blanks birth/death dates and places, pins,
  bio, other names' extras, and sets `restricted: true`. Profile, events,
  citations, quotes and notes routes check the same flag and send nothing.
  The map drops those entries. Relationships and the name stay (D15).
- **GEDCOM export** (D17): admins get everything; branch editors get the file
  with living people outside their branches written as name + relationships
  only (the usual "privatised" GEDCOM form); everyone else 403.

### Admin UI

- **Access dialog → Family and stories:** "Family tree: Can see it / Can't see
  it", "Show details of living relatives", then the branches they edit (as the
  sketch). The group dialog has the same.
- **Edit person:** a "Deceased (date unknown)" checkbox beside the death date,
  greyed out once a death date is written.
- **Family → People:** a bulk action "Mark as deceased" on the selection (the
  47 undated members are a few clicks, not 47 dialogs), and a filter "Shown as
  living to others" so the admin sees who is protected.
- The profile of a protected person, seen by the relative, says why in one line
  ("Details of living relatives are private") instead of showing empty fields.

### Tests

- Tree view grant: default Everyone, a user denied, a group denied, deny beats a
  group grant; every tree read route and the portrait bucket answer 403/404 for
  a denied user.
- Living rule: death date, deceased mark, born 101 vs 99 years ago, no dates at
  all; redaction on for a new user, off for an editor of the branch, off with
  the toggle; the map and the profile routes leak none of it.
- GEDCOM: admin full, editor privatised outside the branch, member refused.

## Order and size

| Phase | Needs | Size |
| --- | --- | --- |
| Family tree access (server + UI) | ships with 1–2 | Medium: one redaction point, one gate, the migration and the bulk action |
| 1 People access — server | — | Large: the rule is small, the test matrix and the per-item audit are the work |
| 2 People access — UI | 1 | Medium |
| 3 Portraits everyone can see | — | Small |
| 4 Portrait crop | 3 | Medium |

3 and 4 are independent of 1–2 and can ship first if wanted: they already fix
the blank portraits for any member who lacks a library today.

## Outside proposal: what was taken

Reviewed 2026-09-23 with the owner against the live schema.

| Proposal | Taken? | Why |
| --- | --- | --- |
| Share by gallery person, not per photo | Yes | Already the plan |
| Identity links never grant access | Yes | D12 |
| **Snapshot** by default (new photos not added) | No — live (D7) | The owner asked for new tagged photos to appear; a snapshot needs a stored list of photo ids per grant |
| Original downloads off by default | No — view + download (D4) | The owner's choice |
| GPS hidden by default | Yes, as a toggle (D10) | New point, accepted |
| Others' notes and recordings hidden | No — visible (D11) | The owner's answer |
| Unconfirmed AI matches only by admin opt-in | Stricter: never, plus the review step (D6) | |
| Groups as recipients | Yes | `assignments` already takes groups |
| Exclusions per policy | No — one global "don't share this photo" | Simpler for one family |
| Policy / member / exclusion tables | Partly: `assignments` rows + exclusions + a settings row | The existing engine holds the grant; only D10 needs a row of its own |
| `person_identities` registry | Not now (D12) | |
| User page tabs Overview / Identity / Access / Activity | Reshaped as the Access dialog | A page may not carry a second tab row; a dialog may |
| Audit trail of shares | Yes | `logActivity` events |
| Revocation must reach caches | Partly | The server refuses at once; thumbnails a browser already holds (sent `immutable` for a year) can linger there. For photos seen only through people access, send a short `Cache-Control` instead |

Facts from the schema that answered the proposal's section 9: who is in a photo
lives in ONE table, `gallery_faces` (scan faces with boxes and hand tags with
none); one real person can be split over several face groups, and merging is
supported (grants must follow a merge — see Lifecycle); `users` links to no
person record at all today.

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
- **Q5 — Cropper: in-house vs a dependency.** Answered by building it: in-house
  `shared/ImageCropper` (4.21.0).
