# Adding the games, video and faces apps

Some parts of iSputnik run in containers of their own, beside the main app:
**Games** (family board and arcade games), **Video** (TV shows and movies) and
**Faces** (the face recognition behind People in the gallery). You
install each one like any other container, then connect it to iSputnik in
**Control panel → Apps**. This guide is for whoever runs the server.

> **Video is in alpha.** Video libraries, the Video page and the
> player are here. MP4 and WebM files a browser plays as they are are sent as
> they are; the rest are converted while they play — usually just the sound
> (AC3, DTS and the like become AAC), the picture too when a browser can't show
> it (HEVC, 10-bit), which takes real CPU. A film with more than one sound track
> has a **Sound** menu in the player (a dub, a commentary), and the next film
> starts in the language chosen last. Subtitles, posters and online metadata
> come next. Each person resumes where they stopped, and
> Continue watching (on Video's **Overview**, Shows, Movies and For you) lists what
> they left halfway and the next episode. The video pages are laid out like the
> TV app: **Overview** leads with a banner of what you were watching, else the
> newest title, over rows of what's new; a show's page has a tab per season over
> its episodes.

## How the apps fit in

- **One way in.** Nobody reaches an app directly. Every request goes to iSputnik
  first — under `/games` or `/video` on the same address — which signs the person
  in, checks they may use the app, and passes the request on. So there is one
  sign-in, one address and one certificate, and every protection iSputnik already
  has (two-factor, rate limits, blocked addresses) covers the apps too.
- **No door of its own.** An app's container needs no port open to the internet,
  and none for people: only iSputnik talks to it. The Unraid templates do
  publish the app's port on your LAN so that iSputnik can reach it there; that
  gives nothing away, since without the secret the app answers everyone 401.
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
- **A published port**, which the Unraid templates do by default: the container
  stays on `bridge` and publishes its port (4200 for games), and iSputnik reaches
  it at `http://<your Unraid IP>:4200`. Nothing to create; the other two layouts
  work as well, and the mapping is then simply unused.

## 2. Install the app's container

### Games

On Unraid, install **isputnik-games** from Community Applications (or add the
template from the [isputnik.games repository](https://github.com/isputnikdotnet/isputnik.games)).
Its **Gateway Secret** field is required, so make the secret first: open
**Control panel → Settings → Apps → Games**, press **Generate secret** and
**Copy** (it is shown once), and paste it into the field. Keep **Config & Data**
(`/config`) on your appdata share; it holds the matches, scores and the games'
own log of events. Then come back to the same page for step 3: the address is
`http://<your Unraid IP>:4200` as installed.

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

### Faces

The face engine finds the faces in your photos so iSputnik can group them into
people. It keeps nothing: iSputnik sends it a photo and stores every face,
name and person itself, so there is no folder to mount and nothing of it in a
backup. Give its container:

| Setting | Value |
|---|---|
| Image | `ghcr.io/isputnikdotnet/isputnik.faces` (on Unraid, the template `isputnik-faces.xml` in the [isputnik.faces repository](https://github.com/isputnikdotnet/isputnik.faces)) |
| Network | the same network as iSputnik, or a fixed IP; **no port published** |
| `GATEWAY_SECRET` | empty for now — you'll fill it in step 3; until then the container stops as soon as it starts |
| CPU threads | optional: all cores but one by default, so the box stays responsive during a scan |

Without a paired Faces container there is no face recognition (since 4.65.1
iSputnik's own image carries no face models): the Face recognition window says
so, with a link here, and the switches stay off until one is paired. The people,
names and faces already found are kept and keep working — only finding new
faces needs the container. Once it is paired, the next scan uses it, and nothing
is scanned again.

## 3. Connect them on Settings → Apps

Everything on iSputnik's side is done here: nothing to change on the iSputnik
container, and no restart. Open **Control panel → Settings → Apps** and choose
the app.

1. Under **Where the container is**, type the app's **Address** and press **Save
   address**: `http://isputnik-games:4200`, `http://isputnik-video:4300` or
   `http://isputnik-faces:4400` on a shared network, or `http://<its IP>:4200` /
   `:4300` / `:4400` with fixed IPs. It is how
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
- **Quality away from home** (*up to 720p* to start with). Someone watching from
  outside your network gets at most this picture, made smaller while they watch,
  and starts at it; the player's **Quality** menu lets them pick less. A film
  already under it is sent as it is. At home everyone gets the file as it is,
  and the same menu offers 1080p, 720p and 480p for a weak Wi-Fi corner or a
  phone; the choice is remembered in that browser, one for home and one for
  away. One viewer at 720p needs about 5 Mbit/s of your upload link; a
  Blu-ray rip sent as it is needs 30 or more, which is why the cap exists.

The card shows who is watching what right now, and how much of it sits in
memory and on the disk. Most films need well under the 300 MB; a Blu-ray rip
whose sound is converted carries its picture unchanged, so it is the one that
fills a share. Changes apply at once; anyone already watching carries on.

### Converting on the GPU

An Intel CPU's graphics (Quick Sync) convert several films at once for little
CPU. To use them, fill in the video container's optional **Intel GPU** field
with `/dev/dri` on Unraid (or pass `/dev/dri` to the container elsewhere). The
engine tries the GPU when it starts, and the **Converting video** card says what
it found: the graphics and driver, and which kinds of video they decode. Videos
they can't decode are decoded on the CPU and still converted on the GPU.

- **Where to convert**: *On the GPU where it can (automatic)* is the default; it
  moves a film to the CPU if the GPU fails it, and after three failures in an
  hour sets the GPU aside until you press **Check again**. *On the CPU only*
  never tries the GPU; *On the GPU only* fails rather than falling back, to test
  it.
- **HDR films** (HDR10, HLG) are converted to normal colours, so they don't play
  grey and washed out on an ordinary screen: on the GPU where it can, else on
  the CPU. Picture subtitles (Blu-ray, DVD) are drawn on the GPU where it can,
  too. The card says which.
- The list of who is watching says **GPU** or **CPU** beside each conversion,
  and **HDR** for an HDR film.
- Without the field, or without Intel graphics, everything is converted on the
  CPU as before, and the card says so.

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

### Editing a title

Admins have **Edit** on every film's and show's page. Its tabs:

- **Details**: the title, original title, year, the name it sorts by, and the
  description. Each field shows what the `.nfo` file, the folder name or TMDB
  gave it; type over it to change it, or leave it empty to keep what was found.
  Edits stay through every rescan; **Use what was found** hands a field back.
- **Genres**: pick the title's genres from the list kept on **Control panel →
  Library → Organization → Video genres**. With none picked it keeps the genres that were found.
- **Set** (films): which set the film is in. **As found** keeps the `.nfo`
  file's set, else TMDB's collection; **In this set** puts it into one by name
  (pick one that is there, or type a new name to make a set) at the place you
  give it; **Not in any set** keeps it out, even of TMDB's collection.
- **Lookup**: a title matched to the wrong film or show (or to none) is put
  right here. Search TMDB by name and year and pick the right one; TMDB's words
  are shown beside the title's, and the ones you tick go into Details and
  Genres. **Save** keeps them, with the match: rescans keep that match until
  **Match automatically again**. A film in several parts that TMDB has as a TV
  show (a Soviet miniseries) shows that show's episodes on its parts: their
  names, pictures and descriptions.
- **Pictures**: the **poster** is a `poster.jpg` beside the files first, then
  TMDB's. **Choose from TMDB** shows the rest of TMDB's posters, and **Upload a
  poster** puts your own over both. The **backdrop**, the picture behind a title
  at the top of the overview and on its page, is TMDB's best-voted one with no
  words on it; **Choose another** shows the rest (those with words on them marked
  with their language), or **Pick automatically again**. A picture saved beside
  the files (`fanart.jpg`) wins over TMDB's. Pictures change as soon as you
  choose them.

### Video genres

Films and shows arrive with genres from their `.nfo` files and from TMDB, often
in two languages and several spellings ("Comedy", "Комедия", "Sci-Fi & Fantasy").
**Control panel → Library → Organization → Video genres** keeps one list of your own, the way
Categories does for books, and decides what each genre a film arrives with
becomes. There are four cases:

| A film arrives with | Because | The film shows |
|---|---|---|
| Comedy | it is a **keyword** of your genre Комедия | Комедия |
| Драма | it is the **name** of one of your genres | Драма |
| Biography | it is not in your list yet | Biography, as it came |
| TV Movie | it is **hidden** | nothing |

- **Add TMDB's genres** starts the list from TMDB's own, named in English or
  Russian, with the other language's names and common spellings as keywords.
- A genre's **keywords** are its other names. One keyword can belong to two
  genres: "Sci-Fi & Fantasy" leads to both Фантастика and Фэнтези.
- **Found genres not in your list** still show on films as they came, so nothing
  disappears before you look. For each: **Add to genre…**, **Make it a genre**,
  or **Hide**.
- **Hidden genres** show nowhere: not on films, not in the filters, not on the
  TV. Nothing is removed from your files, and **×** shows one again.
- **Rename**, **Merge** and **Delete** a genre in its Edit dialog. A renamed or
  merged genre's old name stays as a keyword, so rows on Video that asked for it
  keep finding the same films. A deleted genre's name and keywords become hidden.

Nothing here changes your files, and changes show at once on every screen, the
TV app's too, with no rescan.

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

On the **Video** page, a **Sets** row shows every set you can see two or more films of, and
**View → Sets** lists them on their own.
A set's page shows its films in order — by release date, else by year — and one
**Play** that starts the first film you haven't watched yet. A film's own page
says which set it is part of, with the others beside it, and when a film of a
set ends the player offers the next one.

Each person only sees the films of a set that are in libraries they may watch:
someone who sees only *Kids* sees only that part of a set. Films you don't have
are never listed. Films matched before sets came in are asked about their set
on the next metadata pass, which follows every scan.

## Skipping intros and credits

While a show's "Previously on" recap plays, the player offers **Skip recap**, and
while its intro plays, **Skip intro** (**S** does either). When
the credits start, the card for the next episode, or the next film of a set, comes
up with its countdown; **Cancel** lets the credits play on, and pausing stops the
countdown too. A film with nothing after it shows no card, and counts as watched
from where its credits start.

The player knows where they are from, in this order:

- **A mark an admin set** in the player. **Mark intro** in the bar above the
  picture opens a panel under it: play or scrub the film to where the intro starts
  and press **Here**, then where it ends, then **Save intro**; the credits the same
  way. A mark is for the **whole season** by default, since intros usually sit at
  the same time in every episode; choose **This episode only** for one with a cold
  open that moves it. An episode's own mark wins over its season's. The coloured
  bar shows the marks as they stand, and **Clear mark** puts back what the files
  say, or what the video app found. Mark only where what it found is wrong.
  A **Recap** is marked the same way, but always for that episode alone: every
  recap is its own length.
- **Chapters inside the file**, by name: *Intro, Opening, OP, Opening Credits,
  Вступление, Заставка, Начальные титры*; *Credits, End Credits, Ending, ED,
  Outro, Титры, Финальные титры*; and *Recap, Previously on, Ранее, В предыдущих
  сериях*. Unnamed chapters say nothing.
- **An `.edl` file beside the video**, named like it (`Episode.edl`), which Kodi
  reads too and intro-skipper tools can write. Each line is `start end action`, in
  seconds or `h:mm:ss`, with action `0` or `3`. A stretch starting in the first
  third of the file is the intro; one from the second half that reaches the end is
  the credits. For a two-minute intro after a one-minute cold open and credits from
  42:00 of a 44-minute episode:

  ```
  60 180 3
  2520 2640 3
  ```

- **What the video app finds by itself**, for everything else, in the background
  after each scan. A show's **intro** is the stretch of sound its season's episodes
  share, wherever each episode puts it after its cold open; it needs three or more
  episodes, and an episode whose opening differs from the rest is left unmarked
  rather than marked wrong. The **credits** are where the picture turns to text on
  black near the end (films too), or a closing tune the episodes share. A
  **recap** is found by picture: its clips are the earlier episodes' own frames,
  so the start of each episode is compared with every episode before it that
  season (a premiere with the end of the season before). The panel says **Found
  automatically** for these; **Find again** looks at the season (or film) afresh.
  A season takes about 15 minutes the first time, most of it reading each
  episode's picture once, so a large library is a while being covered; it is
  looked at once, and again only when its files change. **Control panel →
  Settings → Video → Intros, recaps and credits** turns this off for a server
  that would rather not spend the time; what was found before still counts.

An `.edl` wins over chapters and counts as soon as it is there, no rescan needed.
Files where nothing is known play as before.

The **full-screen button** at the top right of the picture (or **F**, or a double
click) keeps Skip intro and the card on screen, and stays full screen into the next
episode. On Firefox the player's own full-screen control hides them, so use this
one; on iPhones only the phone's own full screen exists, and they don't show there.

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
[ ] App container where iSputnik can reach it: its published port, a shared network or a fixed IP
[ ] Settings → Apps: address saved, and the Container line says it answers
[ ] Settings → Apps: secret generated, pasted into the app's GATEWAY_SECRET, app restarted
[ ] Settings → Apps: Test connection says Paired
[ ] Security → App access: who may use it, and from where
[ ] Video: media folder mounted read-only, libraries added on Library → Libraries
```
