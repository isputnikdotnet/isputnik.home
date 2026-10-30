# Film sets — plan

Part B of "collections for video" (2026-10-29). Part A — putting video titles into
home's own Collections — is the open point in `docs/apps-platform-plan.md` and comes
after this. Background: `docs/video-architecture.md`.

Status: 2026-10-29. Owner accepted the four decisions as recommended. F1 (engine
`src/sets.ts`) and F2 (home) built the same day, uncommitted at the time.

## In one sentence

**Films that belong together — *The Lord of the Rings*, *Toy Story 1–4*, a family's
"Summer at the dacha 2019–2024" — are grouped into a set automatically, shown in
order, and watched in order.**

## What it is, and what it is not

- **A set is found, not made.** It comes from the files' `.nfo` (`<set>`) or from
  TMDB (`belongs_to_collection`). Nobody builds one by hand in the video pages.
- **A hand-made list is a Collection** (home's existing feature, part A). The two
  never merge: a set is a fact about the films, a Collection is a person's choice.
- **Films only.** TMDB has no collections for shows, and a show is already its own
  grouping (seasons).
- **A film is in at most one set.** TMDB and Kodi both work this way.

## Decisions to make (owner)

1. **The name in the UI.** "Collections" is taken by home's own feature and would
   mean two things on one site. Recommendation: **Sets** in English (Kodi's word,
   "Movie sets"), **Циклы** in Russian («цикл фильмов»). "Series" is out — it means
   TV in Stremio and on our own Shows page.
2. **How many films make a set.** Recommendation: a set shows as a set only when the
   person can see **two or more** of its films. A lone film still says "Part of
   *The Matrix* set" on its page, but no one-card set clutters the Sets view.
3. **Films we don't have.** TMDB lists every part (5 *Mission: Impossible* films;
   the library has 3). Recommendation: **don't show missing parts** — this is a
   family library, not a shop, and greyed-out posters read like a to-buy list. The
   set page says "3 films" and nothing more. (Easy to add later as an admin-only
   hint if wanted.)
4. **Grouping in the main grid.** Jellyfin can fold a set's films into one card in
   the Movies grid. Recommendation: **no, not in V1** — the grid keeps every film
   (search and A–Z must still find *The Two Towers*), and Sets is its own view.

## Where the facts come from

In this order, like every other fact the engine keeps (the family's own files win):

1. **`.nfo` beside the film** — Kodi writes `<set>` in two shapes, both read:
   `<set>The Matrix Collection</set>` and
   `<set><name>…</name><overview>…</overview></set>`. Some writers add
   `<tmdbcollectionid>` / `<uniqueid type="tmdbcol">`; when present it ties the
   `.nfo` set to TMDB's, so its art and order come along.
2. **TMDB** — the film's details (`/movie/{id}`, already fetched for every matched
   film) carry `belongs_to_collection: { id, name, poster_path, backdrop_path }`.
   **Membership costs no extra request.** One `/collection/{id}` call per set adds
   the overview and each part's release date (the order), in the library's
   language, through the same queue and politeness as the rest of `metadata.ts`.
3. **Fix match carries it.** Re-matching a film to another TMDB id moves it to that
   id's set (or out of any); a `.nfo` set still wins over it.

A family set from `.nfo` alone (no TMDB id) is keyed by its name, case-folded and
trimmed, across all movie libraries.

## Engine (isputnik.video)

### Data

As built: the `.nfo`'s set goes on `movies` (`set_name`, `set_overview`,
`set_tmdb_id`, written by the scan) and TMDB's on `metadata` (`set_tmdb_id`,
`set_name`, `set_checked`); `db.ts` adds those columns to an older file
(`ADDED_COLUMNS`). From them, two tables in `schema.sql`:

```sql
-- A set of films: TMDB's collection, or a name the .nfo files share.
CREATE TABLE IF NOT EXISTS sets (
  id             TEXT PRIMARY KEY,
  tmdb_id        TEXT UNIQUE,           -- TMDB collection id; NULL for an .nfo-only set
  name_key       TEXT UNIQUE,           -- case-folded .nfo name; NULL for a TMDB set
  name           TEXT NOT NULL,
  sort_name      TEXT NOT NULL,
  overview       TEXT,
  poster         TEXT,                  -- 'cache:<file>' like metadata.poster
  backdrop       TEXT,
  poster_path    TEXT,
  backdrop_path  TEXT,
  checked_at     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Which set each film is in. Kept apart from `movies` (rebuilt by scans) and
-- from `metadata` (TMDB's), because either source may put it there.
CREATE TABLE IF NOT EXISTS set_members (
  movie_id   TEXT PRIMARY KEY,          -- one set per film
  set_id     TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('nfo', 'tmdb')),
  released   TEXT                       -- the part's release date, for order
);
CREATE INDEX IF NOT EXISTS set_members_set ON set_members (set_id);
```

