# Adding the games and video apps

Some parts of iSputnik run in containers of their own, beside the main app:
**Games** (family board and arcade games) and **Video** (TV shows and movies). You
install each one like any other container, then connect it to iSputnik in
**Control panel → Apps**. This guide is for whoever runs the server.

> **Video is in alpha.** Video libraries, the Shows and Movies pages and the
> player are here. MP4 and WebM files a browser plays as they are are sent as
> they are; the rest are converted while they play — usually just the sound
> (AC3, DTS and the like become AAC), the picture too when a browser can't show
> it (HEVC, 10-bit), which takes real CPU. A film with more than one sound track
> has a **Sound** menu in the player (a dub, a commentary), and the next film
> starts in the language chosen last. Subtitles, posters and online metadata
> come next. Each person resumes where they stopped, and
> Continue watching (on Shows, Movies and For you) lists what they left halfway
> and the next episode.

## How the apps fit in

- **One way in.** Nobody reaches an app directly. Every request goes to iSputnik
  first — under `/games` or `/video` on the same address — which signs the person
  in, checks they may use the app, and passes the request on. So there is one
  sign-in, one address and one certificate, and every protection iSputnik already
  has (two-factor, rate limits, blocked addresses) covers the apps too.
- **No published port.** An app's container needs no port open to your network or
  the internet. Only iSputnik talks to it.
- **A shared secret.** iSputnik signs each request it passes on with a secret the
  app also holds, so the app knows the request came from iSputnik and nobody else.
- **Games is an app, Video is an engine.** Games draws its own pages. Video has no
  pages of its own: iSputnik shows its libraries, shows and movies, and the video
  engine scans the folders, keeps the catalog and plays the files. Video
  libraries are added and shared on **Library → Libraries** like every other
  library.

## 1. Put the containers where iSputnik can reach them

iSputnik must be able to reach each app by address. Either:

- **A shared Docker network** (compose, or `docker network create isputnik` once
  and set every container to it). iSputnik then reaches an app by its container
  name: `http://isputnik-games:4200`, `http://isputnik-video:4300`. Docker's
  default `bridge` network does **not** resolve container names, so it won't do.
- **Fixed addresses**, for example Unraid's `br0` with a fixed IP for each
  container. iSputnik reaches the app at `http://<its IP>:4200` (games) or
  `:4300` (video).

## 2. Install the app's container

### Games

