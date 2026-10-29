# Stremio add-on — plan (draft for review)

Phase **3** (home) and **V3** (engine) of `docs/apps-platform-plan.md`, worked out.
Background: `docs/video-architecture.md`.

Status: 2026-10-29. S0 spike done (*What the spike showed*); S1 (home) built the
same day, uncommitted at the time; S2 (engine) not started.

## In one sentence

**Each member gets a personal add-on link; Stremio becomes a player for this
server's video libraries and nothing else.**

## Decisions (owner, 2026-10-29)

- **Our own ids, never IMDb ids.** The add-on answers catalog, meta, search, stream
  and subtitles itself. Stremio's Cinemeta is not needed — family videos have no
  IMDb entry, and Cinemeta is never told what the family watches.
- **Stremio shows only iSputnik.** The default catalogs are removed from the
  member's Stremio account (see *Cleaning a Stremio account*).
- **Every install is its own add-on.** iSputnik is public; two servers must never
  share an add-on id or item ids (see *Identity of an install*).

## What the spike showed (S0, 2026-10-29)

A hand-written add-on with the planned paths and ids (`D:\Demo\stremio-spike`,
outside both repositories), tried on Stremio desktop (Windows), Android and a
Fire TV (AFTKRT, Android 11) through a temporary Nginx Proxy Manager host.

- **HTTPS only.** Stremio refuses a plain-`http` add-on on a LAN address without
  even requesting it; `http://127.0.0.1` is the only exception. A real install
  needs home's HTTPS address — which it has anyway.
- **Home network only works.** With internal DNS pointing the domain at the LAN,
  the TV's requests reached the proxy from `192.168.1.x`, so `devices` keeps
  *Home network only* as its default. Owners without internal DNS (hairpin NAT)
  must relax it — the guide says so.
- **Original files play.** On the TV: MKV H.264/AAC, MP4, HEVC 10-bit with 5.1 AC3,
  embedded and sidecar subtitles (Cyrillic correct), next episode, and a real
  1 GB film with a Cyrillic file name. Desktop plays the same through libmpv.
- **An undecodable file crashes Stremio on the TV** instead of showing an error
  (test episodes in H.264 High 4:4:4). So a converted stream is not "later" — see
  *Streams*.
- **How clients read.** One open-ended `Range` per playback and one more per seek.
  Stremio's own streaming server also does a HEAD, the first and last 64 KB (the
  OpenSubtitles hash) and an ffmpeg probe (`Lavf`) per playback, then asks
  `subtitles/…` again with `filename`, `videoSize` and `videoHash` extras. Progress
  cannot be guessed from this (open question 4 is closed).
- **Paging.** The TV asks catalogs with `skip=` in uneven steps (1, 3, 4…); catalogs
  must honour any `skip`.
