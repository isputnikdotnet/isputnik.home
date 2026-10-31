# iSputnik TV app — plan (draft for review)

A native app for Android TV and Fire TV. Background: `docs/video-architecture.md`,
`docs/apps-platform-plan.md`, `docs/stremio-plan.md`, `docs/video-skip-plan.md`,
`docs/auth.md` (Link a device).

Status: 2026-10-30. Plan accepted by the owner. T0 passed, owner's check included. T1 is
built in `D:\MyProjects\Web\isputnik.tv` (local, uncommitted) and works on the Fire TV
against this PC's dev servers (*T1 as built*). Owner chose fully native, and wants the
plan to leave room for the other parts of iSputnik that make sense on a TV.

## T1 as built (2026-10-30)

Modules as planned: `core`, `player`, `feature-video`, `app`. Nineteen unit tests.

**Seen working on the Fire TV, through home's gateway:** address typed once and kept; Link
a device with the phone's approval, labelled "iSputnik TV app on Android"; still signed in
after the app is stopped; Continue watching, Movies and Shows rows with posters; Resume at
the right place; Left and Right seek; progress saved and seen by the browser; a file the
TV refuses (H.264 4:4:4) moves to the engine's HLS copy, which is stopped on leaving.

**Changes from the plan above:**

- **No `client=tv`.** `/play` now also answers `playback.original` (engine, uncommitted).
  The app tries that and keeps `playback.url` as its way out, so the engine needs no idea
  which client is asking. An older engine names no original and its own choice is played.
- **The fallback already asks for the cheap thing.** `playback.url` is the browser's
  decision, so a sound-only problem (DTS with 8-bit H.264) gets remux, not a re-encode.
- **The app sends `Origin` on writes**, as a browser does. Home builds the phone's link from
  it (`requestOrigin`); without it the QR names `APP_URL`, not the address the TV reached.
- **Home's change** is one line in `BROWSERS` (`core/device-link.ts`), plus a test.

**Worth knowing:**

- **A 1080p Fire TV is 960 × 540 dp.** A screen taller than that squeezes its last child
  until the text is clipped, with no error. Every screen has to fit.
- **Make the player before composing its surface.** Made in an effect, `PlayerView` got no
  player: sound and a moving clock, no picture. The no-picture watchdog caught it.
- **The Fire TV keyboard** opens by itself on the address field and offers its own QR for
  typing on a phone. Its Next key confirms; Enter from `adb` presses the focused key.
- **On the dev setup the QR leads nowhere**: it names port 4000, which serves no web pages.
  Approve at `http://localhost:5173/link/<code>`. Launch configs `video` + `dev-video-tv`.

**Found in home, not fixed here:** `/link` says "open this address and enter the code", but
it always starts a device of its own and has nowhere to type a code (`DeviceLinkPage`; the
same words in `docs/users/link-a-device.md`). The TV therefore shows the full address with
the code in it.

**Not tested yet:** revoking the TV from Profile and Unlink on the TV (unit-tested only);
the `ru` strings on the TV, which are longer and must fit in 540 dp; a real install over
HTTPS, with its `__Host-` cookies; an episode through to the end.

**Left for T2:** focus returns to the first card after Back, not the one you left; a title
with no poster is a blank card; the language follows the device, not the person's setting.

## T0 results (2026-10-30)

The spike is in `D:\Demo\tv-spike`, outside every repository: AGP 9.2.1, Kotlin 2.3.0,
Compose BOM 2026.02.01, tv-material 1.1.0, Media3 1.11.1; a 10 MB release APK.

**Phone emulator only, so this says nothing about the TV's decoders or smoothness:**

- D-pad moves through the rows, Select plays, Back returns to the rows.
- Falling back works: H.264 4:4:4 and DTS were reported as unsupported before playing,
  and the app switched to the converted copy with no crash.
- Russian sidecar subtitles show correct Cyrillic when asked for by language, an audio
  track is chosen by language, and a start position is honoured.