On Unraid, install **isputnik-games** from Community Applications (or add the
template from the [isputnik.games repository](https://github.com/isputnikdotnet/isputnik.games)).
Leave **Gateway Secret** empty for now — you'll fill it in step 3. Keep
**Config & Data** (`/config`) on your appdata share; it holds the matches,
scores and the games' own log of events.

With compose, add the service from the games repository's `docker-compose.yml`
to the same file as iSputnik, so both share its network.

### Video

The video engine reads your video folders and never writes to them. Give its
container:

| Setting | Value |
|---|---|
| Image | `ghcr.io/isputnikdotnet/isputnik.video` (on Unraid, the template `isputnik-video.xml` in the [isputnik.video repository](https://github.com/isputnikdotnet/isputnik.video)) |
| `/media` | your video folder, **read-only** (for example `/mnt/user/data/video`) |
| `/config` | an appdata folder: the catalog database and poster cache |
| Network | the same network as iSputnik, or a fixed IP; **no port published** |
| `GATEWAY_SECRET` | empty for now — you'll fill it in step 3; until then the container stops as soon as it starts |
| `/transcode` | optional: where ffmpeg writes each piece of a film being converted before the engine takes it into memory, and where pieces past a viewer's memory share stay ([Converting video](#converting-video)); left out, a folder inside the container |

Lay the folders out the way Jellyfin and Kodi read them — `Show (Year)/Season
01/Show (Year) S01E01.mkv` for shows, `Movie (Year)/Movie (Year).mkv` for films.
`.nfo` files beside them are read first.

## 3. Connect them on Settings → Apps

Everything on iSputnik's side is done here: nothing to change on the iSputnik
container, and no restart. Open **Control panel → Settings → Apps** and choose
the app.

1. Under **Where the container is**, type the app's **Address** and press **Save
   address**: `http://isputnik-games:4200` or `http://isputnik-video:4300` on a
   shared network, or `http://<its IP>:4200` / `:4300` with fixed IPs. It is how
   iSputnik reaches the app, not how your browser does. The **Container** line
   then says whether it answers; *Not answering* means check the address and
   that both containers are on the same network.
2. Under **The shared secret**, press **Generate secret**. It is shown **once** —
   press **Copy**.
3. Paste it into the app container's `GATEWAY_SECRET` (the **Gateway Secret**
   field on Unraid), apply, and let the container restart.
4. Press **Test connection**. **Paired** means the app answers and accepts
   iSputnik's secret.

The address and the secret both work the moment they are saved. iSputnik keeps
the secret encrypted with its server key, so a copy of its database — a backup,
say — doesn't carry it.

**Replace secret** makes a new one; the old one stops working at once, so the app
is unavailable until its container has the new one. **Forget secret** turns the app
off for everyone until it is paired again.

> **Prefer environment variables?** Set them on the iSputnik container instead:
> the address as `GAMES_URL` / `VIDEO_URL`, the secret as `GAMES_GATEWAY_SECRET`
> / `VIDEO_GATEWAY_SECRET` (a long random string, e.g. `openssl rand -hex 32`,
> and the same value as the app's `GATEWAY_SECRET`). A value set this way always
> wins, and Settings → Apps then shows it as *Set in this container's environment*. All of
> them are in the
> [configuration reference](https://github.com/isputnikdotnet/isputnik.home/blob/main/docs/configuration.md#apps).

## 4. Choose who may use it, and from where

**Control panel → Security → App access**, for the chosen app:

- **Who may use it.** Everyone signed in is a member until you change something.
  Grant people or groups **Member** (uses the app) or **Manager** (also looks
  after it — its admin pages), or **Denied** to keep someone out; take
  **Everyone** down to *No access* to allow only the people you list.
  Administrators are always managers. Someone with no role doesn't see the app
  at all: no menu entry, and its address answers as if it weren't installed.
- **From where.** Each thing the app does has its own rule — **Anywhere**,
  **Trusted networks only**, or **Home network only**. Games has *Play* and
  *Manage*; Video has *Browse*, *Watch* and *Manage*. A request refused by a rule
  gets a message saying why ("This works only from the home network").

For Video, which libraries each person sees is set on each library, on **Library
→ Libraries**, exactly as for books and photos.

## 5. Check that it's healthy

- **Overview → Dashboard** — iSputnik with a branch to each app: running or
  not, its version, its address, whether it accepts iSputnik's secret and how
  long it takes to answer. Anything wrong is listed at the top.
- **Overview → Logs**, with the app chosen under **Source** — **Events** is what
  the app recorded about itself (refused callers, matches, scans, errors);
  **Server log** is the newest lines of its own log, what `docker logs` would
  show, without a shell on the host.

Starting, stopping and updating an app's container stays where you manage
containers (Unraid's Docker page, or compose). iSputnik only watches.

## Video libraries

Once Video is paired, **Library → Libraries → Add library** offers **Video**.
Choose whether the library holds **Shows** or **Movies**, then pick its folder:
the picker shows the folders mounted into the video engine, not iSputnik's own.
The engine scans the library straight away; its counts and scan state appear on
the Libraries page. A file still being copied is left for the next scan, so a
half-copied season is never catalogued as something else.

Deleting a video library removes its catalog from the engine; your video files
are never touched. If the engine is down when you delete it, it lets the library
go on its next sync.

Each member can also watch their video libraries in the Stremio player on a TV,
with a link of their own from Profile; HTTPS and the network rule it needs are in
[Watching in Stremio](stremio.md#for-administrators).

## Converting video

A film a browser can't play as it is (an `.mkv`, sound in AC3 or DTS, an HEVC
picture) is converted while someone watches: the sound alone when the picture
is fine, both when it isn't. The engine keeps a few minutes ready ahead of the
player. **Settings → Video → Converting video** sets how:

- **People watching converted video at once** (3 to start with). Each one runs a
  conversion of their own, and re-encoding a picture keeps a processor core
  busy. One more sees *Too many people are watching right now* with **Try
  again**, rather than everyone stuttering. Films that play as they are don't
  count.
- **Memory per viewer** (300 MB to start with). What is ready ahead is kept in
  the engine's memory up to this much per viewer; nothing to set up in Docker.
  0 keeps it all on the disk.
- **When a viewer's memory is full** — *Carry on on the disk* keeps the usual
  few minutes ready, the rest in the `/transcode` folder; *Keep less ahead*
  stays in memory and converts a little at a time.

The card shows who is watching what right now, and how much of it sits in
memory and on the disk. Most films need well under the 300 MB; a Blu-ray rip
whose sound is converted carries its picture unchanged, so it is the one that
fills a share. Changes apply at once; anyone already watching carries on.

## Posters and descriptions

Pictures saved beside the video files are always shown: `poster.jpg` and
`fanart.jpg` in a show's or film's folder, `Film (Year)-poster.jpg` beside a
film, `<episode file name>-thumb.jpg` beside an episode.

For the rest, give the engine a key from a free TMDB account (themoviedb.org →
Settings → API) on **Settings → Video → Posters and descriptions**. It is checked
with TMDB before it is kept and never shown again. After every scan the engine
then fetches posters, backdrops and episode pictures, and fills in descriptions
and episode names where the `.nfo` files have none — an `.nfo`'s own words
always stay.

A title matched to the wrong film or show: open it and press **Fix match**
(admins only), search TMDB by name and year, and pick the right one. Rescans keep
that choice until **Match automatically again**.

## Sets of films

Films that belong together — a trilogy, a series of films, a family's own
"Summer at the dacha 2019–2024" — are grouped into a **set** without anyone
building it:

- **From the `.nfo` files.** A `<set>` in a film's `.nfo` (Kodi and Jellyfin
  write `<set>The Matrix Collection</set>` or `<set><name>…</name><overview>…</overview></set>`)
  puts it in that set. Films whose `.nfo` names the same set — capital letters
  and spaces aside — are one set, even in different libraries.
- **From TMDB.** With a key, a film TMDB knows as part of a collection joins that
  collection, with its description, poster and order. A set named in an `.nfo`
  always wins over TMDB's.

On **Movies**, **View → Sets** lists every set you can see two or more films of.
A set's page shows its films in order — by release date, else by year — and one
**Play** that starts the first film you haven't watched yet. A film's own page
says which set it is part of, with the others beside it, and when a film of a
set ends the player offers the next one.

Each person only sees the films of a set that are in libraries they may watch:
someone who sees only *Kids* sees only that part of a set. Films you don't have
are never listed. Films matched before sets came in are asked about their set
on the next metadata pass, which follows every scan.

## Subtitles

Subtitles inside a film and subtitle files beside it — `Film (Year).srt`,
`Film (Year).ru.srt`, `Film (Year).en.forced.srt` (SRT, ASS or VTT) — appear in
the player's **Subtitles** menu, named by language. Text subtitles show over the
film as it plays. Blu-ray and DVD subtitles are pictures no browser can show, so
the engine draws them onto the film, which then counts as converted video. The
language chosen last is picked again for the next episode.

## Backups

**Full** and **minimal** backups (Control panel → Maintenance → Backup) also ask
each paired app for a copy of its database and keep it inside the same zip — the
games' matches and scores, the video catalog and watch progress. Media files and
an app's caches are never included. If an app can't hand its database over, the
backup still finishes and its log line says which app was left out and why.

## Turning an app off

- **For the menu only:** Control panel → Settings → Appearance → Sections, switch
  **Games** or **Video** off. The app disappears for everyone; nothing is deleted.
- **For good:** on Settings → Apps, clear the app's address and press **Forget
  secret** (or remove `GAMES_URL` / `VIDEO_URL` from the iSputnik container if
  you set it there), then remove the app's container.

## When something goes wrong

| What you see | What it means |
|---|---|
| Dashboard: **Not answering** | iSputnik can't reach the address. Check the container is running, the address and port, and that both are on the same network (not Docker's default `bridge`). |
| Dashboard: **Secret refused**, or members see "Not signed in" in the games | The two secrets differ. Generate a new one on Settings → Apps, paste it into the app's `GATEWAY_SECRET` and restart the app. |
| Settings → Apps: **Set in this container's environment** | The address (`GAMES_URL` / `VIDEO_URL`) or the secret (`GAMES_GATEWAY_SECRET` / `VIDEO_GATEWAY_SECRET`) is set on iSputnik and wins. Keep it, or remove it and restart iSputnik to set it on Settings → Apps. |
| A rule refuses everyone from outside | Behind a reverse proxy whose trust isn't set up, every visitor counts as outside. Set `TRUST_PROXY` — see [Exposing your library to the internet](exposing-to-the-internet.md). |

## Checklist

```
[ ] App container on the same network as iSputnik (or a fixed IP), no port published
[ ] Settings → Apps: address saved, and the Container line says it answers
[ ] Settings → Apps: secret generated, pasted into the app's GATEWAY_SECRET, app restarted
[ ] Settings → Apps: Test connection says Paired
[ ] Security → App access: who may use it, and from where
[ ] Video: media folder mounted read-only, libraries added on Library → Libraries
```
