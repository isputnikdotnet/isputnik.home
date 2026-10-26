# Video — architecture (draft for review)

How isputnik.home works with the video container (`isputnik.video`), including
video libraries in the digital library. Short form; the full plan with phases is
`docs/apps-platform-plan.md`.

Status: draft, 2026-10-25. Nothing built beyond the shared gateway (phase 0).

## In one sentence

**Home owns what the family sees and manages; the video container owns the video
data and does the heavy work.**

## Picture

```
 Browser / PWA / TV app
        │  (only door: session cookie or device token)
        ▼
┌──────────────────────── isputnik.home ────────────────────────┐
│ Screens: Video browse, show page, player (home's web app)     │
│ Library → Libraries: video libraries next to books & photos   │
│ Access: who sees which video library (assignments)            │
│ Tags, categories → point at video items by id                 │
│ Gateway /video/* : checks who + from where, signs headers     │
│ Backup: one zip, home DB + video DB                           │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTP over the Docker network, signed with a secret
                ▼
┌──────────────────────── isputnik.video ───────────────────────┐
│ No screens. Its own SQLite.                                   │
│ Scans folders, reads .nfo, asks TMDB                          │
│ Catalog: shows, seasons, episodes, movies, posters            │
│ Watch progress per person                                     │
│ Playback: direct / remux / transcode (ffmpeg, HLS)            │
│ Later: Stremio add-on, WebDAV for Kodi                        │
└───────────────┬───────────────────────────────────────────────┘
                │ read-only mount
                ▼
           /media (the video files)
```

## Who keeps what

| Data | Home | Video |
|---|---|---|
| Video library list (name, folder, settings) | ✔ source of truth | copy, kept in sync by home |
| Who may see each library | ✔ | — (told per request) |
| Shows, seasons, episodes, movies, metadata | — | ✔ |
| Posters and artwork | — | ✔ (cache) |
| Watch progress, watched marks | — | ✔ |
| Fix-match choices, TMDB key | — | ✔ |
| Tags on videos | ✔ (by video id) | — |
| Categories (genre mapping) | ✔ (by video id) | raw genres only |
| The video files | — | read-only, never written |

Home never opens a video file. The video container never stores users, groups
or permissions.

## How they talk

**Browser → home → video.** Every request goes to home under `/video/…`. The
gateway checks the session (or a device token), applies the network rule, then
forwards it with signed headers:

| Header | Says |
|---|---|
| `X-Isputnik-User-Id`, name, language | who is asking |
| `X-Isputnik-App-Role` | `member` or `manager` in video |
| `X-Isputnik-Libraries` | the video libraries this person may see |

The container filters everything by `X-Isputnik-Libraries`. That is its whole
permission model.

**Home → video (admin calls, signed).** Home's server calls these itself:

| Call | When |
|---|---|
| `PUT /api/admin/libraries/:id` | a video library is created or changed in home |
| `DELETE /api/admin/libraries/:id` | it is deleted in home |
| `POST /api/admin/libraries/:id/scan` | Scan now |
| `GET /api/admin/libraries` | counts, scan state, errors for the Libraries page |
| `GET /api/admin/folders?path=` | folder picker in Add library (the container's `/media`) |
| `POST /api/items/lookup` | titles and posters for tag and category pages |
| `GET /api/admin/backup` | database snapshot for home's backup |

**Video → home: never.** Home always asks; the container only answers.

## The main flows

**Create a video library.** Library → Libraries → Add library → Video. The
folder picker browses the container's folders. Save writes home's row and calls
`PUT /api/admin/libraries/:id`; the container scans it.

**Browse.** Home's Video page (same toolbar, filters, A–Z as every library)
calls `/video/api/shows?…`. The container answers only from the libraries in
the header.

**Play.** Home's player asks `/video/api/play/:id` with what the browser can
decode. The container answers direct play, remux or transcode and serves the
stream; home's gateway passes the bytes through.

**Tag or categorise.** Stored in home's `taggables` / a small
`remote_item_categories` table, keyed by the video id. Tag and category pages
fetch titles and posters with `/api/items/lookup`.

**Continue watching on For you.** Home asks `/video/api/summary` and shows the
cards.

**Backup.** Home's backup asks the container for a snapshot of its database
and stores it in the same zip (`apps/video.db`). Files and the poster cache are
not backed up. Restore puts home back, then offers to send the video database
back from Apps → Installed.

**Container down.** Video pages say "Video is not available right now"; the
rest of home works. Library rows and access stay editable in home.

## Safety rules

- The container is never reachable from outside; only home talks to it.
- The secret proves a request came from home; client-sent `X-Isputnik-*`
  headers are dropped.
- Media is mounted read-only.
- A library home stops listing is only *detached* in the container (kept 30
  days), never deleted on sync — so restoring an older home backup cannot wipe
  newer watch progress. Only an explicit delete from home removes it.

## Why this split

- **Resources:** ffmpeg and big scans run in their own container; it can be
  CPU-limited in Unraid without touching home.
- **Code size:** scanner, TMDB, transcoding, HLS and Stremio live in their own
  repository.
- **One place to manage, one look:** libraries, access, tags and the screens
  stay in home, so video is managed and looks like every other library.

## Open questions for review

1. **Watch progress in the container** — right place, or should home keep it
   with audiobook progress so "Continue" rows are one query?
2. **Categories for films** — worth it, or tags only at first?
3. **Streaming through home** — fine on the LAN; revisit if a remote viewer
   shows home's CPU or bandwidth is the bottleneck.
4. **One video library per type** (Shows, Movies) or mixed libraries the
   container sorts itself?
