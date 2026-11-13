# Video — one cache for watching, downloads and films kept ready (plan)

For the video engine (isputnik.video) and home's Videos workspace. Background:
`docs/video-architecture.md`, `docs/video-hw-transcode-plan.md` (the GPU converts),
`docs/video-quality-plan.md` (quality rungs, prepared copies, downloads in the PWA).

Status: proposed 2026-11-12. The owner took the seven decisions below. **C1 built
2026-11-12, uncommitted** (engine: `mounts.ts`, `storage` + `memoryMb` replacing
`memoryPerViewerMb` + `whenFull`, which are still read and answered for older homes;
home: the storage group on Videos › Settings › Converting video). **C2 built 2026-11-12**:
entries as planned, but kept films are noted in an `entry.json` in their folder
(`cache/<variant>-<random>/`) rather than a table, folders are never reused (Windows
holds them), and the one limit is the copies' existing `limitGb` (Room for kept video,
50 GB by default) — no new setting. **C3 built 2026-11-12**: copies that re-encode fill the
cache and are concatenated into the MP4; the queue of copies survives a restart (the
catalog rows), half-filled versions too (`filling.json`); Keep ready and finish-off share
the queue. Deviations: the Keep ready list sits on Settings › Copies for download (not an
Organize page), and copies still keep their MP4 beside the kept version (no 24 h
removal). **C4 built 2026-11-12**: the gate (right away / idle / night window), jobs at
once, downloads waiting per member, the speed of copies away from home, and the queue with
Run now · Move to the top · Take off, on Settings › When downloads are prepared (not
Infrastructure › Tasks). Email when a copy is ready stays as it was; no in-app notice yet.
All four phases are in; nothing is released.

## In one sentence

**Converted video is made once and shared: in memory first, on a fast disk when the
admin has mapped one, kept when a film was converted all the way through, used again
for downloads, and made ahead of time only for the titles an admin marks Keep ready —
on a queue the admin paces to what the server can take.**

## What there is today

- **Watching** (`hls.ts`). One run per person and film (`<person>:<item>`). ffmpeg
  writes each segment to the transcode folder; finished segments are read into memory
  up to `memoryPerViewerMb` (300 MB), past that they stay on the disk (`whenFull:
  "disk"`, the default) or the run waits (`"wait"`). Segments behind the player are
  deleted; a session idle for a minute is stopped and its folder removed. Two people
  watching the same film convert it twice. The segment grid is fixed before ffmpeg
  runs, so a segment is the same whichever run made it — this plan leans on that.
- **Prepared copies** (`copies.ts`, engine 0.33.0). One MP4 per title/rung/audio, made
  on a queue of one (GPU, else `nice` + half the cores, SIGSTOP while someone watches
  converted video), kept under 20 GB in `<TRANSCODE_PATH>/copies`, used longest ago
  first out. The queue lives in memory only. Home emails when a copy is ready
  (`modules/library/video/copy-notices.ts`). A copy is a second encode even when the same
  film was just watched converted.
- **The container.** The Unraid template's Transcode path (`/transcode`) is optional and
  empty by default. Left empty, `/transcode` is a folder inside the container — on
  Unraid that is `docker.img` — and both the overflow while watching and up to 20 GB of
  copies land there. **This is a live footgun and C1 fixes it.**

## Owner decisions (2026-11-12)

| # | Question | Decision |
|---|---|---|
| 1 | Default storage when a real disk is mapped to `/transcode` | **Memory, then disk.** With no disk mapped: Memory only, and the disk modes are not offered. |
| 2 | Size limits | **One cache limit** for everything on the disk. Keep ready titles and copies someone is waiting for are never removed by it. |
| 3 | Which finished viewings are kept | **Only real conversions** (picture re-encoded). Remux and sound-only conversions are cheap to redo and as big as the file: not kept. |
| 4 | What "busy" means for jobs | **The engine's own conversions + system load.** Home's tasks are not asked. |
| 5 | GPU on the owner's server | **Found.** "Right away" is a realistic default there; CPU-only servers are told to prefer a night window. |
| 6 | Who marks Keep ready | **Admins only.** Members keep asking for download copies, which the cache may remove later. |
| 7 | Keep ready qualities | **480p, 720p, 1080p**, one or more per title, 720p ticked by default. |