- The app was killed several times by Android's low-memory killer: a 2 GB phone image
  full of Google apps, with the app at about 90 MB. Memory still has to be measured on
  the Fire TV. No app crash was seen.

**On the Fire TV (AFTKRT, Android 11, 1.7 GB RAM), direct from a test server, not yet
through home's gateway:**

| File | Result |
|---|---|
| MKV H.264/AAC, MP4, a 1 GB film with a Cyrillic name | Played direct |
| HEVC 10-bit + AC3 5.1, H.264 + AC3 5.1 | Played direct; the AC3 used no decoder in the app, so it goes out as AC3 |
| MPEG-2 + AC3 | Played direct, though the engine's list calls MPEG-2 refused |
| H.264 4:4:4 (crashed Stremio), H.264 10-bit, DTS 5.1 | Reported unsupported before playing, switched to the converted copy, no crash |
| Two audio tracks | The asked-for language chosen with no conversion |
| Subtitles | Sidecar and embedded both reach the player; Cyrillic correct in the log |

- **Timing:** a start takes 0.8–1.5 s, a seek 0.2–0.7 s, including in the 1 GB film. No
  dropped frames in the short runs.
- **Memory:** about 105 MB, browsing or playing 1080p, with 416 MB still available.
- **Scrolling:** 13–17 % of frames slow, 95th percentile 21–25 ms, in a build with no
  optimisation or baseline profile. Acceptable on paper; **the owner's feel decides**.
- **Seeking needs our own controls.** Media3's `PlayerView` takes the D-pad to show its
  controls. A key hook fixed it in the spike; the real player should draw its own.

**What this changes:** Media3 stays the choice unless the owner's check says otherwise.
Media3 says what the device can't decode before playing, so the app can decide per device
and the engine's "TVs refuse" list becomes a backstop for `client=tv`, not the rule. A
file refused only for its sound (DTS) converts the whole picture today; copying the
picture and converting only the sound is the engine's remux mode, so the fallback should
ask for that.

