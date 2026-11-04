# Video — one page, rows you choose (proposal)

Status: proposal for review, 2026-11-03 (revised the same day: Movies and Shows pages
fold into one page). Nothing built.

Today video has three pages — Overview (`VideoHomePage.tsx`: banner, Continue watching,
newest films, newest shows), Movies and Shows (`VideoBrowsePage.tsx`, a grid each). This
plan makes video **one page with two views**, makes the rows a **layout** the household
sets and each person can adjust, and gives hand-picked rows a home in **Collections**.

## The page

Video does two jobs: *"what shall we watch tonight"* (rows, picked for you) and *"find
that one thing / show me everything"* (a grid you filter). Movies and Shows were only the
second job with one filter fixed, so they stop being pages.

```
┌ Video ─────────────────────────────────────── [ search… ] ┐
│ [All | Films | Shows]   Filter(2) · Sort · Rows|Grid │ Customize │
└────────────────────────────────────────────────────────────┘
```

- **Kind switch** — `All · Films · Shows`, always visible in the toolbar's `scope` slot:
  the filter people use most. It applies to both views.
- **Filter** — Library, Genre, Year, Watched (and Kind again inside, for phones).
  **Sort** — Recently added, Title, Year. **View** — Rows / Grid.
- **Rows view** (the default with nothing chosen): banner, then the person's rows. The
  kind switch narrows every row: on *Films*, "Recently added" shows films, Continue
  watching shows films, a shows-only row hides. That is a "films home" with no page.
- **Grid view**: every matching title, paged. Any Filter facet or a search switches to
  it on its own — picking "Comedy" means "show me the comedies", not "re-filter my rows".
- **View all** on a row opens the Grid with that row's filters. A row and the grid are
  the same saved query, so **Save as row** in the Grid is the natural way to make one.
- **The address carries the state**: `/video?kind=movies&genre=Comedy&view=grid`.
  `/video/movies` and `/video/shows` redirect there; title, set and player pages keep
  their addresses.
- **Nav**: Overview / Shows / Movies become a single **Video** entry (plus **My list**
  once R3 lands).
