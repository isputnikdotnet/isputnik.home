# Photos on the TV

Status: **P1 built** 2026-11-09 (home: `tv_photo_picks`, `modules/library/gallery/tv-picks.ts`,
the On TV panel on the Photos page's Albums and Slideshows views), not committed. P2 and P3
(the TV app) next. Open questions 1–3 were left at the proposals below: new picks default
to "Everyone but restricted profiles"; the website's movie rule is unchanged.

Mock-up: the "Photos on the TV" section of
https://claude.ai/artifact/MUwo1cYaW2FXE8ZBA7BAwr (TV › Photos, TV › playing an album,
Website › Photos › On TV). Replaces the Photos (T5) section of `docs/tv-app-plan.md`.

## What the owner asked for

Not the whole gallery on the TV. A **controlled view**, because a TV may be used by more
people than the photos' owners: only **slideshows and albums**, and only the ones an
**admin** has put on the TV. No folders, timeline, people, map or search.

## Decisions

1. **The TV shows only what's on the "On TV" list.** An admin builds the list on the
   website's Photos page (**On TV**, admins only): slideshows and albums, in the order the TV
   shows them. Nothing else from the gallery reaches the TV, and nothing new appears on its own.
2. **Each pick says which profiles see it** (`docs/tv-profiles-plan.md`): everyone, or
   chosen ones. That is how Kids gets "Grandma's 80th birthday" and nothing else. The choices:
   - **Everyone but restricted profiles** (the default for a new pick),
   - **Everyone**,
   - **Only…**: tick profiles, and "Without a profile" for someone watching as themselves.
