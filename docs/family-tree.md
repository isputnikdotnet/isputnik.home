# Family tree

A genealogy module: family members, how they relate, what happened to them, and
the photos that show it. It sits beside the Digital Library in the main nav but
is **not a library type** — it has no source folder, no scanner, and no files of
its own. Its defining choice:

> **The tree is data, not media.** Everything lives in `family_tree_*` tables and
> is typed in by hand or imported from GEDCOM. Photos are *borrowed* from gallery
> libraries by reference, so a photo is never copied or owned by the tree.

That has a practical consequence worth knowing up front: a library rebuilds
itself from disk by rescanning, but **the family tree only exists in the
database**. Back it up, or export GEDCOM, before anything drastic.

## Three kinds of "person"

The app has three unrelated person concepts. Confusing them is the classic bug:

| Table | What it is |
|---|---|
| `people` | Book contributors — authors, narrators |
| `gallery_people` | Face clusters found by face recognition |
| `family_tree_persons` | Family members |

`family_tree_persons.gallery_person_id` bridges the third to the second, so a
member's face-cluster photos surface on their profile. (The dormant
`gallery_people.linked_person_id` points at *contributors* — not this.)

## Data model

```
family_tree_persons      one row per family member; portrait, dates, bio
family_tree_unions       a couple (person1 + optional person2) with marriage info
family_tree_children     union → child, with a relation (biological/adopted/…)
family_tree_events       a person's timeline entries beyond birth/death
family_tree_event_photos gallery items attached to one event
family_tree_photos       gallery items attached to one person
family_tree_sources      shared bibliography ("where a fact came from")
family_tree_citations    source → exactly one person, event, or union
```

**Children always hang off a union**, never off a person directly — that is what
makes a second parent, a remarriage, or a single parent (`person2_id IS NULL`)
all expressible in one shape. Two guards protect the graph: one parent-union per
child, and a cycle check so nobody becomes their own ancestor.

Deleting a person promotes any surviving partner into `person1_id`, so the
remaining single-parent union keeps its children. A union with nobody left is
deleted, cascading only its child *links* — never the child rows.

### Partial dates

Dates are TEXT in `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` form, validated by
`partialDateSchema`. Lexicographic order is chronological, and GEDCOM's partial
dates map onto this 1:1. Date inputs are free text, not native date pickers —
year-only is the norm in genealogy and a date input would silently blank it.

## The chart

`FamilyTreeChart.tsx` renders hand-rolled SVG; the layout maths is pure and
lives in `chart-layout.ts`. It flows top-to-bottom in the Ancestry style:
generations are rows, ancestors rise above the focused person, descendants hang
below, and siblings/cousins lay outward on their own generation's row. Clicking
a card re-centres via a real navigation to `/family/tree/:id`, so Back walks the
focus history.

**Who it opens on** — three fallbacks, resolved in `FamilyTreePage.tsx`:

1. the `:id` in the URL,
2. `tree.defaultPersonId` — the house-wide **starting person** an admin sets in
   Settings → Starting person, shipped on the `/tree` payload so the first render
   is already correct (a second request would show the fallback, then jump),
3. `defaultFocusId()` in `chart-layout.ts` — `person1` of the earliest-married
   union, else the alphabetically-first person.

Each step checks the person is actually in the loaded tree, so a stale id (a
bookmark to someone since deleted, or a starting person removed from the tree)
falls through to the next rather than leaving the chart with nothing to centre on.

**Card badges** are SVG `<g role="button">` (`ActionBadge`), not DOM buttons —
lucide components can't render inside SVG geometry, so the icons are inlined
paths. Each card carries exactly one: a "⋯" badge in the top-right corner that
opens the card menu (open profile; plus edit and add-a-relative when the viewer
may edit that person). The menu itself is HTML floating over the SVG — its
position is mapped from the badge's user-space coordinates every render, so it
stays glued to the card while the chart pans and zooms, and any pan, zoom, or
click elsewhere dismisses it.