- **Row names.** The Board shows `<catalog name> - Movie` / `- Series`; catalog names
  must read well with that suffix (the library's name, not "Movies").
- **Cinemeta can stay for now.** Our rows, meta and streams work with it installed;
  removing it only tidies the account and is tested with the guide in S3.

## Picture

```
 Stremio (Fire TV, Android TV, phone, desktop)
        │  https://<home>/video/stremio/<token>/…
        ▼
┌──────────────────────── isputnik.home ────────────────────────┐
│ Gateway: token in the path → its owner (api_tokens,           │
│   scope video-stremio) → the `devices` network rule →         │
│   signed identity headers, X-Isputnik-Via: token,             │
│   X-Isputnik-Libraries as for a session                       │
│ Profile → Stremio: create / revoke the link, install button   │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌──────────────────────── isputnik.video ───────────────────────┐
│ stremio.ts: manifest, catalog, meta, stream, subtitles, art   │
│ Answers only from X-Isputnik-Libraries, like every route.     │
│ Never sees or stores the token.                               │
└───────────────────────────────────────────────────────────────┘
```

## Identity of an install

Two things in an add-on must be unique across every iSputnik in the world:

| What | Value | Why |
|---|---|---|
| manifest `id` | `net.isputnik.home.<serverId>` | Stremio tells add-ons apart by it; a member of two servers must be able to install both |
| item ids | `isp-<serverId>:<engineId>` | Stremio keys Continue watching, Library and progress by item id, and routes a meta/stream request to every add-on whose `idPrefixes` match |
| manifest `name` | `iSputnik · <host of APP_URL>` (home has no site-name setting) | so someone with two servers can tell them apart |

`<serverId>` is home's existing random install id — `getServerId()`, today in
`modules/familytree/package/export.ts` (`app_settings.server_id`, 16 chars, made on
first use). It moves to `core/server-id.ts`: a per-install id is platform, not a
family-tree feature. Nothing to register anywhere; Stremio has no central list.

It survives restarts, upgrades and a restore onto new hardware (so everyone's
Continue watching keeps working). A database *copied* into a second install (the
demo site) inherits it — harmless unless one Stremio account adds both. If that
ever matters: an admin "Reset server id" that knowingly breaks existing links.

Home sends the engine what it needs on token routes only:

| Header | Value |
|---|---|
| `X-Isputnik-Via` | `token` |
| `X-Isputnik-Site-Id` | `<serverId>` |
| `X-Isputnik-Site-Name` | the site name, URI-encoded |
| `X-Isputnik-Base-Url` | `<APP_URL>/video/stremio/<token>` — the engine needs absolute URLs for streams, art and subtitles, and must not build them from client-sent `Host` |

The token appears in `X-Isputnik-Base-Url` because Stremio fetches stream and art
URLs as given; that header is signed like the rest, and the engine never stores
it. It is the only place the engine sees the token.

## Routes (engine, under `/video/stremio/<token>/`)

The Stremio add-on protocol; all JSON with `Access-Control-Allow-Origin: *`.

| Route | Answers |
|---|---|
| `manifest.json` | id, name, version, `resources` (catalog, meta, stream, subtitles), `types` (`movie`, `series`), `idPrefixes`, catalogs, logo from home's brand |
| `catalog/movie/isp-movies[/<extra>].json` | films in the member's libraries; extras `search`, `genre`, `skip` (any offset — the TV sends 1, 3, 4…), 100 a page |
| `catalog/series/isp-shows[/<extra>].json` | shows, same extras |
| `catalog/<type>/isp-continue.json` | **Continue watching from iSputnik's own progress** — what was started in the browser shows up on the TV |
| `meta/<type>/<id>.json` | title, poster, background, description, year, genres; for a series `videos[]` with season, episode, title, still, released |
| `stream/<type>/<id>.json` | the original file (`url`, `behaviorHints.filename`, `videoSize`, `notWebReady` for non-MP4, `bingeGroup` per show for next-episode) |
| `subtitles/<type>/<id>[/<extra>].json` | sidecars (and text tracks the player would not show) as WebVTT URLs; `lang` as ISO 639-2 (`eng`, `rus`) — what Stremio's menu names; the `filename`/`videoSize`/`videoHash` extras are ignored |
| `play/<id>` | the file bytes with Range — the existing `stream` route under the token prefix |
| `art/<id>/<kind>` · `subs/<id>/<name>` | the existing art and subtitle routes under the token prefix |

Catalogs are per library, named after it ("Family films" → the Board's
"Family films - Movie"), and only those the member can see are in the manifest.
The manifest is built per request, so a change in access shows the next time
Stremio fetches it.

**Streams.** The first stream is always the original file — it played everywhere
in the spike, HEVC and AC3 included. Because a file the TV cannot decode crashes
Stremio rather than failing politely, the engine adds a second, **Converted**
stream (the existing HLS transcode, H.264 + AAC) and lists it *first* when its
probe (`media-probe.ts`) finds a format TVs are known to refuse: H.264 in 4:4:4 or
4:2:2, H.264 10-bit (Hi10P), VC-1, MPEG-2, and anything it could not identify. The
list stays a short table in the engine, grown from reports. One transcode per
person and the household cap apply as for the browser player.

## Home side

- **Token scope** `video-stremio` in `core/api-tokens.ts` (`ApiTokenScope`).
- **Gateway**: the video registry entry gets the `devices` capability
  (`/video/stremio/`). The video module's `admitWithoutSession` hook takes the token
  from the path, resolves it with `resolveApiToken(raw, "video-stremio", ip)`, and
  `identityFor` forwards the owner as for a session — access to the video
  container and the library assignments are worked out per request, so a change
  in access applies to the next request. A revoked token gets 401; unknown
  tokens count against the address like OPDS (`isUnknownApiToken`).
  The path forwarded to the engine keeps the token segment (the engine ignores it).
- **Network rule** for `devices`: *Home network only* by default (the spike
  confirmed it with internal DNS); the guide tells owners without internal DNS to
  set it to *Trusted networks* or *Anywhere* in Security › App access.
- **Profile → Stremio** (the person's own, so Profile, not the control panel): one
  card per link — label, created, last seen, Revoke. Create shows the link once,
  with **Install in Stremio** (`stremio://…/manifest.json`), Copy link, and a QR
  code. TVs need no typing: the add-on syncs from the member's Stremio account, so
  installing on the phone puts it on the TV.
- **Security › App access** lists every Stremio link for revoking (the admin list
  the platform plan promised for container tokens).
- Search terms in `search-index.ts`; strings in `en` + `ru`; `check:ui`.

## Cleaning a Stremio account

Cinemeta and Local Files are "protected" in Stremio's own UI. The account's add-on
list lives on Stremio's servers (`addonCollectionGet` / `addonCollectionSet` on
`api.strem.io`) and can be rewritten — which is what community add-on managers do.

First cut: the guide in `docs/users/` walks through it (uninstall the rest; remove
Cinemeta with an add-on manager, or keep it and strip its catalogs). Local Files
can stay — it shows nothing unless local files are played.

Later, maybe: a **Clean this Stremio account** step in Profile that signs in to
Stremio *from the browser* (never through home's server, never stored), sets the
collection to iSputnik + Local Files, and signs out. It needs `api.strem.io` in
the CSP's `connect-src` and is unofficial — a Stremio update can restore the
defaults. Open question 3.

## What Stremio cannot do

- **Progress does not come back.** Stremio keeps its own watch state in its cloud
  and never reports it to add-ons. Watching on the TV does not move iSputnik's
  Continue watching. (The other way works: `isp-continue` above.)
  The family's viewing history on Stremio's servers is the cost.
- **No per-profile switch.** One Stremio account is one member; a shared TV account
  sees what that member sees.

## Phases

| Phase | Where | What |
|---|---|---|
| **S0** | spike | **done 2026-10-29** — see *What the spike showed* |
| **S1** | home | **built 2026-10-29**: `core/server-id.ts`; `video-stremio` scope; `devices` capability (Home network only); the gateway's `userFromToken` hook (`modules/library/video/stremio.ts`) with the site headers; Profile › Security › Stremio; Stremio links on Security › App access; the token masked in home's log, the proxy's line included; `test/video-stremio.test.ts` |
| **S2** | engine | the engine's own log masks `/video/stremio/<token>` like home's; `stremio.ts`: manifest with a catalog per library, catalogs with search/genre/any `skip`, meta, the original stream plus Converted for formats TVs refuse, subtitles, the token-prefixed play/art/subs; tests against the protocol's shapes |
| **S3** | both | `isp-continue`; user guide `docs/users/stremio.md` (listed on the Help page — `check:ui`) with removing Cinemeta and the network-rule note, screenshots; release engine + home together |
| later | | Clean this Stremio account |

## Open questions

1. ~~Network rule vs HTTPS~~ — settled by S0: *Home network only* by default,
   relaxed by owners whose domain does not resolve to the LAN inside the house.
2. **Server id from home or from the engine?** Planned: home's (it is the install the
   family knows, and it already exists). The engine's ids change if its database
   is reset anyway, so either is honest.
3. **Clean this Stremio account in the app** — worth building, given it is
   unofficial and handles a Stremio sign-in in our page?
4. ~~Guessing progress from stream requests~~ — dropped after S0: players read one
   open-ended range per playback, which says nothing about how far anyone got.
