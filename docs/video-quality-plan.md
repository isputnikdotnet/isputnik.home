# Video — quality for slow connections and viewers away from home (plan)

For the video engine (isputnik.video) and home's player. Background:
`docs/video-architecture.md`; builds on `docs/video-hw-transcode-plan.md` (the GPU
converts) and sits beside `docs/video-skip-plan.md`.

Status: proposed 2026-11-08, nothing built. Decisions below are recommendations
for the owner.

## In one sentence

**A viewer away from home gets a smaller picture made live by the engine, chosen by
the player or by the admin's limit, instead of the file as it is — no library is
converted ahead of time, and a stored copy is made only for a film someone wants to
carry with no connection.**

## What there is today

The engine looks only at codecs and containers (`src/delivery.ts`), never at size:

| Delivery | Picture | Bitrate on the wire |
|---|---|---|
| direct | the file's own bytes, with ranges (`/stream`) | whatever the file is |
| remux | the picture copied as it is into HLS segments | whatever the file is |
| transcode | ≤1080p H.264 (`hls.ts`: CPU CRF 22, GPU VBR 8 Mbit/s, both capped at 10) | up to 10 Mbit/s |

So a 30 Mbit/s Blu-ray remux in an MKV is *remuxed* and streams at 30 Mbit/s, which
no home upload link carries; and the one case where the engine does shrink still makes
up to 10 Mbit/s, fine on the LAN and too much for a phone on mobile data. There is no
way for a player to ask for less, and nothing knows whether the viewer is at home.

Two things are already in place that this plan leans on:

- **The gateway says where the viewer is.** Every request reaches the engine with
  `X-Isputnik-Network: trusted | home | internet` (`modules/apps/access.ts`,
  `networkClass()`, from `isPrivateIp` and the trusted zones). The engine reads nothing
  from it yet.
- **Segments are made on demand** from a plan whose cut points are fixed before ffmpeg
  runs (`hls.ts`: `buildPlan`, `segmentStarts`). A run starts at any segment and stops
  when the player goes. A change of sound track is already a new HLS address
  (`/hls/:id/t<audio>b<burn>/index.m3u8`) that the player opens from where it was.

## Why not convert ahead of time

- At home nearly every film plays as it is. A stored copy makes it worse, not faster.
- The only films that cost hardware are the ones a browser can't decode; the Intel GPU
  converts those live at almost no CPU, several at once, and a family seldom has more
  than one or two playing. There is nothing to save.
- A 720p copy of every film is about 1 GB each and days of GPU time, for copies that
  mostly never get watched. Away from home the problem is the upload link, not the
  hardware, and a live conversion at a lower rung costs the GPU *less* than today's
  1080p conversion does.

Where a stored copy does earn its place: a film for a flight. That is phase Q3, one
film at a time, opt-in.

## Decisions to make (owner)