**Owner's check:** scrolling, picture and sound all good, so Media3 is the choice. Not
tested: image subtitles (PGS, ffmpeg can't write them), 4K and HDR, an evening's
continuous playback, and DTS through a receiver.

Also found: `D:\MyProjects\Mobile\isputnik_player` ("Laika"), a phone audiobook player
from May 2026 with Media3 and a playback service. Not used here; look at it before T6.

## In one sentence

**A member links the TV once with their phone, and the app shows that person's
video first, then photos and audiobooks — every screen ours, every permission
still decided by the server.**

## Why, and what it replaces

Stremio's home screen can't be made iSputnik-only without a paid account (owner,
2026-10-30), which fails the plan's own "Stremio shows only iSputnik". It also never
reports progress back, keeps the family's history on its servers, has no field for
skip marks, and crashes on a file the TV can't decode.

**Proposed:** the Stremio add-on stays released and working, and gets no new work.
Whether to remove it is decided once the TV app has replaced it in the house.

## Decisions

Owner (2026-10-30):

- **Fully native.** Kotlin, Compose for TV, Media3. Not a WebView over React.
- **More than video, where it makes sense.** See *What belongs on a TV*.

Proposed, for review:

- **Sign-in is the existing Link a device**, not a new token (see *Signing in*).
- **No second permission system.** The app calls the routes the web app calls, so
  library access, people sharing and the gateway's rules apply unchanged.
- **Watching and listening, not managing.** No uploads, edits, deletes or admin.
- **One repository, `isputnik.tv`**, beside `isputnik.video` and `isputnik.games`.

## What belongs on a TV

| Part | On the TV? | When | Why |
|---|---|---|---|
| **Shows and movies** | Yes | First (T1–T3) | The reason for the app |
| **Photos**: slideshows, albums, memories, a person's photos, gallery videos | Yes | T5 | A family looking at photos together is what a big screen is best at; nothing else in the plan brings iSputnik's own content to the room |
| **Audiobooks** | Yes | T6 | Few screens, and the player is already there; useful, but less suited to a TV than a phone |
| **Stories** | Maybe | Later | Good when narrated with photos; long text reads badly at TV distance. Decide after photos |
| **Photos as the screensaver** | Maybe | Later | Very attractive, but whether Fire TV lets an app supply one is **unchecked** |
| **Games** | Not now | — | Built as web pages for touch and mouse; a remote needs each game redesigned |
| **Family tree** | No | — | A large chart to pan and read; poor with a remote |
| **Ebooks, quotes, comments, tags** | No | — | Reading and typing |
| **Uploads, Inbox, review, editing** | No | — | Managing belongs on a phone or computer |
| **Control panel** | No | — | The server already refuses it to linked devices (`requireAdmin`) |

## How it should look (owner's picture, 2026-10-30; for T2)

The owner's mock-up of the Shows page, which sets the look of the whole app:

- **Colours:** very dark navy with a cyan-teal accent: the selected menu item, the
  primary button, the progress bar and the focus ring round a poster.
- **Top menu bar, not a side rail:** the iSputnik logo and "iSputnik TV" on the left; Home,
  Movies, Shows, Photos and Search in the middle, the current one underlined in teal; the
  person's picture and name on the right, which is where the person picker opens.
- **Page heading:** a large title ("TV Shows") with a line under it ("Your private
  collection"), and the sort control on the right ("Recently added").
- **A large banner** for the title in progress: backdrop picture, the title in wide letters,
  a one-line description, a progress bar with "S3 E5 · 42 min left", and two buttons,
  **Continue watching** (teal) and **Episodes**.
- **A row of tall posters below** ("All Shows"), the name under each poster, a teal ring on
  the focused one.
- **A quiet footer line:** "iSputnik Video · Private library".

Points to settle in T2: title lettering comes from plain text unless a logo image exists,
since the engine has no logo art yet; the banner needs a backdrop, so a title without one
needs a plain version; and the phrases above need `ru` wording.

## How more sections stay possible

Video must not be wired into the app's skeleton, or photos become a rewrite.

```
 isputnik.tv
 ├─ core        server address, session, API client, errors, translations, theme,
 │              focus rules, row and card components, update check
 ├─ player      Media3 wrapper: video and audio, tracks, progress callback
 ├─ feature-video        shows, movies, sets, title page, video player screen
 ├─ feature-photos       (T5)
 └─ feature-audiobooks   (T6)
```

- **A feature gives the shell three things:** a menu entry, rows for the Home screen,
  and its screens. Adding one changes neither `core` nor the other features.
- **The server decides what appears.** A section the member can't use, or that is
  switched off on this server (`core/sections.ts`), has no menu entry and no rows. A
  stopped video engine hides or explains video and leaves photos working.
- **Home mixes them.** Continue watching, Continue listening, then Memories, then
  library rows. The order is ours, which is the point of the app.
- **Translations:** `en` and `ru` as Android string resources, with Android's plurals
  for counts. They can't share home's JSON files directly; a generation script is
  worth considering if the two drift.

## Signing in

**Home already has what this needs.** Link a device (`core/device-link.ts`,
`docs/auth.md`, guide `docs/users/link-a-device.md`) was built for TVs: the screen
shows a code and QR, the phone confirms with the person's password, the owner is
emailed, and the device gets a long-lived session of kind `device`. Those sessions are
already barred from the control panel and from linking other devices, and are listed
and revocable under Profile's linked devices (`LinkedDevicesSection`).

This replaces the token design in `docs/apps-platform-plan.md` (*Tokens*) for this
client. Its line that TV apps "cannot carry the session cookie" isn't true of a native
app with a cookie store, and the benefit is large: **every existing route, for every
section, works for the app with its permissions intact.** A token would have needed
each route opened to it, one by one.

| Step | Detail |
|---|---|
| **Server address** | Typed once on first run and remembered. Discovery on the LAN can come later; containers on `br0` make it unreliable |
| **CSRF** | The app makes one GET, keeps the token cookie, and echoes it in `X-CSRF-Token`, as the web app does. So the exemption discussed at the top of `device-link-routes.ts` should **not** be needed |
| **Linking** | `POST /api/auth/device/start`, shows code and QR, polls `/api/auth/device/poll` |
| **Staying signed in** | Session cookie kept in storage encrypted with the Android Keystore; never logged |
| **Video** | The same cookie through the gateway, under `browse` and `watch` — not `devices`, so no Home-network-only rule to relax |
| **Where it works** | Linking is home-network only unless an admin opens a registration window. Once linked, a TV elsewhere works as a browser would |
| **Plain HTTP** | Allowed only for an address the owner typed, with a warning; Android needs it declared |

Small home change: `describeUserAgent` needs to recognise the app, or every TV is
listed and emailed as "An unknown device".

**Who's watching.** A session is one person. A shared TV holds one linked session per
person, each approved with that person's password, and a picker swaps between them.
Anyone holding the remote can switch to anyone linked there, and the guide must say so.
A PIN can come later if wanted.

## Playback

`/play/:id` decides per file **for a browser**: anything but MP4 or WebM goes to HLS.
A TV can do far better, and must not pay for conversion it doesn't need.

- **Engine:** `/play/:id?client=tv` answers the original file whenever the format isn't
  on the short "TVs refuse" list (already in the engine for Stremio's Converted stream),
  and **always** includes the converted address as a fallback.
- **Player:** Media3 first. On a playback error it switches to the fallback by itself,
  at the same position, and says so. Stremio crashes here; this is the main difference
  to prove in the spike.
- **Tracks:** a native player can choose among audio tracks in the original file, which
  a browser can't, so no conversion for dubs. Text subtitles come from the file or the
  existing WebVTT routes; image subtitles are tried natively, else burned in via Converted.
- **Limits stay:** one conversion per person and the household cap; `busy` is shown as
  the browser player shows it.
- **Progress:** the existing `PUT /progress/:id`, so browser and TV share one Continue
  watching and the engine's "watched" rules apply.
- **Skip:** Skip intro and the end card from `markers` in `/play` (K1, released in engine
  0.12.0 + home 4.49.0).
- **If Media3 can't cope** with too many of the test files: libmpv, decided in T0.

## Photos (T5)

Uses `/api/library/gallery/slideshows`, `/albums`, `/memories`, `/people` and
`/assets/:id/file`, all already filtered per viewer.

- **Rendered slideshow movies** play as ordinary video (`/slideshows/:id/movie`), with
  their cards and music. The first thing to build, and almost free.
- **Live viewer** for albums, memories and slideshows without a movie: left and right
  to move, a timed mode, gallery videos through the player (`?web=1` where a copy exists).
- **To check first: picture size.** Thumbnails are too small for a TV and originals can
  be very large scans. A TV-sized rendition route is probably needed; if so it must queue
  through `renderInTurn()` and hand sharp a Buffer where the file may be rewritten
  (CLAUDE.md).
- **To check first: list weight.** Routes such as `/gallery/timeline` were shaped for the
  web page. Add a thinner route only when a screen proves it needs one, under the same
  access checks.

## Audiobooks (T6)

Uses `/api/library/audiobooks/catalog`, `/books/:id`, `/books/:id/stream/:fileId` and the
book and track progress routes, so a book started on a phone continues on the TV.

Book page with chapters, a now-playing screen, a sleep timer, and playback that
continues with the screen off through a Media3 session service. Whether Fire TV leaves
that running in the background needs trying.

## Home server changes, all told

| Where | Change | Phase |
|---|---|---|
| `core/device-link.ts` | Recognise the app's user agent for its label | T1 |
| `core/sections.ts` or `/api/auth/me` | Confirm the app can read which sections this member has; add it if not | T1 |
| Engine `/play` | `client=tv`, the fallback address | T1 |
| Web | `/link` and Profile's linked devices already work; a line for the app's install on Help | T4 |
| `docs/users/` | `tv-app.md`, listed on the Help page (`check:ui`) | T4 |
| Gallery | A TV-sized picture route, if the check says so | T5 |

## Installing and updating

- **Install:** a signed APK from GitHub Releases of `isputnik.tv`; on a Fire TV through
  the Downloader app or `adb`. Stores can come later: both review apps, and this one is
  useless without a private server.
- **Updates:** the app checks for a newer release and offers it. TVs don't update
  themselves, so an old app must keep working after home is upgraded: API changes stay
  additive, and the app says plainly when a server or app is too old.
- **Signing key:** made once, kept in GitHub secrets, **and** backed up offline. If it's
  lost, every TV has to uninstall and start over.
- **Vega OS.** Newer Fire TV sticks run it and it can't run an Android APK, as
  `docs/apps-platform-plan.md` already notes for sideloading. The owner's AFTKRT runs
  Android 11 and is fine. Vega is out of scope; a TV bought for this should be Android TV
  or Google TV.

## Testing

| Layer | Checks | Runs |
|---|---|---|
| Unit | API parsing, resume, next episode, choosing the fallback, section rules | Every build, no TV |
| Compose UI | Screens, D-pad movement, focus returning after Back | Emulator or TV |
| Screenshots | Layouts in `en` and `ru` don't change by accident | Every build |
| App + real engine | The whole path against `isputnik.video` with its scratch clips (launch configs `video` + `dev-video`) | Before a release |
| Fire TV over `adb` | Install, key presses, screenshots, logs, crashes, dropped frames | Claude, with ADB debugging on |
| Watching | Picture, sound sync, subtitles, feel with the remote: ~10 minutes on a fixed list | Owner, before a release |

Video may come out black in `adb` screenshots, so playback checks read the player's logs.
One Fire TV is the only real device; the automatic fallback is the protection on others.

This PC has Android Studio's JDK 21, the SDK, `adb` and the emulator, but `java` isn't on
the PATH and the only system image is a phone. An Android TV image has to be installed.
`adb` lists no device yet.

## Phases

| Phase | What | Done when |
|---|---|---|
| **T0** | **Spike**, thrown away: a Compose row of real posters and a Media3 player, on the Fire TV. Files as in the Stremio spike: MKV H.264/AAC, HEVC 10-bit with AC3, embedded and sidecar Cyrillic subtitles, a 1 GB film with a Cyrillic name, the H.264 4:4:4 file | Scrolling feels good, and every file plays or falls back without crashing. Media3 or libmpv decided. **If not, stop and rethink** |
| **T1** | Repository and modules; server address; Link a device; a plain list; player with resume and progress; `client=tv` | The owner can link a TV and watch, and Continue watching matches the browser |
| **T2** | Home rows, shows, movies, title page, seasons and episodes, sets, search | Browsing no longer needs the browser or Stremio |
| **T3** | Tracks, subtitles, next episode, Skip intro, the person picker | As good as the browser player on everything it does |
| **T4** | Signing, releases, update check, guide on the Help page | Someone else in the family can install it. **Video is finished here**; decide Stremio's future |
| **T5** | Photos: slideshow movies first, then the live viewer | The family can look at albums and memories together |
| **T6** | Audiobooks | A book continues between phone and TV |
| Later | Stories, screensaver, Games, a store listing | Each decided on its own |

T5 and T6 can swap, and neither is needed for the video app to be finished.

## Open questions

1. **Photos before audiobooks?** Recommended, as above.
2. **A PIN on the person picker?** Recommended not at first, since everyone in the house
   is trusted and the guide states what it means.
3. **Stremio's future.** Decide after T4.
4. **Kodi over WebDAV (V4).** The TV app removes most of its reason. Leave open.
5. **Session lifetime.** A device session ends after `deviceSessionDays`, and the TV then
   needs linking again. Check that it fails with a clear message and a fresh code.