3. **A person's own access still applies on top.** The list only ever narrows: a photo the
   person signed in can't open on the website never shows on the TV, even inside a picked
   album or slideshow. This is how albums and slideshows already work for every viewer
   (`getAlbumItems` / `getSlideshowItems` filter by the viewer's gallery libraries).
4. **A rendered slideshow movie plays only if the viewer may see every photo in it.** Today
   the movie route lets anyone who sees *one* of a slideshow's photos watch the whole movie,
   with every photo baked in. On the TV that would break decision 3, so the TV is told
   `movie: true` only when the viewer's visible count equals the slideshow's whole count.
   Otherwise it plays the slideshow **live**: the viewer's own photos, with the slideshow's
   timing, transitions and music. (The website's rule is a separate question, open question 3.)
5. **No picks for the profile watching: no Photos tab.** The TV asks once per profile;
   an empty answer hides the section, as Games hides when the person may not play.
6. **The household's Photos section must be on** (Settings › Sections) and the person must
   have gallery access, as on the website.
7. **Admins only**, from a browser, and not from inside a locked profile, as for profiles.

## Data (home)

A new table in `schema.sql` (a new table needs no migration):

```sql
-- The household's photos on the TV (docs/tv-photos-plan.md): slideshows and albums an
-- admin picked, in order, each with the profiles that see it. Exactly one of
-- slideshow_id / album_id is set; a deleted slideshow or album leaves the list with it.
-- audience: 'everyone', 'grownups' (everyone but restricted profiles), or 'chosen'
-- with profile_ids (JSON array; '' stands for "without a profile").
CREATE TABLE IF NOT EXISTS tv_photo_picks (
  id           TEXT PRIMARY KEY,
  slideshow_id TEXT REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
  album_id     TEXT REFERENCES gallery_albums(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  audience     TEXT NOT NULL DEFAULT 'grownups' CHECK (audience IN ('everyone', 'grownups', 'chosen')),
  profile_ids  TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((slideshow_id IS NULL) <> (album_id IS NULL))
);
```

A deleted profile drops out of `profile_ids` when read (an id that no longer exists matches
no session). Backups carry the table like any other.

## API (home, `modules/library/gallery/tv-picks.ts`)

| Route | Who | Does |
|---|---|---|
| `GET /api/library/gallery/tv/picks` | admin | the list as the website panel edits it: every pick, with name, kind, cover, count, audience |
| `POST /api/library/gallery/tv/picks` | admin, browser, not locked | `{ slideshowId \| albumId, audience, profileIds? }` adds one at the end |
| `PATCH /api/library/gallery/tv/picks/:id` | same | changes the audience |
| `DELETE /api/library/gallery/tv/picks/:id` | same | takes it off the TV (the slideshow or album itself is untouched) |
| `PUT /api/library/gallery/tv/picks/order` | same | `{ ids }` |
| `GET /api/library/gallery/tv` | anyone signed in | **what this session's TV shows**: the picks whose audience includes the profile worn (or "without a profile"), each resolved as this viewer: name, kind, cover, the count they may see, minutes, music, and `movie` per decision 4. A pick the viewer sees nothing of is left out |

The TV then reads the photos through the routes it would anyway, filtered per viewer:
`/albums/:id` and `/slideshows/:id` (pages of assets with `previewUrl`, 1600 px, fine for a
1080p screen), `/assets/:id/file` for a video in an album, `/slideshows/:id/movie` for a
movie, `/music/:id/stream` for a slideshow's music. **A TV may only open what its list
gives it**: those routes, from a device session, refuse an album or slideshow that isn't
on this session's TV list. That keeps a TV from wandering the gallery by address.

## Website

- **Photos page toolbar: On TV** (admins). It opens a `shared/Modal` panel, "Photos on TV":
  the list in TV order, each line with its cover, name, kind and count, a **Profiles** choice
  (the three of decision 2), Move up / Move down, and **Remove** (no confirmation: nothing
  is lost). Below the list: **+ Add slideshow** and **+ Add album** open a picker of the
  slideshows or albums not on the list yet. All strings through `t()`, `en` and `ru`.
- **On a slideshow's or album's page** (admins): a small "On TV" chip when it's on the
  list, linking to the panel. Later, if wanted: "Show on TV" in its ⋮ menu.
- **Guide:** a "Photos on the TV" section in `docs/users/tv-app.md`.

## TV app (`isputnik.tv`, a new `feature-photos` module)

- **Photos tab** (`PhotosFeature`, replacing the "on the way" page): asks
  `/api/library/gallery/tv`. Empty → the tab isn't in the menu. Otherwise the banner (the
  first pick: SLIDESHOW or ALBUM heading, title, "142 photos · 9 min · with music", Play),
  then a **Slideshows** row and an **Albums** row, in the list's order.
- **A slideshow with `movie`:** plays in the existing player (Media3, the `player` module) as
  a film: seek, pause, Back.
- **Everything else plays live** in a photo viewer:
  - the photo fitted to the screen, black around it;
  - every few seconds: a slideshow keeps its own per-slide time and transition; an album
    uses the TV's interval (default 6 s);
  - a slideshow's music plays under it, looping;
  - a video in an album plays in place (the `?web=1` copy where one exists), then the show
    goes on;
  - the caption (album, date, place, people) fades after 4 s, and any key brings it back;
  - Left/Right step by hand, OK pauses, Back leaves;
  - the next photo is loaded ahead, so a slide never waits on the network.
- Strings in `en` and `ru`.

## Phases

| Phase | What | Done when |
|---|---|---|
| **P1** | Home: `tv_photo_picks`, the routes, the device-session fence, the website's On TV panel | An admin puts two slideshows and an album on the TV with different audiences, and `GET /api/library/gallery/tv` answers each profile what the plan says |
| **P2** | TV: the Photos tab and the live viewer (albums, and slideshows without a movie), no music yet | The family watches an album on the Fire TV |
| **P3** | TV: movies through the player, slideshow music, videos in place, captions with people | A picked slideshow plays as its movie, or live with music, on the TV |

Tests: home (Vitest) for every audience and profile combination, the "sees every photo"
movie rule, the fence on device sessions, and admin-only edits; TV unit tests for the
viewer's timing and stepping; the owner's check on the Fire TV.

## Open questions

1. **The default audience for a new pick:** "Everyone but restricted profiles" (proposed),
   or "Everyone"?
2. **The album interval:** fixed at 6 s, or a TV setting (in the settings menu)?
3. **The website's movie rule:** should the website, too, stop offering a slideshow's movie
   to someone who can't see all its photos? It's the same leak, outside the TV.
