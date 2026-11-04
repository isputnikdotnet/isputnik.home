# Video — converting on the Intel GPU (plan)

Status: plan for review, 2026-11-03. Nothing built. Work is in the engine
(`isputnik.video`), its image and Unraid template, and home's Settings → Video.

## Why

The engine converts what a screen can't play as it is (`src/delivery.ts` decides,
`src/hls.ts` runs ffmpeg). Today every converted picture is made on the CPU:

```
-c:v libx264 -preset veryfast -crf 22 -maxrate 10M -bufsize 20M -profile:v high -pix_fmt yuv420p
(+ scale=-2:1080 above 1080p, + overlay for an image subtitle drawn in)
```

- **Cost.** A 4K HEVC film converted to 1080p H.264 takes one or more whole cores per
  viewer; that is what *Most people converting at once* on Settings → Video guards.
- **HDR looks wrong.** A 10-bit HDR film is squeezed to 8-bit `yuv420p` with no tone
  mapping, so it plays grey and washed out. This is a bug today, GPU or not.

Intel's media engine (Quick Sync, in the iGPU of most Core CPUs and in Arc cards)
decodes H.264, HEVC (10-bit from 7th gen), AV1 (from 11th gen), resizes, tone-maps
HDR and encodes H.264/HEVC — several 1080p streams at once, at almost no CPU.

## Decisions proposed

1. **VAAPI first, QSV maybe later.** Both reach the same hardware from ffmpeg on
   Linux. VAAPI (`h264_vaapi`, `scale_vaapi`, `tonemap_vaapi`) works from Broadwell
   (5th gen) through Arc with one driver and fewer libraries; QSV adds a little
   quality control at the cost of the oneVPL runtime. Nothing here closes QSV off.
2. **Debian's ffmpeg, with Intel's driver from Debian non-free** (changed 2026-11-03
   from Jellyfin's ffmpeg build, at the owner's choice). Debian's ffmpeg has VAAPI
   (`h264_vaapi`, `scale_vaapi`, `tonemap_vaapi`); the image turns on the `non-free`
   component for `intel-media-va-driver-non-free` (iHD) and adds `vainfo`. Everything
   comes from Debian, no third-party repository, a smaller image. Jellyfin's build
   (better tone-mapping filters, extra VAAPI fixes) stays the fallback if H2 finds
   tone mapping on the owner's Kaby Lake needs it.
3. **Automatic, with the CPU as the way out.** The engine finds out at start what the
   GPU can do and uses it where it can; anything it can't (a codec it can't decode, a
   run that fails) is done on the CPU, for that viewer, without a dead player.
4. **One setting, three choices:** *Automatic* (default), *CPU only*, *GPU only*
   (fails rather than falling back — for testing and for the owner who wants to know).
5. **Tone mapping for everyone.** HDR → SDR on the GPU where it can, and on the CPU
   (`zscale` + `tonemap`) where there is no GPU, so the washed-out bug goes everywhere.

## Getting the GPU into the container

- **Unraid template** (`isputnik-video.xml`): a *Device* entry `/dev/dri` (blank by
  default, described as "Intel GPU for converting video — /dev/dri"), so the owner
  adds it with one field rather than Extra Parameters.
- **Permissions.** The engine runs as PUID:PGID (99:100 on Unraid) through gosu
  (`scripts/docker-entrypoint.sh`); `/dev/dri/renderD128` belongs to the host's
  `render` (or `video`) group, whose GID differs per host. The entrypoint, while still
  root: for each `/dev/dri/renderD*`, read its GID, create a group with that GID if
  none exists, and run gosu with it as a supplementary group
  (`gosu "$PUID:$PGID"` takes no extra groups, so: add a user for PUID if missing,
  `usermod -aG` it, and `gosu <user>`). This is the step that makes or breaks it.
- **Which device.** `VIDEO_GPU_DEVICE` env, default the first `/dev/dri/renderD*`.
  Most hosts have one.

## Finding out what works

At start (and on *Check again* in Settings), with the setting not *CPU only*:

1. Device present and readable? (Else: "no GPU passed to the container".)
2. `vainfo --display drm --device <dev>` → driver name and the profiles it lists.
3. **A real test**, which is what counts: a 1-second generated clip
   (`-f lavfi -i testsrc2=size=1280x720:rate=25`) encoded with `h264_vaapi`; then for
   each source codec we may meet — H.264, HEVC 8-bit, HEVC 10-bit, AV1, VP9, MPEG-2 —
   a short sample made by the CPU encoder in the same run, decoded with
   `-hwaccel vaapi`; then `tonemap_vaapi` on a 10-bit sample. Each pass or fail is kept.

The result is kept in memory and shown to the admin, e.g.
*"Intel UHD Graphics 630 (iHD 24.x): converts on the GPU · decodes H.264, HEVC,
HEVC 10-bit, VP9 · HDR tone mapping"*, or *"No GPU: /dev/dri is not in the container"*.

## How a conversion runs

`delivery.ts` already decides *whether* the picture is converted; a new step decides
*where*, from the probe (`media-probe.ts`: codec, profile, pixel format, HDR transfer)
and the capabilities:

