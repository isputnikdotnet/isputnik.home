# isputnik.home

A private, self-hosted family audiobook & ebook library. Scan your media, browse by
series / author / narrator / category, share with household members, and listen in a
built-in player — installable to your phone as an offline-capable app.

## Features

- **Audiobook & ebook libraries** — folder scanning, metadata lookup, cover art, series & people.
- **Built-in player** — chapters, bookmarks, playback speed, resume, progress tracking.
- **Sharing & accounts** — multi-user, groups, invites, guest share links.
- **Control panel** — libraries, users, storage, backups, maintenance jobs.
- **Installable PWA** — add to your phone's home screen; works offline.
- **Offline listening** — download a book to the device and play it with no connection.
- **Progress sync** — positions saved offline flush to the server on reconnect.
- **OS media controls** — lock-screen / car / Bluetooth play, pause, skip, and scrubbing.

## Deploy with Docker

Published to GHCR as `ghcr.io/isputnikdotnet/isputnik.home`. Minimal `docker-compose.yml`:

```yaml
services:
  isputnik:
    image: ghcr.io/isputnikdotnet/isputnik.home:latest
    container_name: isputnik
    restart: unless-stopped
    ports:
      - "4000:4000"
    environment:
      APP_URL: https://isputnik.example.com   # how you reach the app
      COOKIE_SECURE: "true"                    # "true" when served over HTTPS
    volumes:
      - /path/to/appdata/isputnik:/config      # database, thumbnails, metadata
      - /path/to/library:/media:ro             # your audiobook/ebook files (read-only)
```

On first run, open the app and create the setup admin.

### Key environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | `http://127.0.0.1:5173` | Public URL of the app (CORS / cookies) |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `PORT` | `4000` | Listen port |
| `SESSION_DAYS` | `14` | Login session lifetime |
| `INVITE_DAYS` | `7` | Invite link lifetime |

All persistent state lives under `/config`; media is mounted read-only under `/media`.

## ⚠️ HTTPS is required for the app/offline features

The PWA — install prompt, offline app shell, offline downloads, and media controls —
relies on a **service worker**, which browsers only run in a **secure context**: over
**HTTPS**, or on `localhost` / `127.0.0.1`.

Reaching the server by **plain HTTP on a LAN IP** (e.g. `http://192.168.1.10:4000`)
means the service worker won't register: no install, no offline. To use these features
over the network, put the app behind TLS — a reverse proxy (Caddy, Nginx Proxy Manager,
Traefik), a Cloudflare Tunnel, or Tailscale HTTPS all work — then set `COOKIE_SECURE: "true"`.

## Install on your phone

### Android (Chrome)
1. Open the app's **HTTPS** URL in Chrome.
2. Tap the **Install** prompt the app shows, or use Chrome's menu (**⋮ → Install app** / **Add to Home screen**).
3. Confirm. The icon lands on your home screen and opens full-screen.

### iPhone / iPad (Safari)
1. Open the app's **HTTPS** URL in Safari.
2. Tap **Share → Add to Home Screen → Add**.
3. **Launch it from the home-screen icon** (not a Safari tab) — iOS only grants offline
   storage and background audio to the installed app, and a regular Safari tab can evict
   downloads after a few days.

## Offline listening

1. Open a book and tap **Save offline** — its chapters download into the app.
2. Manage what's stored under **User menu → Downloads** (storage meter + remove).
3. Play with no connection — the player streams from local storage; your position is kept
   locally and synced to the server when you're back online.

## Local development

```bash
npm install
npm run dev        # server (4000) + web (5173) together
npm run build      # production build of both
npm run typecheck
```

> Note: the service worker is disabled in `vite dev`. To exercise PWA/offline behaviour
> locally, run `npm run build` then `npm run preview --workspace apps/web`.

## Releases

Pushing a `vX.Y.Z` git tag triggers the GitHub Actions workflow that builds and publishes
the Docker image to GHCR (tagged with the version and `latest`).