1. **Rungs, not a continuous setting.** Recommendation: four — *Original*, *1080p*
   (today's conversion, 8 Mbit/s), *720p* (3 Mbit/s), *480p* (1.5 Mbit/s). Sound
   stays stereo AAC: 192k, 192k, 128k, 96k. H.264 High at every rung; no HEVC output
   (Firefox can't play it, Chrome only with platform support; the TV app dropped it too).
2. **One setting for viewers away from home, and it is a cap.** Recommendation:
   *Quality away from home: up to 720p* (default). A viewer on the internet starts at
   that rung and may go **lower**, not higher. The upload link is shared by everyone in
   the house, and one remote viewer at Original takes all of it. The other reading —
   a default the viewer may raise — is one toggle away if the family asks.
3. **At home: Original, and the picker still there.** A viewer on a weak Wi-Fi
   corner, or a phone, can pick 720p; the choice is remembered per browser,
   separately for home and away.
4. **Auto switching comes second, and only if needed.** Phase Q1 is the picker and
   the cap; Q2 lets the player move between rungs by itself on what it measures. Q2
   costs no extra encodes (below), but it is the part with the most ways to glitch, so
   it waits for Q1 to show whether anyone still stalls.

## How the engine decides (Q1)

`decideDelivery()` gains a `rung` beside `audioIndex` and `burnIndex`. A rung below
Original is a cap on **height and bitrate**:

| Source | Asked | Result |
|---|---|---|
| 1080p H.264 MP4 at 6 Mbit/s | 720p | transcode to 720p (height above the rung) |
| 720p H.264 MP4 at 2 Mbit/s | 720p | **direct**, as today — nothing to shrink |
| 1080p H.264 MKV at 28 Mbit/s | 1080p | transcode (bitrate above the rung); today it is remuxed |
| 1080p H.264 MKV at 6 Mbit/s | 1080p | remux, as today |
| anything | Original | exactly today's decision |

The bitrate test uses the probe's **overall bitrate** (`format.bit_rate`, falling back
to size ÷ duration), with a fifth of slack so a 1080p film at 8.5 Mbit/s is not
re-encoded to save nothing. `MediaInfo` gains `bitRate`; probes from before this
release are read again once, the way 0.25.0 did for colour (`media-probe.ts`,
`fresh`).

**Where the rung comes from**, in order:

1. `?quality=` on `/play` and in the HLS address (`t<audio>b<burn>q<height>`; no `q`
   means Original, so every address today keeps working). The engine refuses a rung
   above the cap for an internet viewer with the capped rung instead — the answer says
   which rung is playing and which are allowed, so the player's picker shows the truth.
2. No `?quality=`: *Original* when `X-Isputnik-Network` is `home` or `trusted`, the
   admin's rung when it is `internet`. The TV app and Stremio pass nothing, so a TV on
   the LAN sees no change at all.

**ffmpeg** (`hls.ts`, `ffmpegArgs`): the rung sets `MAX_HEIGHT`, `-b:v`/`-maxrate`/
`-bufsize` (GPU) or `-maxrate`/`-bufsize` with the same CRF (CPU), and `-b:a`. The
scale step already exists (`scale=-2:${MAX_HEIGHT}` and `scale_vaapi`); it takes the
rung's height instead of the constant. HDR tone mapping and burned subtitles are
untouched: they run before the scale, as now.

**Sessions.** The HLS key stays `${identity.id}:${item.id}`, so a rung change is what
a sound-track change is today: the old run stops, a new one starts at the current
segment, one place in *Most people converting at once*. The `who is watching` list
gains the rung (`720p`) beside GPU/CPU and HDR.

**Cost.** A 720p run is roughly a third of a 1080p run on the GPU and on the CPU; the
CPU-only path at 480p runs about real time on one core, which makes *CPU only*
bearable for a remote viewer. Segments are smaller, so *memory per viewer* holds more
of them; nothing to change there.

## Home (Q1)

- **Player** (`features/video/VideoPlayerPage.tsx`): a *Quality* entry in the menu that
  already holds sound tracks and subtitles, listing the rungs the engine allowed, the
  current one marked; choosing one reopens the stream from the current position, the
  way a sound-track change does. The choice is kept per browser (`localStorage`), one
  value for home and one for away, keyed by the `network` the `/play` answer returns.
  Strings are i18n keys (`video.quality.*`), Russian mirrored.
- **Settings › Video › Converting video** (`VideoConversion` in
  `control/sections/AppsSection.tsx`, anchor `video-conversion`): *Quality away from
  home* — Original · 1080p · 720p · 480p, default 720p; stored with the other
  conversion settings (`PUT /admin/conversion`, so it rides in the backup). Search terms
  in `features/control/search-index.ts` (`remote away from home mobile data slow
  connection quality 720p bitrate; вне дома мобильный интернет медленное соединение
  качество`).
- **Help**: a paragraph in the video guide under `docs/users/` (and the Help page list,
  `check:ui` enforces it).
- `docs/video-architecture.md` open question 3 is answered: streaming through home's
  gateway is not the bottleneck; the upload link is, and this plan is the answer to it.

## Auto switching without extra encodes (Q2)

HLS was made for this: a **master playlist** listing every allowed rung as a variant,
each with its own media playlist. hls.js's own ABR picks a variant from the bandwidth
it measures and asks for that variant's next segment. The engine makes segments on
demand, so **only the variant being played is encoded**: a switch starts a run for the
new rung at that segment and the old run stops when idle, exactly what a seek does
today. One run per viewer, so the GPU budget and *at once* limit are unchanged.

What has to hold:

- **One segment grid for every rung.** Variants switch cleanly only when their
  segments line up. Today a transcode uses a fixed 6 s grid and a remux follows
  keyframes. Q2 uses the remux grid (keyframes ≥ 6 s apart) for every rung of a
  film, forcing keyframes on those cuts in the transcode rungs — which `ffmpegArgs`
  already does for its own cuts. The MP4 header or ffprobe gives the keyframes
  (`media-probe.ts`, `keyframes()`), so every film pays that read once.
- **Start where Q1 would.** `startLevel` is the rung Q1 chooses (Original at home,
  the cap away), so nobody watches a blurry first ten seconds while hls.js learns the
  link. Switching down is allowed everywhere; switching up stops at the cap.
- **The first segment after a switch is the slow one** (a new run's first segment).
  hls.js's ABR must be conservative (`abrBandWidthUpFactor` ~0.7, a long
  `abrEwmaSlowVoD`) so it does not flap. If flapping shows up anyway, Q2 falls back to
  *suggesting* a lower rung after two stalls instead of switching by itself.
- Safari's own HLS (older iPhones) does the same with the master playlist for free.

Q2 is a new playlist shape and about a day of player tuning; it is built only if Q1
leaves people stalling, which the `who is watching` list and the engine log will show
(a viewer re-asking the same segment, a player hanging up mid-film).

## Travel copies and downloads (Q3, later, opt-in)

- **Make a travel copy**: an admin action on a film (and a whole season), from the
  film page's menu. The engine queues it (one job at a time, on the GPU when there is
  one, at the 720p rung, as an MP4 with `faststart`) under its own data folder,
  `travel/<item>.mp4`, and lists it in the Disks answer so Storage shows what they
  take. Nothing is scheduled by itself; copies stay until deleted.