**Chart chrome** — three floating panels inside the frame. Top-left, a
**rail** (icon over a small label): **Add person** on its own above a divider
(when the viewer may add), then **Home** (drops the `:id` from the URL so the
chart returns to the starting person, and re-fits), **All People**, **Families**,
then under a second divider **Import** and **Settings** (admin) and **Export**.
Each of those is a prop on `FamilyTreeChart` that the page leaves undefined when
the viewer may not do it, so permission lives in one place. Fitting is the
bottom-right control's job only — it was in the rail too and that was one button
too many.
Right edge, the **legend**: parent/child connector, marriage rings, and the card
tints (male/female/not recorded/focused). Bottom-right, zoom −/+ with the current
percentage and a fit button. On mobile the rail collapses to icons and the legend
is hidden. All of this used to sit in the page header, which is now just the
title, the person count, and search.

The add-relative item opens `AddRelativeModal`, which asks parent or child and then hands
off to the same `AddParentModal` / `AddChildModal` the profile page uses. Those
need a full `FamilyPersonProfile` to know what they're doing (fill an empty
parent slot vs start a new family; which union a child hangs off), and the chart
only holds summaries — so the profile is fetched **after** a kind is chosen: one
request per use of the badge, none for rendering the chart. Partner and sibling
stay on the profile, where the surrounding family is in view.

**Current vs former partner** — a person can sit between two spouse cards, so
`UnionBadge` draws each union's status. All four are built from arcs, so they
stay crisp at any zoom:

| status | badge |
| --- | --- |
| `married` | interlocked rings, **woven**, gold |
| `partners`, `unknown` | the same rings in neutral ink |
| `widowed` | the same rings as a faded ghost, dashed plate |
| `divorced` | rings pulled apart, cut by the genealogist's `//`, rose, dashed plate |

The weave is the trick worth knowing: draw both rings, then redraw a short arc of
the right ring over the crossing — first in the plate colour at double width (the
"cut"), then in the ring colour. Its endpoints are on the right ring either side
of the crossing at `(x, y ± 3.264)`, so the arc's midpoint lands exactly on the
crossing; move `offset` or `ringR` and those numbers must be recomputed or the
rings stop looking linked.

`isEndedUnion` (divorced/widowed) also dashes the **spouse link** itself, which is
what you actually notice from across the chart. Descent lines never dash — the
children are no less the couple's for it. The badge's `<title>` names the exact
status, which is how you tell divorced from widowed. `unknown` deliberately reads
as current: it is the default for quick-created and GEDCOM-imported unions, and
guessing "ended" from missing data would be worse than showing nothing.

> **Footgun:** never put a `clipPath` on a transformed silhouette `<g>` —
> `userSpaceOnUse` clip rects get dragged by the transform and the silhouettes
> vanish.

## Life events

`family_tree_events` covers what the birth/death columns can't: residence,
education, graduation, occupation, retirement, military, immigration,
emigration, naturalization, travel, award, baptism, burial, and a catch-all
custom. `label` is the short "what" (job title, school name) and is required
only for `custom`. `date`/`end_date` express ranges ("school 1971–1975").

Each event can carry its own gallery photos. On the profile timeline a row shows
the first four with a "+N" tile that expands in place, and a note longer than
~200 characters clamps to three lines behind a More toggle.

Adding event types means widening a `CHECK`, which SQLite can't alter in place —
see [database.md](database.md) for the rebuild pattern.

## Photos

A person's photo wall merges two sources, in this order:

1. **Attached** (`family_tree_photos`) — curated by hand, ordered by `position`.
2. **Automatic** — everything the linked `gallery_person_id` face cluster found,
   deduped against the attached set.

Listings are always scoped to the gallery libraries **the viewer** can access, so
a member never learns a photo exists in a library they can't see, even when an
admin attached it.

The profile's Photos tab is a preview of twelve with "View all photos" leading to
`/family/people/:id/photos`. That page lives in the family tree rather than
linking into the gallery because this merged set has no equivalent gallery view.
Photos open in a lightbox **in place** on whichever family page you clicked from —
closing one returns you there instead of stranding you in the gallery.