## Storage (C1)

### Is `/transcode` a real disk?

The engine reads `/proc/self/mountinfo` at start and finds the mount `TRANSCODE_PATH`
sits on. It is **mapped** when that mount is not the container's root filesystem
(`overlay` on `/`). Outside Linux (development) a set `TRANSCODE_PATH` counts as mapped.
The answer goes into `/admin/conversion` beside the existing usage:
`{ disk: { mapped, path, freeBytes, totalBytes, filesystem } }` (the Disks code in
`disks.ts` already measures it).

### The three modes

`ConversionSettings` changes:

| Today | New |
|---|---|
| `memoryPerViewerMb` | `memoryMb` — one pool for the whole engine (see below) |
| `whenFull: "disk" \| "wait"` | `storage: "memory" \| "memory-disk" \| "disk"` |

- **Memory only** — ffmpeg still has to write a file, so segments are written to the
  conversion folder and read in at once (as now); with no disk mapped that folder is in
  the container but only ever holds the few segments being written. When the pool is full
  the run stays `MIN_AHEAD` segments ahead and waits (today's `"wait"`).
- **Memory, then disk** — today's default, unchanged in spirit.
- **Disk only** — `memoryMb` 0.

Not mapped → the engine forces `storage: "memory"` whatever is saved, and says so
(`disk.mapped: false`); copies and kept films are not made (Keep ready and Download ›
Optimized say why, with the one host step). Upgrade: a saved `whenFull: "disk"` becomes
`memory-disk` where mapped and `memory` where not. Copies already sitting in an unmapped
`/transcode/copies` keep being served until the cleanup removes them; no new ones are made
there, and the settings card shows how much is inside the container with a Delete button.

### One memory pool

Per viewer made sense when nothing was shared. With shared entries (C2) one segment in
memory serves everyone, so the limit is for the whole engine: `memoryMb`, default
`min(1024, 10% of RAM)`, admin range 0–16384. Inside it each converting entry is
guaranteed `MIN_AHEAD` segments; the rest goes to whoever needs it, oldest-read out first.

### Settings (home)

Control panel › Applications › Videos › Settings, a card **Where video is converted**
(anchor `video-conversion-storage`, search terms: transcode, cache, memory, RAM, disk, SSD):

- Status line: "Fast disk: /transcode — 412 GB free" or "No disk mapped — video is
  converted in memory only." with how to map it (one sentence, the template field's name).
- Mode (three choices; the two disk ones disabled with the reason when not mapped).
- Memory for conversion (MB), with what is in use now.

The template's Transcode description is rewritten (engine repo `isputnik-video.xml`):
optional; a cache-pool or SSD folder; holds conversion overflow, finished films, download
copies and Keep ready titles; size set in the app. No new container fields.

## The shared cache (C2)

### A cache entry

One version of one title:

`variant = item id + file size + file mtime + delivery mode + rung + audio + burned subtitle`

hashed into a folder `<TRANSCODE_PATH>/cache/<hash>/` holding `<n>.ts` segments. A changed
file has a new variant, so a stale entry is never served — it is simply never asked for
again and the cleanup takes it. Table `cache_entries` in the engine DB:

```
hash, item_id, rung, audio, burn, mode, file_size, file_mtime,
state ('partial' | 'complete'), segments_total, segments_done, size_bytes,
pinned (Keep ready), wanted (a copy someone is waiting for), last_used_at, created_at
```

Memory-held segments belong to the entry, not to a viewer.

### Watching from it

- A viewer has a **cursor** in an entry, no longer a session of its own. Ask for segment
  n: there (memory or disk) → served; being written by a run within `JUMP_AHEAD` → wait
  for it; else start a run at n.
- A run **stops at the next segment that already exists** and, if the player is heading
  on, starts again past the filled stretch. So a second viewer of the same version reads
  what the first made and converts only what is missing.
- `maxViewers` counts **runs**, not viewers. One person, one film at a time stays (the
  existing `person` refusal) — keyed by cursors.
- Behind the player: in Memory only, segments go as today (`KEEP_BEHIND`). With a disk and
  a picture being re-encoded (decision 3), segments behind the player **move to the disk
  instead of being deleted**, so the entry can fill up.

### Kept when complete

When every segment exists the entry becomes `complete`: memory-held segments are written
out and the entry stays until the cleanup removes it. Next time that version plays with no
conversion at all.

A viewing that skipped around leaves holes. **Finish it off**: when a partial re-encoded
entry has ≥ 70 % of its segments and nobody holds it, a low-priority job (C3) fills the
holes. Below that the partial entry is deleted 10 minutes after its last viewer left.
Partial entries without a job do not survive a restart (the start-up sweep of today keeps
`cache/` but drops entries in `partial` with no job).

Remux and sound-only entries (decision 3) are never kept: they behave exactly like
today's sessions — segments in memory or the folder, gone when the viewer leaves.

### One limit

`cacheLimitGb` (replaces `copies.limitGb`, which it inherits on upgrade; default 50 GB, or
20 % of the disk's size if smaller). Over it, entries go oldest `last_used_at` first,
skipping `pinned` and `wanted` ones. If pinned + wanted alone exceed the limit, nothing more
is queued and the card says so. Usage is shown split: kept after watching · download copies
· Keep ready · in use now.

## Jobs on the cache: copies, Keep ready, finish-off (C3)

### One job kind

A **job** fills an entry's missing segments in the background. Three reasons make one:
a download copy someone asked for, a Keep ready title, a finish-off. They share one
queue, replacing `copies.ts`'s own.

- **Persisted** (`cache_jobs`: entry hash, reason, asked_by, created_at, state) — needed
  for night windows; a restart picks the queue up again.
- **Resumable per segment**: stopping a job loses at most the segment being written. This
  replaces SIGSTOP for long pauses (a paused ffmpeg holds memory and a GPU context for
  hours); SIGSTOP stays for the short "someone just started watching converted video"
  pause.
- **Slower and smaller than live**: jobs use the copy encoder settings (`COPY_LIMITS`,
  slower preset on the CPU, the GPU's quality mode). Segments from a job and from a live
  run sit on the same grid and mix fine in one playlist.
- Order: copies someone waits for → Keep ready → finish-off.

### Downloads from an entry

What home's downloader asks for stays the same (`/copies/:id` state + `/copies/:id/file`),
now answered from the entry:

- **In the PWA** (the offline store): the HLS playlist + segments of a complete entry,
  which `offline/video.ts` already knows how to capture — resumable per segment, no extra
  disk.
- **Save file to the device**: an MP4 remuxed from the segments with `-c copy` (seconds),
  written to `cache/<hash>/copy.mp4` on first ask and deleted 24 h after its last download.
- **Full copy** stays the original file, no entry.
- Original quality and remux-only titles need no job: downloadable at once, as today.

### Keep ready (admins only)

- **Where**: a **Keep ready** action on a film, a show, a season, a set — on the title page
  menu, for admins. A list on Videos › Organize › Keep ready (a tab page per the control
  panel rules) shows every kept title, rungs, size, state, with Remove.
- **What**: rungs 480/720/1080 (720 ticked), the default sound track (option: all tracks),
  burned subtitles only where the admin picks an image track. For a show or season: **and
  new episodes** (ticked) — the scanner's new-episode event queues them.
- **Only what needs it**: a title whose file already fits the rung (codec, height,
  bitrate — `decideDelivery` with that rung) says "Plays as it is at 720p" and makes no
  job. A remux-only result says "Starts at once, nothing to keep". Everything else is a job.
- **Before queuing**: an estimate (duration × the rung's `COPY_LIMITS` bitrate, ≈1.5 GB
  per film at 720p, 3–4 GB at 1080p); refused with the numbers when pinned + wanted would
  pass 80 % of the cache limit.
- Removing Keep ready unpins; the entry then ages out like any other.

## Pacing (C4)

Settings › **Downloads and Keep ready** card (anchor `video-jobs`):

- **When to prepare**
  - *Right away* — default with a GPU; paused while someone watches converted video.
  - *When the server is idle* — no conversion runs and the 1-minute load average under
    0.7 × cores for 2 minutes (decision 4); a job stops (resumably) when that ends.
  - *Only between* — a window, default 01:00–07:00 (server time); a job running at the
    end stops and goes on next night. Suggested on CPU-only servers.
- **At once** — 1 (default), up to 2 with a GPU.
- **Per person** — copies one member may have waiting, default 10; admins unlimited.
- **Downloads away from home** — a speed cap in Mbit/s (off by default), one token bucket
  shared by every download whose request carries `X-Isputnik-Network: internet`, so a
  download cannot take the upload link from someone streaming remotely. Streams are never
  capped by it.
- **Tell people** — email when a copy is ready (today's `copy-notices.ts`), and the
  Downloads page shows queued · waiting for the night · preparing 42 % · ready.

Admins see the queue in Infrastructure › Tasks `?application=videos`, read from a new
engine `/admin/jobs` (cancel, move to the top, run now — "run now" ignores the window and
idle rule, not the at-once limit).

## Engine changes, by file

- `disks.ts` / new `mounts.ts` — the mapped check.
- `hls.ts` — `Session` → `CacheEntry` + cursors; runs stop at filled segments; one memory
  pool; spill-behind to disk; completion. `ConversionSettings` as above.
- new `cache.ts` — entries table, variant hash, cleanup under one limit, usage.
- `copies.ts` → `jobs.ts` — persisted resumable queue on entries; MP4 remux for Save file.
- new `keep-ready.ts` — scopes, rung choice, new-episode hook from `scan.ts`.
- `app.ts` — `/admin/conversion` gains `disk` + `storage` + `memoryMb`; `/admin/cache`
  (usage, limit, clear kept-after-watching), `/admin/jobs`, `/admin/keep-ready`;
  `/copies/*` answered from entries.
- `schema.sql` — `cache_entries`, `cache_jobs`, `keep_ready` (new tables, so no migration
  for them; the settings rename needs one).
- `isputnik-video.xml` — Transcode description.

## Home changes

- `VideoSettingsSection.tsx` — the two new cards; the Copies card folds into the cache card.
- Title pages — Keep ready for admins; Download dialog states (waiting for the night, etc.).
- Videos › Organize › Keep ready page (`nav.ts` `pages`), search entries, en + ru keys.
- Tasks — engine jobs under `?application=videos`.
- `docs/users/` — the videos admin guide gets storage, cache, Keep ready, pacing; new shots
  via `npm run docs:shots`.

## Phases

| Phase | What | Releases |
|---|---|---|
| **C1** | Mapped check, three modes, one memory pool, settings card, upgrade of saved settings, the in-container copies warning | engine + home |
| **C2** | Cache entries, shared runs, spill behind, keep complete re-encodes, one limit | engine (+ home usage line) |
| **C3** | Jobs on entries (copies move over), finish-off, downloads from entries, Keep ready | engine + home |
| **C4** | When to prepare, at once, per person, remote speed cap, Tasks queue | engine + home |

C1 is worth shipping alone: it ends the `docker.img` footgun.

## Testing

Engine (Vitest):
- mountinfo parsing from fixtures (Unraid bind mount, tmpfs, overlay root, no mount);
- the variant hash changes with file mtime/size, rung, audio, burn;
- two cursors on one entry → one run; a run stops at a filled segment and resumes past it;
- spill-behind and completion; remux entries never kept;
- cleanup order, never pinned/wanted; the over-limit refusal;
- a job resumes from its last segment after a restart; window and idle rules on a fake clock
  and a fake load average; the remote speed cap with a fake network header.

Live, on the owner's Unraid (GPU found): two browsers on one converted film (one run in
the admin's list), watch a DivX film through and see it kept, Keep ready a season at 720p
overnight, download it in the PWA on a phone.

## Not in this plan

- Converting whole libraries automatically, or a rule like "everything added this month"
  (possible later, only on the owner's say).
- ABR ladders / several rungs encoded at once (Q2 in `video-quality-plan.md` stays as it is).
- HEVC output.
- Home's own tasks counting as busy (decision 4).
- Members asking for Keep ready (decision 6).

## Open questions

1. Memory pool default — `min(1 GB, 10 % of RAM)` is a guess; the owner's server RAM decides.
2. Finish-off threshold (70 %) and whether finish-off is a switch the admin can turn off.
3. Default cache limit — 50 GB, or ask in the card on first use?
4. Keep ready for shows: "and new episodes" ticked by default?