| Case | Decode | Filters | Encode |
|---|---|---|---|
| GPU decodes it, no image subtitle | GPU | `scale_vaapi=w=-2:h=1080:format=nv12` (HDR: `tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709` first) | `h264_vaapi` |
| GPU can't decode the codec | CPU | `format=nv12,hwupload` (+ CPU tone map for HDR when the GPU can't) | `h264_vaapi` |
| Image subtitle drawn in | GPU | `hwdownload,format=nv12` → `overlay` on the CPU → `hwupload` | `h264_vaapi` |
| No GPU, or *CPU only* | CPU | as today, + `zscale`/`tonemap` for HDR | `libx264` as today |

Sketch of the common case (exact flags to be settled on real hardware):

```
-init_hw_device vaapi=va:/dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi
-i <file> … -vf 'scale_vaapi=w=-2:h=1080:format=nv12'
-c:v h264_vaapi -rc_mode QVBR -global_quality 23 -b:v 8M -maxrate 10M -bufsize 20M
-profile:v high -force_key_frames <cuts>
```

- **Keyframes on every cut** stay a must (HLS segments start on one). `h264_vaapi`
  honours `-force_key_frames`; the detection test checks it on its clip, and a GPU
  that doesn't is treated as not able to convert.
- **Same limits as today:** ≤1080p, ≤10 Mbit/s, H.264 High, stereo AAC — the player,
  the TV app and Stremio see no difference except speed.
- **Falling back.** If a GPU run exits with an error before its first segment, the
  same segment range is run again on the CPU and that title stays on the CPU for the
  rest of the viewing; the engine log says why (the ffmpeg error line). After three
  such failures in an hour, Automatic stops using the GPU until *Check again*, and
  Settings says so.
- **Seeking** works as now: each run starts at a segment with `-ss`; GPU decode
  doesn't change the timing rules in `hls.ts`.

## Settings, status and logs (home)

On **Control panel → Settings → Video → Converting video** (the card that holds the
memory and *at once* limits):

- **Where to convert:** Automatic · CPU only · GPU only.
- **What was found** (the line above) and **Check again**.
- **Most people converting at once**: the default rises from today's when the GPU
  is in use (to be measured; 4–6 for an iGPU is typical). Still the admin's.
- The *who is watching* list marks each conversion **GPU** or **CPU**, and the HDR ones.

Engine API: `GET /admin/conversion` gains `hardware: { mode, device, driver, encode,
decode: string[], tonemap, error }`; `PUT /admin/conversion` takes `hardware.mode`;
`POST /admin/conversion/check`. Settings move with the backup like the rest of
`settings`. Search terms for the setting go in `features/control/search-index.ts`.

## Testing

- **Unit:** the per-file decision (table above) as a pure function over probe +
  capabilities; the ffmpeg arguments for each case; the fallback after a failed run
  (a stand-in ffmpeg that exits 1).
- **CI and this Windows machine:** the CPU path only — VAAPI is Linux. Tests never
  need a GPU; detection with no `/dev/dri` must say so and choose the CPU.
- **On the owner's Unraid server** (the real test): a test image tag
  (`:gpu-test`), `/dev/dri` added, then Settings → Check again, and a film of each kind
  played — H.264, HEVC 10-bit HDR, one with a PGS subtitle burned in, one seek far in.
  Before that, two commands to see what the host has:
  `ls -l /dev/dri` and `docker exec isputnik-video vainfo --display drm`.

## Phases

| Phase | What | Where |
|---|---|---|
| **H1** | Image with Debian ffmpeg + Intel non-free driver; `/dev/dri` in the template; entrypoint group fix; detection; GPU encode with GPU/CPU decode; fallback; *Where to convert* setting and status *Engine released 2026-11-03 as 0.20.0, tried on the owner's i5-7500 (iHD 25.2.3, MPEG-2 decoded and H.264 encoded on the GPU); VC-1 taken from vainfo, as ffmpeg can't sample it. Home's card waits for its release: engine `src/hardware.ts`, `hls.ts`, Dockerfile, entrypoint, template; home's Converting video card. GPU encode is VBR 8 Mbit/s capped at 10; the image's `latest` tag now skips pre-release tags (v0.20.0-rc.1) so a test image can be published.* | engine + home |
| **H2** | HDR tone mapping, on the GPU and (no GPU) on the CPU | engine |
| **H3** | Image subtitles drawn on the GPU (`overlay_vaapi`); HEVC output for the TV app where it plays it, to halve the bitrate | engine (+ TV app) |
| later | QSV path; NVIDIA (NVENC) and AMD (VAAPI already covers most AMD) | engine |

## Open questions

- **The owner's server (2026-11-03):** `/dev/dri` has `card0` and `renderD128`, group
  `video`, mode `0777` (Unraid's Intel GPU driver plugin opens them up), so passing the
  device is enough there; the entrypoint's group step is still for other hosts.
- **The owner's CPU: Core i5-7500** (Kaby Lake, HD Graphics 630, i915). Its GPU
  decodes H.264, HEVC 8- and 10-bit, VP9 (incl. 10-bit), MPEG-2 and VC-1, and encodes
  H.264 and HEVC; **no AV1 decode** (that stays on the CPU, the second row of the table).
  HDR tone mapping on this generation is the uncertain part: the VAAPI filter may
  not be offered on Gen 9.5, and Jellyfin's OpenCL tone mapping (`tonemap_opencl`)
  needs Intel's compute runtime, whose newer releases dropped Gen 9. H2 tries VAAPI,
  then OpenCL, then the CPU, and detection says which one is used. H1 is tested on this
  machine.
- **Image:** decided 2026-11-03: Debian's ffmpeg and driver, not Jellyfin's build.
- **GPU only:** worth offering, or is *Automatic* / *CPU only* enough?
