# Skip intro and credits — plan

For the video engine (isputnik.video) and home's player. Background:
`docs/video-architecture.md`; sits beside `docs/video-sets-plan.md`.

Status: owner accepted the four decisions as recommended. K1 built 2026-10-30
(engine `src/markers.ts`, home's player), uncommitted at the time. K2 and K3 open.

## In one sentence

**While a show's intro plays the player offers Skip intro, and when the credits
start it offers the next episode — from what the files already say first, from
marks an admin sets second, and (maybe, later) from what the engine finds itself.**

## What there is today

- The end card ("Next episode in 10 seconds") appears only when the file has
  **ended** — after the credits.
- A title counts as watched at 92 % (`WATCHED_FRACTION`), so unwatched credits
  don't keep it on Continue watching.
- Seeking by hand. Nothing knows where an intro or the credits are.

## Decisions to make (owner)

1. **A button, not an automatic jump.** Recommendation: **Skip intro** is a button
   shown while the intro plays (as Netflix and Jellyfin do); it never jumps by
   itself. A per-person "Skip intros by themselves" setting can come later, in
   Profile, if anyone asks.
2. **What the credits do.** Recommendation: when the credits start, the end card
   comes up **then**, with its countdown, if there is something next (the next
   episode, or the next film of a set). A film with nothing after it shows no card —
   some credits are worth watching — but counts as **watched from where its credits
   start** instead of at 92 %.
3. **Who marks by hand.** Recommendation: **admins only**. A mark is a shared fact
   about a file, like Fix match, not anyone's preference.
4. **Season or episode.** Intros often sit at the same time in every episode of a
   season, but a cold open moves them. Recommendation: a mark is made **for the
   whole season** by default, with "only this episode" as the other choice; an
   episode's own mark wins over the season's.

## Where the times come from

In this order — the family's own files first, as everywhere in the engine:

1. **Marked by hand** (an admin, phase K2). Always wins.
2. **An `.edl` file beside the video** — Kodi's edit list (`Episode.edl`: lines of
   `start end action`). Intro-skipper tools for Kodi and Jellyfin can write them.
   Read as intro when it starts in the first third, credits when it ends at the
   file's end.
3. **Chapters inside the file.** Many MKVs (Blu-ray rips, anime above all) name
   their chapters. A chapter is an intro or credits by its title, in English and
   Russian: *Intro, Opening, OP, Opening Credits, Вступление, Заставка, Начальные
   титры* / *Credits, End Credits, Ending, ED, Outro, Титры, Финальные титры*.
   Nothing is guessed from an unnamed "Chapter 3".
4. **Found by the engine** (phase K3, only if 1–3 leave too much uncovered).

## As built in K1

- Nothing is stored: `.edl` and chapters are worked out when `/play` and each
  progress save ask (`findMarkers`), so the `markers` table below arrives with K2.
- A chapter's time has the file's start taken off, but not a start below 0: that is
  the sound's encoder delay (-0.021 s on an AAC track), not a late start.
- Named chapters count by position too: an intro in the first half of the file, the
  credits in the second. A "Credits" chapter a few minutes in is the opening's.
- **Full screen became part of this.** A `<video>` in the browser's own full screen
  hides everything drawn over it, so Skip intro and the end card would never show
  where people actually watch. The page itself goes full screen now
  (`controlsList="nofullscreen"`, a button, F, double click), which also holds across
  the next episode. Firefox ignores `controlsList`; iPhones have only their own.
- Pausing while the card counts down cancels it: nothing moves on from a paused film.

## Engine (isputnik.video)

### Data

- **Chapters** come from the ffprobe run that already happens on a title's first
  play (`media-probe.ts`): add `-show_chapters` and keep them in `media_probe.info`
  with the streams. A file replaced on disk is probed again, as now.
- **Markers**, one table:

```sql
-- Where an episode's or film's intro and credits are (seconds on its own clock).
-- One row per item and kind; an admin's season mark is kept on the show.
CREATE TABLE IF NOT EXISTS markers (
  item_id   TEXT NOT NULL,              -- an episode or movie; or a show, for a season mark
  season    INTEGER NOT NULL DEFAULT -1, -- set for a season mark; -1 otherwise (a NULL
                                         -- in a SQLite key would let duplicates in)
  kind      TEXT NOT NULL CHECK (kind IN ('intro', 'credits')),
  start_s   REAL NOT NULL,
  end_s     REAL,                       -- NULL for credits: to the end
  source    TEXT NOT NULL CHECK (source IN ('manual', 'edl', 'chapter', 'detected')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (item_id, season, kind)
);
```

  Only `manual` and `detected` rows are stored; `.edl` and chapters are read when
  asked (cheap, and never stale). The daily sweep drops rows whose item is gone.

### API

| Call | What |
|---|---|
| `GET /video/api/play/:id` | gains `markers: { intro: { start, end } \| null, credits: { start } \| null, source }` — the winning one of each kind |
| `PUT /video/api/admin/markers/:id` | an admin's mark: `{ kind, start, end, scope: "episode" \| "season" }`; `null` times remove it (back to the file's own) |

The times are on the title's own clock, the one `/play` already resumes on, so they
hold for direct play and for HLS alike. (The HLS remux drops chapters from its
output — `-map_chapters -1` — which no longer matters: the player gets the times
from `/play`.)

**Watched**: with a credits marker, `saveProgress` marks a title watched once the
position passes the credits' start; without one, 92 % as now.

## Home (isputnik.home)

- **Skip intro** — a button over the picture, bottom right, while the position is
  inside the intro; it seeks to the intro's end. Keyboard: `S`.
- **The end card at the credits** — when the position reaches the credits and
  `next` exists, the card shows with its countdown, as it does today at the end;
  Cancel lets the credits play on. Without `next`, nothing shows.
- **Marking (admins, K2)** — the player's menu gets **Mark intro start / Mark intro
  end / Mark credits start** at the current position, then "this episode / whole
  season", through the shared `Modal`. A marked range shows in the seek bar as a
  thin band, so a wrong mark is easy to see and redo; **Clear marks** puts back the
  file's own.
- i18n keys under `video.skip.*` (`en` + `ru`); the video section of
  `docs/users/apps.md` gets "Skipping intros and credits", including how to write
  an `.edl`.

## Stremio

Not covered. Stremio's add-on protocol has no field for intro or credits times
(to check again when K1 lands); Stremio on a TV keeps its own controls.

## Finding intros by itself (K3, later and only if needed)

What Jellyfin's intro skipper and Plex do: fingerprint the first minutes of each
episode's sound and find the stretch a season's episodes share. Needs ffmpeg built
with chromaprint (the image's Debian ffmpeg is believed to be — **check first**;
`ffmpeg-static` in development is not), or a small fingerprint of our own over raw
PCM. A background job per season, CPU-heavy, stored as `detected` rows that any
`.edl`, chapter or hand mark overrides. Films are left out: there is nothing to
compare them with. **Spike first**: a season of the owner's own shows, how many
intros it finds and how far off.

## Phases

| Phase | Where | What |
|---|---|---|
| **K1** | both | chapters (probe) + `.edl` → `markers` in `/play`; Skip intro button; end card at the credits; watched at the credits; tests with a chaptered MKV and an `.edl` made by ffmpeg in the test |
| **K2** | both | `markers` table, admin marking in the player (episode / season), seek-bar band, Clear marks; guide |
| **K3** | engine | spike, then automatic detection only if K1 + K2 leave too much uncovered |

K1 releases on its own (engine minor + home minor) and needs no setting.