- **Download**: the film page offers *Download travel copy* when one exists, and
  *Download original* always (`/stream` with `Content-Disposition`, through the
  gateway as every stream is). The PWA does not store multi-gigabyte files itself; the
  phone saves the file and its own player opens it.
- **A copy serves the stream too**: when a 720p copy exists, the 720p rung is that
  file, direct — zero conversion for the one film that was asked for.

This phase is built only if someone actually wants a film with no connection. Its
cost is disk (about 1 GB per two-hour film) and a queue to show and empty.

## Not in this plan

- Several rungs encoded **at once** per viewer (classic ABR ladders). It multiplies
  GPU work for the same result Q2 gets with one run.
- HEVC or AV1 output. 720p H.264 at 3 Mbit/s looks good on a phone and plays everywhere.
- Converting the whole library ahead of time, or a cache that fills itself.
- A speed test per viewer. The cap plus the picker is what Plex and Jellyfin do and it
  is enough for a family.
- A picker on the TV app or in Stremio: both are on the LAN. The `?quality=`
  parameter is there when a TV on a hotel Wi-Fi ever needs it.

## Testing

- **Engine, unit:** the rung decision as a pure function over probe + rung (the table
  above); `ffmpegArgs` per rung (height, rates, audio bitrate) on the CPU and GPU
  paths; the address with and without `q`; the cap applied to an `internet` request;
  the old probe re-read for `bitRate`. Q2: a shared `starts` for every rung of one
  film; the master playlist.
- **Home, web:** the picker lists what the engine allowed and reopens the stream from
  the current position; the setting round-trips through `PUT /admin/conversion`.
- **Live, on the owner's server:** a Blu-ray remux from a phone on mobile data over
  the internet path (not the VPN: `192.168.12.0/24` is private, so the VPN counts as
  home), and the same film at home at Original; the `who is watching` list showing
  the rung; CPU and GPU each once.
- **One number first:** the upload speed at home decides the default rung. 720p at
  3 Mbit/s needs an upload link of about 5 Mbit/s per viewer; below that the default
  should be 480p.

## Phases

| Phase | What | Where |
|---|---|---|
| **Q1** | `bitRate` in the probe; rung in `decideDelivery` and in the HLS address; `X-Isputnik-Network` default and cap; rung-aware `ffmpegArgs`; the rung in the viewers list. Home: Quality in the player menu, remembered per browser; *Quality away from home* on Converting video; search terms; help; architecture doc note | engine + home |
| **Q2** | Master playlist of the allowed rungs on one segment grid; hls.js ABR tuned, start level from Q1; only if Q1 leaves people stalling | engine + home |
| **Q3** | Travel copies per film/season (queue, Storage line), Download original / travel copy; the copy serves the 720p rung | engine + home |
| later | A picker in the TV app; Stremio stream variants | TV, engine |

## Open questions

- The owner's upload speed (decides the default rung and whether 480p is needed).
- Does the VPN count as home? Today it does (private addresses). A phone on mobile
  data over the VPN is still on the slow link, so the family may want the VPN subnet
  treated as *away* — that would be a Security › App access rule, not a video setting.
- Q2's grid: keyframes in some Blu-ray rips are up to 10 s apart; a 10 s segment at a
  switch is a long wait. If that shows up, the grid takes the keyframe *or* 6 s,
  whichever is first, and the Original rung leaves the master playlist for such files
  (it switches by the picker only).
