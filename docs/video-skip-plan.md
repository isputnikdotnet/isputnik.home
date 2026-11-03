# Skip intro and credits — plan

For the video engine (isputnik.video) and home's player. Background:
`docs/video-architecture.md`; sits beside `docs/video-sets-plan.md`.

Status: owner accepted the four decisions as recommended. K1 built 2026-10-30
(engine `src/markers.ts`, home's player). K2 built 2026-11-02 (see "As built in
K2"), K3 the same day (see "As built in K3").

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

## As built in K2

- The `markers` table below, `PUT /video/api/admin/markers/:id` with
  `{ kind, scope, start, end }` (a null `start` clears that scope's mark). `/play`'s
  markers carry `source: "manual"` and the mark's `scope`, so the player can clear it
  where it is kept. Marks need no probe; the daily sweep drops those whose episode,
  film or show is gone. Watched-at-the-credits follows a credits mark too.
- **Not a dialog but a panel under the picture** (**Mark intro** in the player's bar,
  admins only): marking means scrubbing the film to the spot, which a modal over it
  would hide. Each time has **Here** (from where the film is) and the time itself
  goes there, to check; scope is a tab pair, season first for an episode.
- **No band in the seek bar**: the player uses the browser's own controls, which
  can't be drawn into. The panel has its own thin bar of the marks with the playhead
  instead.
- The TV app needed nothing: it reads `markers` from `/play` and ignores `source`.

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

### Spike results (2026-11-02)

Scripts in the session scratchpad (`k3/spike.mjs`, `k3/credits.mjs`), run on the
owner's library and checked frame by frame against the picture.

**Chromaprint is not needed.** ffmpeg only decodes the sound (8 kHz mono PCM, which
every build does); the fingerprint is ours: every 0.128 s, 32 bits, each the sign of
how the energy difference between two neighbouring bands (300–3000 Hz, log spaced)
changed since the frame before. Near-silent frames never match, or silence would
match silence. Two episodes are compared at every alignment; frames differing in
at most 10 of 32 bits match, and the longest run of matches (gaps up to ~1.5 s) is
what they share. Each episode takes the stretch most of the season's others agree
on.

**Intros, by sound: right wherever there is one.**

| Show | Found | Notes |
|---|---|---|
| Counterpart S1 + S2 (20) | 20/20, ~71 s | starts 2:45–10:28 (cold opens of every length); start on the cut, end within ~3 s |
| Долгая дорога в дюнах (7) | 7/7, ~80 s | start a few seconds after the titles appear, end right after «Вторая серия» |
| Ералаш S1, first 12 | 10/12, ~26 s | sketches 1 and 10 have another opening, matched only in part (10 s) |

- **The window must be long**: 10 minutes missed a cold open of 10:28 and cut another
  intro at the window's edge. First 15 minutes (or a quarter of a short file).
- **Accept only a length near the season's median** (±25 %) agreed by at least half
  the others: that drops the partial Ералаш matches instead of marking half an intro.
- Cost: decoding 10 minutes of sound off the NAS ~7 s per episode, fingerprinting
  0.4 s, every pair of a 10-episode season 6 s. A season in about 1½ minutes.

**Credits, by sound: no.** Counterpart's credits play different music each episode
(0/20); the 1980 series has none. Only Ералаш's closing jingle (~25 s, to the end of
the file) was found that way.

**Credits, by picture: yes.** End credits are text on near-pure black. ffmpeg's
`blackdetect` on keyframes only (`-skip_frame nokey`, scaled to 320 px) over the last
10 minutes, ~6 s per episode: `pix_th=0.03` (dark scenes at 0.10 passed for black),
`pic_th=0.80` (at 0.92 a crowded crew list was too bright, which put one start 45 s
late and missed another), stretches under 6 s apart joined, the first of ≥ 20 s is
the credits. Counterpart 20/20, each start on the cut to the credits. The 1980 series
correctly gives none (a 5-second end card only). Needs no season, so **films get it
too**.

**What it adds up to for K3:**

- Intro: sound, per season, at least 3 episodes; median-length rule above.
- Credits: picture first, a shared sound stretch reaching the end second.
- Kept apart from the admin's marks (`detected` rows can't share the `(item_id,
  season, kind)` key with an episode's own manual mark, so a table of their own or
  a key with `source` in it). Order: manual, `.edl`, chapters, detected.
- A queued background job like the metadata pass, one season at a time, after a
  scan finds new episodes; a per-show "Find again" for the admin.

### As built in K3 (2026-11-02, engine 0.16.0)

- `src/detect.ts`: the spike's fingerprint and comparison, made to yield to the event
  loop between pieces. Two changes from the spike: each episode is compared with
  its 6 neighbours each side rather than every other episode (a 120-episode season
  stays linear), and a shared run's ends are trimmed until a quarter of the frames
  around them match (a stray chance match could stretch a run by a second or two).
  Windows: the first 15 minutes or a third of the file for the intro; the last 10
  minutes or a quarter for the credits by picture, 6 minutes for a closing tune.
