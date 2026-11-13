# Video — hardware tests: how fast it converts, how fast the disks answer (plan)

For the video engine (isputnik.video) and home's Videos workspace. Background:
`docs/video-hw-transcode-plan.md` (the GPU and its start-up check),
`docs/video-cache-plan.md` (where conversions are made), and the diagnostics report
(home 4.89.0, `modules/diagnostics`; engine 0.38.1, `GET /admin/diagnostics`).

Status: proposed 2026-11-13; the owner took the four recommended answers (below).
**Phase 1 (H1 + H2) built 2026-11-13 in the engine, uncommitted:** `src/hardware-test.ts`
(scenarios, clips, `HardwareTester`, `noteHardware`), the `hardware_tests` and
`hardware_changes` tables, `Hardware.gpuFor()` (the GPU's choice ignoring the admin's
setting and the set-aside state) and `onChecked`, and the routes in `app.ts`. The test
and the hardware changes are in `GET /admin/diagnostics`.

How it differs from the plan:
- **No subtitle burn-in case yet:** ffmpeg can't make an image subtitle from nothing.
  It needs a small DVD or PGS sample kept in the repo.
- **Each run loops its clip** (`-stream_loop -1`), so every case is timed for the full
  15 s rather than finishing a fast one in under a second.
- A "how many at once" result that reached the most tried (the viewer limit plus one)
  is marked `atLeast` ("4 or more").

First real run (i7-12700K, CPU only, ffmpeg 6.1.1), 153 s with the clips already made,
or about 3 minutes the first time. 4K HDR 4.45×, 4K 12.5×, 1080p HEVC 13.8×, 1080p → 720p
33×, DivX 36×, AV1 5.0×. At once: 3 in 4K HDR, at least 4 in 1080p. Suggested limit: 3.