**Portraits** are either an uploaded file (thumbnail store, bucket `familytree`)
or a chosen gallery item's cover. The two are mutually exclusive; picking one
clears the other — `PATCH …/persons/:id` with `portraitItemId` deletes the
uploaded file, and `PUT …/persons/:id/portrait` clears the item.

The camera button on the profile opens the same `FamilyPhotoPicker` in `single`
mode, with the same three sources as the photo wall: **Face matches**, **Browse
gallery**, and **Upload** — one click, or one file, sets the portrait. A portrait
upload goes into the tree's photo library like every other upload, becoming a
gallery item that is then set with `portraitItemId`; the raw
`PUT …/persons/:id/portrait` route stays for existing portraits and for API use,
but nothing in the UI writes to the thumbnail store any more. Uploading is gated
the same way everywhere: **no photo library nominated, no Upload tab.**

### Adding photos

`FamilyPhotoPicker` offers up to three tabs, and only the ones that can actually
do something:

1. **Face matches** — present when the person is linked to a gallery person.
   Lists everything the face scan matched (`GET /api/library/gallery/people/:id`,
   paged 120 at a time) and opens on this tab, since those are almost always the
   photos you came for. Attaching one *pins* it: the wall would show it anyway
   via the cluster, but a pinned photo survives the match later being corrected.
2. **Browse gallery** — folder navigation across every gallery the viewer can
   see; needs no configuration.
3. **Upload** — new files from the device. Shown **only** when an admin has
   nominated a destination in Settings → Photo library (stored in `app_settings`
   under `family_tree_settings`) *and* this viewer may upload to it. Files land
   in that library — filed into dated folders like any gallery upload — and are
   attached in the same step.

Uploading has to put the file somewhere, which is why it is the one gated tab.
It used to render regardless and explain itself; a tab that can only apologise
is worse than no tab. Admins still get a one-line hint under the tabs naming the
setting to change, since they are the only ones who can change it.

## Tags and branch permissions

Family members can carry **tags**, normally a branch surname. Tags reuse the
app-wide polymorphic tag system (`taggables` with
`entity_type = 'family_tree_person'`), so one tag can span books, photos, and
people at once — see [tags.md](tags.md).

Tags double as the **permission scope**. An `assignments` row with
`object_type = 'family_tree_tag'` and `object_id = tags.id` grants a user or
group edit rights over every person carrying that tag:

| Who | May do |
|---|---|
| Any signed-in user | View the whole tree; export GEDCOM |
| Branch editor (`contributor` on a tag) | Edit tagged people — details, portrait, events, photos, citations — and add relatives to them; new people they create are auto-tagged into the branch |
| Admin | Everything, plus deleting people, removing relationships, GEDCOM import, sources, and assigning tags |

**Assigning tags is admin-only on purpose.** If editors could tag, they could tag
any person into their own branch and grant themselves edit rights over them.
`deny` works as everywhere else and overrides grants, including group ones.

Resolution lives in `modules/familytree/access.ts` (`getEditableTags`,
`canEditPerson`, `canEditAnyPerson`, `decoratePersons`). A union is editable when
**at least one** involved person is — that's what makes marrying someone in from
another branch work. The client gates on server-sent `canEdit` per person and a
top-level `access { isAdmin, canAdd }`, never on the account role, except for the
handful of genuinely admin-only affordances.

Grants are managed in Settings → Security. Because grants hang off tag ids, the
admin tag manager's delete, merge, and prune are family-tag aware: merging moves
grants onto the survivor, deleting clears them, and prune no longer counts a
family-only tag as unused.

## GEDCOM

`gedcom.ts` imports and exports GEDCOM 5.5.1 — the format Ancestry, MyHeritage
and Gramps speak. The parser is deliberately tolerant: unreadable dates and
unmapped tags become **warnings**, not failures.

- **Import** (admin) takes `{ gedcom, mode: "add" | "replace" }` with a 32 MiB
  body limit. Replace wipes people *and* sources first. The v1 one-parent-union
  guard still applies: the first `FAM` wins and the rest become warnings.
- **Export** is open to every signed-in user — it's a read of what they can
  already see.