- **Film sets**: today a mode of Movies; becomes a Grid option ("Group films into
  sets") and a row type.
- **Mixed grid look**: one poster shape for both, a small "Show" badge on shows.

The temporary filter (in the address) and the saved layout (rows) never mix: filtering
does not change anyone's rows.

## Decisions proposed

1. **A row is a saved query, not a list of ids.** "Comedies in Kids", "Newest in
   Cartoons", "Continue watching" — each row stores *what to ask for*; the items come
   live from the engine. Only one row type holds hand-picked titles (point 3).
2. **Two layers: household, then me.** An admin sets the household layout (what
   everyone gets, and what a new member starts with). Anyone may then make it their
   own — hide, reorder, add rows — and "Reset to household" drops their copy. A person
   who never customised follows household changes automatically.
3. **Hand-picked rows are Collections** (as built, see R4). Video titles join home's existing Collections
   (the open "part A" in `docs/apps-platform-plan.md`). A Collection can mix films and
   shows (and books or photos — a video row shows only its video members). A row of type
   *Collection* shows it in its own order.
4. **No new "category" for video.** Genres are the automatic grouping, Collections the
   hand-made one, film sets stay automatic (`docs/video-sets-plan.md`).
5. **Home owns the layout; one endpoint resolves it.** The layout lives in home's DB.
   `GET /api/video/home?kind=` returns the rows already filled, so the web page and the
   TV app render the same thing and neither knows the row rules.
6. **Access is never widened by a row.** Every row is resolved as the viewer, through the
   gateway's library list. A row someone cannot see into is empty for them, and empty
   rows are not shown.

## Row types

| Type | Settings | Source |
|---|---|---|
| Continue watching | — | engine progress (per person) |
| Recently added | kind: films / shows / both; libraries (optional) | engine `/titles?sort=added` |
| Library | one library; kind; sort (added, title, year, random) | engine `library=` |
| Genre | genre; kind; libraries (optional); sort | engine `genre=` |
| Collection | one Collection | home `collection_items`, art from engine |
| My list | — | a personal Collection every person gets (watch later) |
| Film sets | libraries (optional) | engine sets |
| Not watched yet *(later)* | kind; libraries; genre | needs an engine `unwatched=1` filter |

Every row has an optional **title** (default generated, e.g. "Comedy · Films", through
`t()`) and a **shape** (poster / wide). Limits: 15 rows, 30 titles per row.

## Data

```sql
-- One per household ('') plus one per person who customised.
CREATE TABLE video_home_layouts (
  user_id    TEXT PRIMARY KEY,          -- '' for the household layout
  rows       TEXT NOT NULL,             -- JSON array of row definitions
  updated_at TEXT NOT NULL
);
```

A row definition: `{ id, type, title?, kind?, libraries?, genre?, sort?, collectionId?,
shape?, hidden? }` — the same filter fields the Grid's address uses. Validated with zod on
save; unknown types are skipped when resolving, so an old TV app never breaks. With no
household layout the default is today's page.

**Engine changes:**
- `GET /titles` — films and shows in one paged list (a `UNION` over both tables with
  the same `library` / `genre` / `q` / `sort` / `year` filters), each item carrying its
  `kind`. Needed for the mixed Grid and for "both" rows; paging two lists in home and
  merging them would break past the first page.
- `GET /items?ids=…` — batch lookup applying the viewer's libraries, for Collections.

Collections for video: `entity_type` `video_movie` / `video_show`, `entity_id` the
engine's id. Their hydrator is async (the batch lookup) where books/photos are sync reads
— the one real change in the collections module.

## Screens

- **Video page** as above. *Customize* opens a `shared/Modal` panel: the row list (drag
  to reorder, eye to hide, pencil to edit, Remove), *Add row* (type → settings), *Reset
  to household*. Admins see **Just me / Everyone** at the top; the same editor edits
  either layer. No control-panel page (the six-group budget stays); a search entry in
  `features/control/search-index.ts` points to it.
- **Save as row** in the Grid's toolbar: names the current filters and adds them as a
  row (to *Just me*, or *Everyone* for an admin).
- **Title page and posters**: *Add to collection* and a *My list* toggle.
- **TV app**: keeps its tabs for now; later Home (from `/api/video/home`) + Browse +
  Search. A remote does better with a few big tabs than a filter menu, so the TV need not
  copy the web page exactly.
- Mock (private design canvas, 2026-11-03): https://claude.ai/artifact/Php39AGByJxZg3B2a5SAQG
  — the page (kind switch, Filter, Rows/Grid, View all, Save as row) and the Customize
  dialog (Just me / Everyone, reorder, hide, Add row, Reset to household).

## Phases

| Phase | What | Where |
|---|---|---|
| **R1** | One page: kind switch, Filter/Sort/View, Grid over engine `/titles`, redirects from Movies/Shows, single nav entry. *Built 2026-11-03, not yet released: engine `added_at` + `/titles` + `/genres` (next engine 0.19.0); Filter has Libraries and Genres — Year and Watched wait for the engine to filter on them.* | home + engine |
| **R2** | Row model, `/api/video/home`, household layout, row types Continue / Recently added / Library / Genre, Customize editor, Save as row. *Built 2026-11-03. Recently added, Library and Genre are one row type, `titles` (kind, libraries, genres, sort), named from what it asks for; `/api/video/home` returns the rows' questions, not their titles — each screen asks the engine per row through the gateway, as the viewer, so access stays the gateway's (point 5 above, changed).* | home |
| **R3** | Personal layouts, *Just me / Everyone*, Reset to household. *Built 2026-11-03: anyone may customise their own rows (`video_home_user_layouts`); only admins edit Everyone's. Save as row adds to your own rows, or (an admin with none) to everyone's.* | home |
| **R4** | Video in Collections, Collection row, My list. *Built 2026-11-03, differently from above: no async hydrator and no engine change. Home keeps a copy of what a card needs (`video_refs`: title, year, poster, library), taken from the engine when a title is added anywhere, and answers access from the title's library, so Collections' hydrator stays synchronous. My list is its own table (`video_my_list`), not a Collection, so it doesn't crowd the Collections page. A Collection row shows the saver's own collection; one an admin puts on everyone's page is readable by everyone, each seeing only their libraries' titles.* | home |
| **R5** | TV app Home from `/api/video/home`. *Built 2026-11-03 in TV 0.6.0: Home draws the person's rows in order (unknown types skipped); a home before 4.63 gets the old Home.* | isputnik.tv |
| later | Not watched yet, Film sets row, random sort, banner source | engine + home |

## Open questions

- Can every member customise their own rows, or only admins for everyone?
- Can a member put a Collection row on the household layout, or is that admin-only?
- Should the TV app get its own layout ("TV only" rows), or always the same as the web?