**Phase 2 (H4's page) built 2026-11-13, uncommitted:** `VideoHardwareTest.tsx`
(`HardwareTestPage`, `HardwareTestRow`). It's a `?show=hardware` page of Videos ›
Settings, like that tab's other pages (Converting video, Copies…), not a `nav.ts`
page. It's linked from the overview's Playback group and from the GPU card on
Converting video. The engine now also reports a structured `step` (make / gpu / cpu /
together + scenario), so the page words progress in Russian too. Results show only a
CPU column when no GPU was tried. Verified in the browser against a real engine run
(desktop and phone width). Engine 0.39.0 + home 4.90.0 to be released together.

**Phase 3 (H3, the disk check) built 2026-11-13, uncommitted:** engine `src/disk-check.ts`
(`DiskChecker`, a `disk_checks` table), `POST/GET/DELETE /admin/hardware/disks`, the
last check in the diagnostics report. Home has a **Disks** part on the Hardware test
page, with its own **Check disks** button rather than being part of Run test. It's
quick and answers a different question. How it differs from the plan:
- **The wake-up time includes finding the file** (realpath and stat on the share),
  where a sleeping disk is felt first.
- **Reading starts at a random point** in the largest file, so a part a scan or player
  just read is less likely to come from memory.
- **No speed under 16 MB:** a read of less says nothing, so a library of tiny files says
  it couldn't measure.
- **Never at the same time as the hardware test** (409 either way), and it stops if
  someone starts watching.

On real films on this PC's NVMe drive: answers in 1–5 ms, reading at 23.6 Gbit/s. Not yet
tried on a NAS with sleeping disks; that's the Unraid test share's job.

**The clips are synthetic.** The test pattern makes 31 Mbit/s 4K, 9 Mbit/s 1080p HEVC and
37 Mbit/s 1080p H.264, which is realistic, but a heavy 4K remux (50–80 Mbit/s) is
somewhat slower than the 4K row says. The page should say so.

## In one sentence

**An admin presses Run test and finds out, in numbers, whether this server can play
what is in its libraries: how many times faster than real time each kind of film
converts on the GPU and on the CPU, how many people that allows at once, and how fast
each library's disks answer and read, with the results kept and put in the
diagnostics report.**

## Why

The start-up check (`hardware.ts`, `detectGpu`) answers yes or no: the GPU encodes
H.264, decodes these codecs, tone-maps HDR, draws subtitles. It can't say whether a
film converts fast enough to watch. StefanKnol's 4K HDR film converted at 0.8 to 0.93×
real time on an Arc A750 (isputnik.video#2), so it buffered constantly, and nothing on
the Converting video card would have said so. His other reports (#1, #6) came from disks
that had spun down: each first read waited seconds for one to wake, and nothing showed
that either.

Projects like Jellyfin and Plex test what the GPU can do and fall back to the CPU, as this
engine already does. What they rarely do is say plainly how fast the server is. That
answer is the one people want: "will 4K play smoothly on my box?", "how many can watch at
once?", "why does it buffer?".

## What there is today

- **The start-up check** runs when the engine starts, on **Check again**, and when the
  hardware setting changes. It finds `/dev/dri`, reads `vainfo`, encodes a second of H.264
  on the GPU, and decodes a half-second sample of each codec through `scale_vaapi`. It also
  tries a tone-map (an HDR10 sample with mastering data, since 0.37.0) and an `overlay_vaapi`
  subtitle. The result is `GpuCapabilities` (device, driver, decode list, tonemap, overlay,
  error).
- **GPU failures** while converting: three in an hour set the GPU aside until **Check
  again**. Since 0.38.0 the last ten are kept with ffmpeg's own words
  (`Hardware.recentFailures()`).
- **Home's Converting video card** (Videos › Settings) shows the check's result, **Check
  again**, Where to convert (auto / CPU / GPU), the storage, and who is watching on what.
- **The diagnostics report** carries the check's result and the recent failures.
- **No measurement of speed anywhere**, and nothing about the disks except free space
  (Dashboard).

## The design

### H1 — Conversion speed test (engine)

**Scenarios.** Short generated clips, one for each kind of film this engine meets. Each is
converted the way a viewer's player would get it, using the real `ffmpegArgs()` for a plan
built from the clip's own probe. So the test measures exactly what watching does, filters
and limits included, not a hand-written command.

| Scenario | Clip | Converted to | Why |
|---|---|---|---|
| 4K HDR | 3840×2160 HEVC 10-bit, PQ with mastering data | 1080p H.264, tone-mapped | The heaviest case; Stefan's |
| 4K SDR | 3840×2160 HEVC 8-bit | 1080p H.264 | A 4K film without HDR |
| 1080p HEVC | 1920×1080 HEVC 10-bit SDR | 1080p H.264 | Most modern rips |
| 1080p H.264 to 720p | 1920×1080 H.264 | 720p rung | Watching away from home |
| DivX | 720×400 MPEG-4 Part 2 in AVI | H.264 | The owner's old films |
| AV1 | 1920×1080 AV1 | 1080p H.264 | Only where this ffmpeg can make it |
| Subtitles burned in | 1080p H.264 + an image subtitle | 1080p H.264 with the subtitle drawn in | The burn path |

- **Each scenario runs where it would really run:** on the GPU, as `Hardware.choose()`
  would pick, and on the CPU. The CPU run is what happens when the GPU fails or is set
  aside, so its speed matters too.
- **The clips are made once and kept** (`<config>/samples/`, about 60 MB in all), and made
  again when ffmpeg's version changes. Making the 4K HEVC clips takes the CPU a minute or
  two the first time, so the first test says so ("Making the test clips…").
- **What is measured:** ffmpeg's `-progress pipe:1` reports `out_time` and `speed`. A run
  stops after 15 s of wall time, or at the clip's end (20 s of film), whichever comes first.
  What it reached gives the speed: **×real time** (2.4× means a 2-hour film converts in
  50 minutes, and a viewer never waits after the first segment). Frames per second
  are kept too, for the report.
- **How many at once:** the heaviest scenario the GPU handles is run two at a time, then
  three (up to the admin's viewer limit plus one), until it drops below 1.2× real time. Each
  step takes 15 s. The answer is a measured number of simultaneous 4K and 1080p viewers,
  not an estimate from one run. The test **suggests** a viewer limit; the admin applies it
  with one click.
- **Verdict per scenario:** `smooth` (at least 1.5×), `tight` (1.0–1.5×: plays, but a busy
  disk or a second viewer makes it buffer), `too slow` (under 1.0×: it will buffer), or
  `can't` (failed, with ffmpeg's last line).
- **Never in someone's way.** A test is refused while someone watches converted video
  (`hls.watching() > 0`: "Someone is watching; try again when they've finished"), and stops
  at once if someone starts. Copies, keep-ready fills and detection wait while it runs, as
  they do for a viewer. A test takes 2 to 5 minutes in all; progress is shown scenario by
  scenario.
- **Kept:** the last 20 tests in a new engine table, `hardware_tests` (`schema.sql`, a new
  table, so no migration). Each holds when it ran, the GPU fingerprint, the ffmpeg version and
  each scenario's result.

### H2 — A note when the hardware changes (engine)

At each start, the engine compares the check's fingerprint with the last one kept: device,
driver, decode list, tonemap, overlay, ffmpeg version. A difference becomes a history row
("Intel Arc A310 → Intel Arc A380", "driver 24.1 → 25.2", "ffmpeg 7.0 → 7.1") and an event.
Home then shows "Last test was before the hardware changed — run it again". No watcher
runs between starts: a new card or driver always means a restarted container.

### H3 — Disk check (engine)

For each active library, run when the admin asks (alone, or as the second half of Run test):

- **Wake-up:** the time to stat and read the first 64 KB of a few files spread across the
  library's top-level folders. On an Unraid user share they are likely on different disks.
  The slowest answer is reported: "the first answer took 8.4 s — a disk was asleep". The
  check can't put a disk to sleep, so it says what it found; run again a minute later, the
  same library answers in milliseconds.
- **Reading speed:** a sequential read of up to 512 MB from the library's largest file, in
  MB/s.
- **Against what it holds:** the highest bitrate among the library's probed films, so the
  verdict is concrete: "your heaviest film needs 75 Mbit/s; this library reads at 1.2 Gbit/s"
  or "a 4K remux needs more than this disk gives while another is reading from it".
- Reads only. Nothing is written to the media folders, as everywhere in the engine.

### H4 — Home: the page, the report, the guide

- **Videos › Settings › Hardware test,** a page under the Settings tab (`pages` on its
  `nav.ts` entry, with its own address and a back link). It's linked from the Converting
  video card ("How fast is it? Run a test"). Following the control-panel rule, the video
  application's own controls live in its workspace, not in Infrastructure. The page shows:
  - the check's capabilities as a table: codec × decode/encode, HDR tone-map, subtitles
  - **Run test**, with progress per scenario
  - the results: a row per scenario with GPU and CPU speed and the verdict, the "how many at
    once" line with **Use this limit**, and the disk check per library
  - the history: past tests and hardware changes, each test openable
- **The diagnostics report** gets the last test's results and the hardware changes, in the
  video container's part, through the same `GET /admin/diagnostics`. Nothing in home is
  video-specific.
- Search terms (`search-index.ts`), the Video guide, en + ru strings.

### Engine API

- `POST /admin/hardware/test` `{ disks: boolean }` starts a test. The answer is 202 with the
  test's id, 409 while someone watches, and 409 if a test is already running.
- `GET /admin/hardware/test` returns the running test's progress, or the last result.
- `DELETE /admin/hardware/test` stops it.
- `GET /admin/hardware/history` lists past tests and hardware changes.
- `POST /admin/hardware/disks` runs the disk check alone.

Home reaches these through the gateway, admins only, like the rest of `/admin/*`.

## Phases

1. **H1 + H2 in the engine:** scenarios, sample clips, the speed runner, concurrency steps,
   the table, the fingerprint note. Tests: scenario planning against fake probes, verdicts,
   the refusal while watching. One real CPU run of the DivX and 1080p clips in CI, which has
   no GPU.
2. **H4's page in home** (capabilities, Run test, results, history), and the diagnostics report
   line. Engine and home released together.
3. **H3, the disk check,** in both. Separate because it needs a real NAS to be worth
   anything. The test environment on the owner's Unraid server (a test share with spin-down)
   is where it gets tried.

## Not in this plan

- **NVIDIA (NVENC) and AMD.** The engine converts on Intel through VAAPI only. AMD through
  VAAPI might work as it stands, and NVENC would be a new back end. A test page shouldn't
  promise either.
- **Continuous monitoring or tests on a schedule.** The hardware can't change without a
  restart, and a test takes the GPU and the disks for minutes.
- **Changing settings by itself.** The test suggests a viewer limit; only the admin applies it.
- **Network speed.** Home's speed test (4.84.0, `/api/speed-test`, the TV app's gear menu)
  already measures the link to a viewer.

## Decisions for the owner

1. **Where the page lives:** Videos › Settings › Hardware test (recommended, by the
   workspace rule), or under Infrastructure next to Diagnostics?
2. **CPU runs too:** every scenario on the CPU as well as the GPU, which doubles the time
   to about 5 minutes (recommended: the CPU is the fallback, and on a server without a GPU it
   is the only answer). Or only on servers without a GPU?
3. **The concurrency steps:** measure two, three, four at once (recommended, about 1 minute
   more), or estimate from the single run?
4. **The disk check reads up to 512 MB per library:** fine, or smaller? On a NAS that's a few
   seconds per library, and it may wake disks.
