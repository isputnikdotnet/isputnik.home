# Video: cast and crew (plan)

Status: steps 1 (engine) and 2 (home) built 2026-11-04, not released. Step 3 (TV
app) to come.

Films and shows had no people: the engine ignored the `.nfo`'s `<actor>` and
didn't ask TMDB for credits. A family wants to see who is in a film, and to go
from an actor to everything of theirs in the library, the way a book's author
page works.

## Where people come from (engine, `src/credits.ts`)

- **The `.nfo` first**, as with everything else: `<actor>` (name, `<role>`,
  `<order>`, `<tmdbid>`, a `<thumb>` that is one of TMDB's pictures), `<director>`
  and `<credits>` (writers). Kept raw on the title (`movies/shows.nfo_people`).
- **TMDB's credits** where the `.nfo` names none, cast and crew each on its own.
  They come in the same request as the title's details (`append_to_response`:
  `credits` for a film, `aggregate_credits` for a show, whose regulars across all
  seasons are what a family means). Kept raw on `metadata.people`.
  - Cast: the first 20 billed.
  - Crew: director, writer (Screenplay, Writer, Story, Novel), composer
    (Original Music Composer, Music), and a show's creators.
- `people` and `credits` are **worked out again** from those after every scan,
  every title's metadata, and the daily sweep, the way sets are, so they never
  drift. Titles matched before 0.26.0 are asked of TMDB once more for their
  credits (`metadata.people_checked`).

## One person across the library

- Id `t<tmdbId>` where TMDB's id is known; else `n<hash of the name>`. Ids are
  made, not random, so a person's address stays through every rebuild.
- An `.nfo` name without an id becomes the TMDB person of that name in the same
  title, else the one TMDB person of that name anywhere in the library (none, or
  two of the same name: a person of its own).
- People with no title left are let go, with their kept picture.

## Pictures

TMDB's `profile_path`, fetched at w185 the **first time anyone looks** and then
kept in the art folder (a library's cast runs to thousands of people, most never
looked at). The address carries a version of the picture.

## API (engine)

- `GET /api/movies/:id`, `GET /api/shows/:id`: `cast` (billing order) and `crew`,
  each `{ id, name, role, photo }`. The role is the character, or the job
  (`director`, `writer`, `composer`, `creator`).
- `GET /api/people/:id`: name, photo, TMDB id, and every title of theirs this
  person may see (newest first), with the characters played and jobs done.
- `GET /api/people?q=&limit=`: people whose name has the words (case, ё and
  punctuation aside), with how many titles; only those in a title this person
  may see.
- `GET /api/people/:id/photo`: the picture, fetched once.

A person is only ever shown through titles in libraries the person asking may
see: someone in nothing they may see is "not found".

## Steps

1. **Engine**: built (0.26.0, unreleased).
2. **Home** (built: `VideoPeople.tsx`, `VideoPersonPage.tsx` at `/videos/people/:id`):
   - Cast row on the title page: round photos, name, character, scrolling
     sideways. Crew line under it: Director · Writer · Music.
   - Person page (`/people/:id` in Video): photo, name, their films and shows
     with the role in each.
   - People in Video's search.
3. **TV app**: a Cast row on its title screen. A separate repo and release.

## Left out for now

- Editing cast by hand: the `.nfo` overrides it. An Edit dialog tab can come later.
- A person's biography and dates (TMDB's person endpoint): a step 2 extra if
  wanted.
- Linking an actor to the family tree.
- Stremio's `cast`/`director` fields in its meta: small, could ride along with
  step 2.
