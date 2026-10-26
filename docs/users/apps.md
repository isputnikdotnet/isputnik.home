# Adding the games and video apps

Some parts of iSputnik run in containers of their own, beside the main app:
**Games** (family board and arcade games) and **Video** (TV shows and movies). You
install each one like any other container, then connect it to iSputnik in
**Control panel → Apps**. This guide is for whoever runs the server.

> **Video is arriving in stages.** The video engine and its connection to iSputnik
> (pairing, access, backups) are built. Adding video libraries on Library →
> Libraries, the family's pages (Shows, Movies, the player) and the engine's
> published image come in the next releases; the Video steps below apply from
> then.

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
Leave **Gateway Secret** empty for now — you'll fill it in step 4. Keep
**Config & Data** (`/config`) on your appdata share; it holds the matches,
scores and the games' own log of events.

With compose, add the service from the games repository's `docker-compose.yml`
to the same file as iSputnik, so both share its network.

### Video

The video engine reads your video folders and never writes to them. Give its
container:

| Setting | Value |
|---|---|
| Image | `ghcr.io/isputnikdotnet/isputnik.video` (once published) |
| `/media` | your video folder, **read-only** (for example `/mnt/user/data/video`) |
| `/config` | an appdata folder: the catalog database and poster cache |
| Network | the same network as iSputnik, or a fixed IP; **no port published** |
| `GATEWAY_SECRET` | empty for now — you'll fill it in step 4 |

Lay the folders out the way Jellyfin and Kodi read them — `Show (Year)/Season
01/Show (Year) S01E01.mkv` for shows, `Movie (Year)/Movie (Year).mkv` for films.
`.nfo` files beside them are read first.

## 3. Tell iSputnik where the app is

On the **iSputnik** container, set the app's address and restart it:

| App | Variable | Example |
|---|---|---|
| Games | `GAMES_URL` | `http://isputnik-games:4200` |
| Video | `VIDEO_URL` | `http://isputnik-video:4300` |

The address is how iSputnik reaches the app, not how your browser does. Every
variable is in the
[configuration reference](https://github.com/isputnikdotnet/isputnik.home/blob/main/docs/configuration.md#apps).

## 4. Pair them on Apps → Setup

Open **Control panel → Apps → Setup** and choose the app.

1. **Where the container is** shows the address from step 3 and whether the app
   answers. If it says *Not answering*, check the address and that both
   containers are on the same network.
2. Under **The shared secret**, press **Generate secret**. It is shown **once** —
   press **Copy**.
3. Paste it into the app container's `GATEWAY_SECRET` (the **Gateway Secret**
   field on Unraid), apply, and let the container restart.
4. Press **Test connection**. **Paired** means the app answers and accepts
   iSputnik's secret.

iSputnik keeps the secret encrypted with its server key, so a copy of its database
— a backup, say — doesn't carry it. The secret works the moment it is made: no
restart of iSputnik is needed.

**Replace secret** makes a new one; the old one stops working at once, so the app
is unavailable until its container has the new one. **Forget secret** turns the app
off for everyone until it is paired again.

> **Prefer environment variables?** Set the secret on the iSputnik container as
> `GAMES_GATEWAY_SECRET` or `VIDEO_GATEWAY_SECRET` (a long random string, e.g.
> `openssl rand -hex 32`) and the same value as the app's `GATEWAY_SECRET`. A
> secret set this way always wins, and Setup then says pairing is off.

## 5. Choose who may use it, and from where

**Control panel → Apps → Access**, for the chosen app:

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

## 6. Check that it's healthy

- **Apps → Installed** — one card per app: running or not, its version, its
  address, and whether it accepts iSputnik's secret.
- **Apps → Events** — what the app recorded about itself: refused callers,
  matches, scans, errors.
- **Apps → Logs** — the newest lines of the app's own log, what `docker logs`
  would show, without a shell on the host.

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

## Backups

**Full** and **minimal** backups (Control panel → Maintenance → Backup) also ask
each paired app for a copy of its database and keep it inside the same zip — the
games' matches and scores, the video catalog and watch progress. Media files and
an app's caches are never included. If an app can't hand its database over, the
backup still finishes and its log line says which app was left out and why.

## Turning an app off

- **For the menu only:** Control panel → Settings → Appearance → Sections, switch
  **Games** or **Video** off. The app disappears for everyone; nothing is deleted.
- **For good:** remove `GAMES_URL` / `VIDEO_URL` from the iSputnik container and
  restart it, then remove the app's container.

## When something goes wrong

| What you see | What it means |
|---|---|
| Installed: **not answering** | iSputnik can't reach the address. Check the container is running, the address and port, and that both are on the same network (not Docker's default `bridge`). |
| Installed: **refuses this server's secret**, or members see "Not signed in" in the games | The two secrets differ. Generate a new one on Setup, paste it into the app's `GATEWAY_SECRET` and restart the app. |
| Setup: **Set in this container's environment** | `GAMES_GATEWAY_SECRET` / `VIDEO_GATEWAY_SECRET` is set on iSputnik and wins. Use the same value on the app, or remove it to pair on Setup. |
| A rule refuses everyone from outside | Behind a reverse proxy whose trust isn't set up, every visitor counts as outside. Set `TRUST_PROXY` — see [Exposing your library to the internet](exposing-to-the-internet.md). |

## Checklist

```
[ ] App container on the same network as iSputnik (or a fixed IP), no port published
[ ] GAMES_URL / VIDEO_URL set on the iSputnik container, iSputnik restarted
[ ] Apps → Setup: secret generated, pasted into the app's GATEWAY_SECRET, app restarted
[ ] Apps → Setup: Test connection says Paired
[ ] Apps → Access: who may use it, and from where
[ ] Video: media folder mounted read-only, libraries added on Library → Libraries
```