- Custom tags `_STATUS` (on `FAM`) and `_REL` (on `FAMC`) round-trip partner
  statuses and step relations. Typed events map to standard tags where one
  exists (`GRAD`, `RETI`, `BAPM`, `NATU`); travel and award have no standard tag,
  so they go out as `EVEN` + `TYPE` and come back typed.

## Settings

Admin-only, reached from **Settings** in the chart's rail or on the People page.
Four tabs: **Photo library** (upload destination), **Starting person** (who the
chart opens on), **Import / export** (GEDCOM), and **Security** (branch access).
The rail also links import and export directly — import opens `GedcomImportModal`
without the panel around it, and export is its own item because every signed-in
user may export while the panel is admin-only.

Both stored settings live in one `app_settings` blob under `family_tree_settings`
(`settings.ts`). `setFamilyTreeSettings` takes a **partial** and merges over what
is stored, and the PUT's fields are optional, so the modal can save one setting
without blanking the other — `null` clears a field, omitting it leaves it alone.
Both are resolved through the tables they point at (`getFamilyUploadLibrary`,
`getFamilyDefaultPerson`) rather than trusted as stored, so a deleted library or
person reads as unset instead of dangling.

## API

Reads are open to any signed-in user; writes are admin or branch-scoped per the
table above.

| Route | Notes |
|---|---|
| `GET /api/family-tree/tree` | Whole tree in one payload + `access` |
| `GET /api/family-tree/persons[/:id]` | List / profile, each carrying `tags` + `canEdit` |
| `GET /api/family-tree/persons/:id/photos` | Merged, viewer-scoped, paged |
| `POST/PATCH/DELETE /api/family-tree/persons[...]` | Person CRUD; `tags` and `galleryPersonId` are admin-only fields |
| `PUT/DELETE /api/family-tree/persons/:id/portrait` | Raw image body, not multipart |
| `POST/PATCH/DELETE /api/family-tree/unions[...]`, `.../children[...]` | Relationships |
| `POST/PATCH/DELETE /api/family-tree/persons/:id/events`, `/events/:id` | Timeline |
| `POST/DELETE /api/family-tree/events/:id/photos[/:itemId]` | Event photos |
| `GET/POST/PATCH/DELETE /api/family-tree/sources`, `/citations` | Bibliography (admin) |
| `GET /api/family-tree/tags` | Family tags with usage + editor counts |
| `GET/POST/DELETE /api/family-tree/tags/:tagId/editors[...]` | Branch access (admin) |
| `GET/PUT /api/family-tree/settings` | Upload library + starting person; PUT is admin |
| `GET /api/family-tree/export`, `POST /api/family-tree/import` | GEDCOM |

## Code map

```
apps/server/src/modules/familytree/
  persons.ts    person CRUD, profile assembly, partial dates
  relations.ts  unions, children, cycle guard
  events.ts     timeline events
  photos.ts     person + event photo attachments, viewer scoping
  sources.ts    sources and citations
  access.ts     tag-scoped edit rights
  settings.ts   upload destination + starting person (app_settings)
  gedcom.ts     import/export
  routes.ts     the HTTP surface and its guards

apps/web/src/features/familytree/   chart, people list, families list, profile, modals
apps/web/src/styles/family-tree.css
```

Routes: `/family`, `/family/tree/:id`, `/family/people`, `/family/families`,
`/family/people/:id`, `/family/people/:id/photos`.

`/family/families` (`FamilyFamiliesPage.tsx`) is a client-side rollup of
`/api/family-tree/persons`: one card per surname — the last word of the display
name, maiden names not folded in — ordered by size. Choosing one opens the chart
on that family's earliest-born member, which is the "focus on this branch" entry
point into a tree too big to scan person by person.

## Testing

`apps/server/test/family-tree*.test.ts` covers the model, GEDCOM round trips,
photos, and the permission matrix. The access tests drive the real routes with
`fastify.inject` and stubbed auth decorators.

> **Footgun:** a new `family_tree_*` table must be added to `resetDb()` in
> `test/helpers/seed.ts` or state leaks between tests. Don't set a JSON
> content-type on a body-less DELETE in `inject` — Fastify 400s before the guard
> runs.