- `detected_markers`: one row per episode or film file, for that file's size and
  date; a season is compared again when any episode in it is new or changed. Order
  in `findMarkers`: manual, `.edl`, chapters, detected.
- A queue of its own after each scan and on start (everything not yet looked at),
  outside the catalog work a restore waits for; `POST /admin/markers/:id/detect`
  (the panel's **Find again**) re-runs that episode's season or that film.
  `DETECT_MARKERS=false` turns it off.
- On the owner's library through the engine's own code: Counterpart 20/20 intros
  and 20/20 credits (~4 minutes a season off the NAS), Долгая дорога в дюнах 7/7
  intros and correctly no credits, Ералаш S1 22/25 intros (two with another opening
  and one more left unmarked) and 21/25 closing tunes.

## Recaps ("Previously on") — spike 2026-11-02

Counterpart has one in every episode after the first: the rating card, "Starz
Originals presents", a **Previously on** card (~0:18), then about a minute of clips,
a cut to black, the cold open. Scripts `k3/recap.mts` (sound) and `k3/recap-pic.mjs`,
`k3/recap-season.mjs` (picture) in the session scratchpad.

- **By sound: no.** The start of each season 2 episode against the whole sound of
  the episodes before it: no clip matches better than chance. The recap is re-cut
  and its music laid anew, so its sound is not the scenes' sound.
- **By picture: mostly.** Frames at 4 fps, 32×18 grey, each minus its own mean;
  a run of 4+ frames matching consecutive frames of an earlier episode is a piece
  of it. Season 2, each episode against the two before it:

  | Episode | Found | Notes |
  |---|---|---|
  | E03, E04, E05, E07, E09, E10 | 0:19–0:24 → 1:12–1:59, 24–42 pieces | E05 checked frame by frame: 0:29–1:19, end on the cut to black |
  | E01 | broken off at 0:28 | its clips are from season 1 episodes not compared with; a 22 s gap ended the span |
  | E02 | 0:22 → 0:36, more from 0:50 | gap too strict again |
  | E06, E08 | starts 0:31 / 0:36 | likely late: their first clips are from older episodes |

  The shared opening (everything matching an earlier episode's own first 30 s)
  must be left out, or the rating card is "the recap". Pieces later on (2:39, 2:47)
  are a cold open picking up the last episode's final scene, not a recap.
- **What it would need to be reliable:** the recap starting where the shared
  "Previously on" card ends (the start is then never late), comparing with every
  earlier episode of the season (and the last of the season before, for a
  premiere), and gaps up to ~25 s inside it.
- **Cost:** decoding a whole episode's picture is ~65 s off the NAS, once per
  episode; its frames then keep small (a 64-bit hash each, ~100 KB an episode).
  About as much again as the intro pass.

Marking a recap by hand works whatever is decided: a third kind next to intro and
credits, **Skip recap** in the player, chapters named *Recap / Previously on / Ранее
/ В предыдущих сериях*. A season mark makes no sense for it (each recap is its own
length), so it is per episode only.

### As built (2026-11-02, engine 0.17.0, home 4.60.0)

- **By hand**: `markers.kind` takes `'recap'` (episode scope only; a season scope is
  refused). An older `markers` table can't have its CHECK widened in place, so
  `db.ts` renames it, lets `schema.sql` make the new one and copies the rows, in one
  transaction. Chapters named as above count; an `.edl` gives no recap (a stretch
  there can't be told from an intro). The panel has a Recap row above the
  season/episode tabs; the player's Skip button says Skip recap or Skip intro, and
  **S** does either.
- **Found**: `picture_prints` keeps each episode's picture as 64-bit dHashes (9×8
  grey, 4 fps, ~100 KB an episode), decoded once with two threads and B frames
  skipped (~80 s an episode off the NAS; with all frames it was ~150 s). An
  episode's first 4 minutes are matched against every earlier episode of its season
  (a premiere: the last two of the season before); a piece is 4+ frames within 6
  bits of consecutive frames there. Pieces matching an earlier episode's own first
  30 s are the shared opening; the recap runs from where that ends through pieces
  ≤ 25 s apart, at least 5 of them, never into the intro. Columns `recap_start`,
  `recap_end`, `recap_checked` on `detected_markers`: a season from 0.16 is looked
  at once more for its recaps.
- Closing the engine now waits for its own ffprobe runs (`MediaProbe.idle()`):
  one left reading a file kept Windows from deleting it.

## Phases

| Phase | Where | What |
|---|---|---|
| **K1** | both | chapters (probe) + `.edl` → `markers` in `/play`; Skip intro button; end card at the credits; watched at the credits; tests with a chaptered MKV and an `.edl` made by ffmpeg in the test |
| **K2** | both | `markers` table, admin marking in the player (episode / season), seek-bar band, Clear marks; guide |
| **K3** | both | built 2026-11-02: intro by sound per season, credits by black frames, a background job, `detected_markers`; home's panel says Found automatically and offers Find again |

K1 releases on its own (engine minor + home minor) and needs no setting.