- **Order** inside a set: `released`, else the film's year, then title. No
  hand ordering in V1.
- **Sweep**: the daily sweep drops `set_members` rows whose film is gone and `sets`
  rows with no members. Detach-not-delete already keeps a detached library's films
  for 30 days, so their set membership survives a brief unmount.
- **Existing installs**: films matched before this release have `set_checked = 0`,
  which makes them due on the next metadata pass (one `/movie/{id}` each, at the
  pass's usual pace). No job of its own: the pass follows every scan, and home
  asks for a scan on start and every 6 hours.
- **Rebuilt, not maintained**: `rebuildSets()` works every film's set out again
  after each scan, each metadata pass and the daily sweep; TMDB's words, art and
  parts stay on the `sets` row. An `.nfo` set without a TMDB id that is named
  like a TMDB set is merged into it.
- **Backups**: the tables are in the DB snapshot like everything else.

### API (all under `requireIdentity`, filtered by `X-Isputnik-Libraries`)

| Call | Returns |
|---|---|
| `GET /video/api/sets?library&q&page&pageSize` | sets with ≥2 films this person can see: id, name, poster (own, else the first film's), film count, how many watched |
| `GET /video/api/sets/:id` | the set's name, overview, art, and the films this person can see, in order, each with progress; `next` = first unwatched (or in progress) film |
| `GET /video/api/movies/:id` | gains `set: { id, name, films: [{ id, title, year, poster }] }` (siblings, in order) or `null` |
| `GET /video/api/play/:id` | for a film, `next` is the next film of its set (`season`/`episode` null) |

Counts are always "films **you** can see": a set split across *Kids films* and
*Films* is one set, but a member who sees only *Kids films* sees only its part. A
set with fewer than two visible films is left out of `/sets` and still returned on
the film (decision 2).

Art: `/video/api/art/:setId/poster|backdrop`, the same handler as titles.

## Home (isputnik.home)

No schema change — the engine owns the facts.

- **Movies page → View: Films | Sets.** (Shown once the engine reports a set.) A View control in the toolbar's tools slot
  (Filter · Sort · **View**), per `docs/UI-CONVENTIONS.md`; the choice lives in the
  address (`/movies?view=sets`) so a link opens on it. Sets view: poster cards with
  the name and "3 films" (`t(key, { count })`), sorted by name; search narrows by
  set name. The library facet applies as it does to films. The View control is
  hidden when there are no sets.
- **Set page `/movies/sets/:id`.** Backdrop + overview like a title page; the films
  in order as a row of cards, each with its progress bar; one primary button:
  **Play** *The Matrix* (nothing watched) / **Resume** *The Matrix Reloaded* /
  **Play** *The Matrix Revolutions* (the next one) — the engine's `next`. Two path
  segments, so no clash with `/movies/:id`.
- **Title page strip.** A film in a set shows "Part of *The Matrix* set" with its
  siblings' posters under the details, current one marked; the name links to the
  set page.
- **Player: next film.** When a film in a set ends, the 10-second card that shows
  the next episode for a show offers the next film in the set instead. Same card,
  same "Cancel".
- **Continue watching** stays per title; a set is not a row there.
- i18n keys under `video.sets.*` in `en` + `ru`; the user guide on video
  (`docs/users/…`) gets a "Sets" section and a shot.

## Stremio (later, S-phase)

Stremio has no grouping of its own. The cleanest fit, to be tried before it is
promised: a catalog per movie library named "<Library> — Sets", whose items are
metas of type `movie` with a `videos` list (the films, in order) — Stremio then
shows the set like a series with its films as "episodes", and each film's stream
is the existing one. If the TV client renders that poorly, fall back to nothing:
the films stay in the library catalog as today.

## Admin (later)

Not in V1, added only if the automatic sets turn out wrong in practice:

- On a film: **Set** → "Not in a set" or another existing set, locked like Fix match.
- On a set: rename (locked against TMDB).

Creating sets by hand stays out on purpose — that is a Collection (part A).

## Phases

| Phase | Where | What |
|---|---|---|
| **F1** | engine | `sets` + `set_members`; `.nfo` `<set>` read in `nfo.ts`/`scan.ts`; `belongs_to_collection` kept from `/movie/{id}`; `/collection/{id}` for overview, art and order; sweep; one-time "Find sets" pass; the four API calls; tests (both `.nfo` shapes, nfo-over-TMDB, cross-library visibility, ≥2 rule) |
| **F2** | home | View: Films \| Sets; set page; title page strip; next-film card in the player; i18n; guide + shot |
| **F3** | engine | Stremio sets catalog (spike first) |
| **F4** | both | admin overrides — only if needed |

F1 and F2 release together (engine minor + home minor); F1 alone changes nothing a
person sees except a new background task.
