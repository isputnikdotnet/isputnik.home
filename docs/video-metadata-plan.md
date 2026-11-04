# Video metadata: genres and title editing

Books let an admin edit a title, its tags and its category, and map scanned tags
onto categories. Video had only Fix match and the backdrop picker. This plan brings
video up to the same level, genres first.

The engine owns the catalog (`docs/video-architecture.md`), so every edit lives
there and reaches every client at once: home's Video pages, the TV app, Stremio.

## G — Genres (built 2026-11-04, engine + home)

Video genres used to be the raw words in the .nfo files or from TMDB, in each
library's language: "Comedy" and "Комедия" as two genres, TMDB's "Sci-Fi & Fantasy",
"TV Movie" in the filters.

- **Engine** (`src/genres.ts`): tables `genres`, `genre_keywords` and `genre_hidden`.
  A raw word becomes nothing if it is hidden, its genre(s) if it is a keyword (one
  word may lead to several), the genre of the same name, or else itself, listed as
  *unsorted*, so nothing disappears before the admin has looked. Keys ignore case,
  spacing and ё.
- One resolver, `resolveGenres()`, which SQL reaches as `genre_names()`. Cards,
  filters, the Genre facet and Stremio all go through it, so a change needs no
  rescan. The map is cached per connection and reloaded after every change and
  after a restore, because the SQL function can't query from inside another query.
- A filter asking for an old word also finds what that word now maps to (`widenGenres`),
  so Video home rows saved with "Sci-Fi" keep working after it maps to "Фантастика".
- Rename keeps the old name as a keyword. Merge moves the keywords and turns the
  merged genre's name into a keyword. Delete hides the genre's name and keywords,
  so titles lose it and the words don't come back as unsorted.
- **Start from TMDB's genres**: TMDB's film and TV genres, named in English or
  Russian, with the other language's names and common .nfo spellings as keywords.
  Double TV genres are split; "TV Movie" is hidden. Only works on an empty list.
- **Home**: Control panel › Library › **Video genres** (`GenresSection.tsx`). It
  shows the genre list with title counts and keywords, unsorted words (add to a
  genre, create a genre, hide), and hidden words (show again). The edit dialog
  covers rename, keywords, merge and delete.

## E — Edit a title (built 2026-11-04, engine + home)

- **Engine** (`src/edits.ts`, table `title_edits`): each field (title, original
  title, sort title, year, plot, genres) is either edited or null, meaning
  automatic. `auto_*` keep what the scan last found. The edited value is written
  into the shows/movies row itself, so search, sort, sets, Stremio and the TV app
  read it without any change of their own. A scan writes what it finds, then
  `afterScan()` takes that as the new automatic values and puts the edits back
  over it. A title with no edit left loses its `title_edits` row.
- Routes: `GET/PUT /api/admin/titles/:id/edit`. In the PUT body, a field set to
  null goes back to automatic and a field left out stays as it is. Empty genres
  mean automatic, because an empty list would only let TMDB's back in.
- **Home** (`features/video/EditTitleModal.tsx`): **Edit** on the title page,
  admins only. The **Details** tab shows each field with what was found; an empty
  field is automatic, and a field with an edit has "Use what was found". The
  **Genres** tab shows the genre list as chips: the first pick starts from the
  genres found, and "Use the genres found" undoes it.

## L — Lookup and Pictures (built 2026-11-04, engine + home)

Fix match and its backdrop picker became two tabs of the Edit dialog;
`FixMatchModal` is gone.

- **Lookup** (`TitleLookup.tsx`): the same TMDB search. Picking a result loads
  `GET /api/admin/metadata/details?kind&id&language` (the engine's `tmdb.details`,
  with genres mapped through the genre list) and shows it beside the title, field
  by field. A field is ticked to begin with only when the title has nothing there.
  **Use this title** puts the ticked fields into Details and Genres and holds the
  match. **Save** then sends the match (`PUT /admin/metadata/items/:id`) and the
  edits together, so nothing is saved until Save.
- **Pictures** (`TitlePictures.tsx`): poster and backdrop, each saved at once.
  - The engine has new `metadata.poster_choice` and `metadata.poster_upload`
    columns, and routes `GET …/items/:id/posters`, `PUT …/poster`, and
    `PUT/DELETE …/poster/upload` (a JPEG, PNG or WebP body, up to 15 MB).
  - An uploaded poster wins over a poster.jpg beside the files and over TMDB's.
    A chosen TMDB poster wins over TMDB's default, and a new match clears the
    choice. Uploads are kept in the art folder, which isn't in the backup, so a
    restore onto a new box loses them.

## S — Sets by hand, better matching, a miniseries' parts (built 2026-11-04, engine 0.24.0 + home 4.68.0)

- **Set tab** (films): `title_edits` gained `set_name`, `set_order` and `no_set`, plus
  `auto_set_*`. A set named by hand is written into `movies.set_name` with
  `set_tmdb_id` cleared, so it is a set by name and joins TMDB's of that name.
  `no_set` makes `rebuildSets` skip the film, TMDB's collection too. Saving a set
  rebuilds the sets at once. Edits saved under 0.23.0 get `auto_set_*` filled from
  the film on upgrade (`db.ts`). `GET /admin/sets/names` gives the choices.
- **Matching** weighs every TMDB answer instead of taking the first. A result with
  the same name (case, ё, apostrophes and punctuation aside; `nameKey`) within a
  year is taken at once. Otherwise the same name with the year further off,
  then another name within a year, then (no year at all) the first. A film in
  several files asks TMDB's TV shows first.
- **A miniseries' parts**: a film in parts matched to a TV show stores season 1's
  episodes under `<movieId>-part<n>` metadata keys (part 1's id is the film's own).
  The film page shows their names, stills and descriptions. They are dropped when
  the film is matched to a film again.

## Next

1. Uploaded posters in the engine's backups (the art folder is left out today).
2. Episode title and plot editing only if a real library needs it: Plex and
   Jellyfin both offer it, but it is rarely used.
