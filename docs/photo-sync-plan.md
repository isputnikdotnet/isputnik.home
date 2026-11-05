# Photo Sync — project plan

Status: architecture agreed with the owner (2026-11-05); phase 0 (spike) done and run against
PhotoSync for Android; **phase 1 (personal libraries) built 2026-11-05, not yet released**; **phase 2
(phone-sync networks and devices) built 2026-11-05, not yet released**; **phase 3 (the sync endpoint)
built 2026-11-05 and live-checked with PhotoSync for Android, not yet released**; **phase 4
(status, admin view and guide) built 2026-11-05, not yet released**; phase 5 next. Each phase below is carried out in its own
session, in order, and ends in something shippable. Written from the "iSputnik Home – Photo
Sync" brief. Companion to [gallery-library.md](gallery-library.md),
[photo-inbox-proposal.md](photo-inbox-proposal.md), [uploads.md](uploads.md), [auth.md](auth.md),
[permissions.md](permissions.md) and [system-data-plan.md](system-data-plan.md). As in the other
plans, decisions are recorded so they need not be argued again, and open questions are recorded
so whoever writes the code first does not settle them quietly. The Immich migration
([immich-migration-plan.md](immich-migration-plan.md)) is on hold until this plan is done.

## Goal

A family member's phone, Android or iPhone, copies every new photo and video into **their own
private library** on iSputnik Home, at original quality, without them doing anything, and
**without iSputnik shipping a phone app**. A photo deleted on the phone stays at home. **Security
is the main concern**: phones sync only from networks the admin trusts, each phone with its own
revocable key, into a library nobody else — admins included — can see.

## The architecture in one paragraph

A member turns on a **personal library** from Profile (if the admin allows it): an ordinary
gallery library marked as theirs, visible to them alone. They add a phone to it and get a
**device token**. Home serves a small **WebDAV endpoint itself** (`/dav/…`, no new container);
a request is accepted only when it comes **from a phone-sync network** (an admin-kept list,
checked the way trusted networks are) **and** carries a live device token as its Basic-auth
password. **PhotoSync** (iOS and Android) is the app we document and test against; FolderSync is
the Android alternative. Uploads only add files (`DELETE` is refused). Every file lands in the
member's personal library, filed by capture date, and the endpoint records what each device sent
so that a retry or a reinstall never makes a second copy.

## Decisions taken

1. **Inside home, not a container.** A container makes sense when the engine owns its own data
   and home only proxies to it (games, video, faces). Photo Sync owns nothing: every write lands
   in a home library, is authorised by home's tokens and access rules, and is catalogued by home's
   scanner. As a container it would need home's database, library paths and permission model
   passed to it, or a second upload hop — all cost, no isolation gained. Code lives in
   `modules/library/gallery/sync/` (WebDAV, devices) and `modules/library/gallery/personal/`
   (personal libraries). The CLAUDE.md core/modules rule holds: nothing photo-specific goes in
   `core/`.

2. **Phones sync only from phone-sync networks — and still need a token.** *(Owner, 2026-11-05.)*
   - A new admin-kept list, **phone-sync networks** (CIDRs with labels), separate from the
     existing **trusted networks**. Trusted networks also skip MFA, lockout and rate limits;
     adding a VPN range for phones must not relax sign-in for that range. The list is offered
     pre-filled from the trusted networks ("Copy trusted networks") but is its own list.
   - **Empty list = sync off.** Nothing is open until an admin names a network; the Profile page
     says why sync is unavailable.
   - The address is believed only when it can be (the same rule as `isTrustedRequest` in
     `core/security.ts`): behind a proxy with proxy trust unconfigured, every sync request is
     refused.
   - **The address on the setup card** (Profile › My library › Phones) is typed once by an admin
     *(owner, 2026-11-05; open question 9)*: **Address phones use**, an http(s) URL such as
     `http://192.168.2.10:4000`, beside the phone-sync networks list. Home **never guesses** it —
     not from `APP_URL`, not from the request's Host header, not from its network interfaces
     (inside Docker home can't see the host's LAN address or the mapped port) — and never shows a
     public address. While it is empty the setup card says the admin hasn't set it yet; adding a
     phone still works and its token is still shown once. The admin is warned (never blocked)
     when its host is an IP outside every listed network. The security rule is unchanged: a
     request is refused unless it comes from a listed network **and** carries a live token.
   - The network decides **where from**; it is never authentication. Every request also needs a
     live device token (decision 6). A guest on the home Wi-Fi gets nothing.
   - Away from home, a member uses a VPN into the house (WireGuard, Tailscale) and the admin adds
     the VPN's range to the phone-sync list. The endpoint is never published through a public
     proxy or tunnel, and the guide does not tell anyone to. So there is no request-size cap to
     meet (Cloudflare's 100 MB limit only applied to a public tunnel), and plain `http` is
     accepted on the LAN, as it is for the web app on a LAN install; a VPN encrypts the rest.

3. **A personal library is a gallery library marked as one member's — not a new library type.**
   *(Owner, 2026-11-05.)* A new `libraries.type` would have to be taught to every gallery feature
   (thumbnails, faces, map, albums, duplicates, slideshows, Inbox moves); a marked gallery library
   gets all of them on day one, and only access changes.
   - **The marker is a new column, not `libraries.role`.** `role` is limited by a `CHECK` to
     `'inbox' | 'app-files'` and by a unique index to one library per role; a personal library is
     one *per member*. Proposed: `libraries.personal_user_id TEXT REFERENCES users(id)` with a
     unique partial index (one personal library per member). A new column needs a migration
     ([schema rule](database.md)).
   - **Only the owner can open it — not other members, not admins.** It registers an access
     override (as `system-library-access.ts` does for the system libraries): the owner is
     `manager`; everyone else, admins included, gets nothing, and the library's Access dialog
     does not offer grants. An admin sees that it exists, whose it is, its size and its devices —
     enough to plan disk space, never its contents.
   - **Nothing derived from it reaches anyone else**: not the Home feed, Timeline, Memories,
     Map, People, search, activity details or counts of another member. The owner sees it in
     their own views like any library they can open.
   - **Photos leave it only by the owner's hand**, with the existing tools: move to a family
     library (the Inbox's Keep path), album shares, download.
   - **One per member.** It holds phone backups and anything the owner uploads by hand. Each
     phone files into its own folder inside it (`<device label>/YYYY/YYYY-MM-DD/`), so a second
     phone or a reinstall stays apart.

4. **Members turn it on themselves; the admin sets the limits.** *(Owner, 2026-11-05.)*
   - **Admin, once** (control panel, inside an existing group — six is the budget): personal
     libraries allowed on/off (**off by default**); which members or groups may have one; the
     storage folder they are created under (an existing storage root); an optional size limit per
     member. Search terms go in `features/control/search-index.ts`.
   - **Member** (Profile, `PROFILE_PATHS`): a **My library** tab — Turn on (creates "<Name>'s
     library" under the admin's folder), size used against any limit, and the phone devices
     (phase 2).

5. **Face recognition is off in a personal library until its owner turns it on.** *(Owner,
   2026-11-05.)* Phase 1 builds no switch at all *(owner, 2026-11-05)*: clustering and the People
   list are global, so "visible to the owner only" needs private people of their own — a later
   phase. Until then a personal library is never scanned. Faces are the most sensitive data the app derives. When the owner turns it on,
   people found there are visible to the owner only; a face never links a personal photo into a
   family member's People page.

6. **A device token, sent as Basic auth.** New scope `photo-sync` in `core/api-tokens.ts`: one
   token per device, labelled with the device name, bound to its owner's personal library. User
   name is the member's login (display only); password is the `isp_photo-sync_…` token, shown
   once. OPDS rules (`modules/library/ebook/opds.ts`): unknown tokens are flagged as abuse,
   revoked/expired get `401` with `WWW-Authenticate`, `last_seen_at`/`last_ip` are bumped. The
   account password is never accepted (it would bypass MFA). No cookies, so `/dav` sits outside
   CSRF (the exemption the spike added stays) and nothing there reads a session. Ownership and
   the network are re-checked on **every request**, so a revoked token, a removed member or a
   network taken off the list stops the phone at once.

7. **A small DAV subset, written by us.** The Node WebDAV servers implement the whole RFC over a
   virtual filesystem and are lightly maintained; we need a handful of verbs over a namespace that
   is not a real folder (decision 8). What the spike saw PhotoSync send decides the set:

   | Verb | Behaviour |
   | --- | --- |
   | `OPTIONS` | `DAV: 1`, `Allow:` list. Unauthenticated, so clients can probe. |
   | `PROPFIND` (Depth 0/1) | Lists the device's own namespace from the record table: name, size, `getlastmodified`, `getetag` (sha256). Never lists the library. Unknown props (PhotoSync asks for CalDAV/CardDAV ones) are left out. |
   | `MKCOL` | Records a folder in the device's namespace (no folder on disk). `405` if it exists — PhotoSync re-sends it before every file and expects that. |
   | `PUT` | Streams to staging, checks, files it, records it (decision 9). `201`, or `204` for a no-op duplicate. |
   | `PROPPATCH` | Accepts `getlastmodified` (RFC 1123 **or bare unix seconds** — PhotoSync sends the latter) and stores it as the client date. |
   | `HEAD` / `GET` | Only for files this device sent; `GET` may be `403` in V1. |
   | `MOVE` | Within the device's namespace only, for clients that upload to a temp name. |
   | `DELETE` | **`403`** (upload-only). Opt-in deletions are a later phase. |
   | `LOCK` / `COPY` | `LOCK` answered with a token if a client insists; `COPY` `501`. |

8. **The device sees its own namespace; the library is filed by date.** Clients choose their own
   layout (PhotoSync creates `/<device model>/<album>/`) and decide what to send by listing the
   server. Home files every photo by capture date under the device's folder, but *answers*
   `PROPFIND` with the paths the device used, from a record table:

   ```
   photo_sync_files(id, device_id → api_tokens.id, client_path, size, client_mtime,
                    sha256, item_id → library_items.id NULL, received_at)
   UNIQUE(device_id, client_path)
   ```

   The spike proved this is load-bearing: PhotoSync lists the album folder before **every** file
   and skips names already there. If the owner deletes an item at home, the record stays (with
   `item_id` null), so the phone is not asked to send it again.

9. **A PUT is all or nothing.** Stream into a hidden `.upload-<id>` staging folder in the library
   root (as the batch upload does), enforcing the library's extension list and size cap while
   streaming, hashing as it writes (never re-reading a 4 GB video); on any error or dropped
   connection, delete the part. When complete: check `Content-Length`, check `OC-Checksum` /
   `Content-MD5` if sent, then:
   - same `client_path`, same sha256 already recorded → `204`, nothing written;
   - same sha256 already in that personal library → record it against the existing item, `201`,
     nothing written;
   - otherwise rename into `<device>/YYYY/YYYY-MM-DD/` (`dateFolderForCapture`, falling back to
     the client's date — `X-OC-Mtime`/`X-RecordTime` — before "now"), `uniqueGalleryFileName`,
     record, `scanSingleGalleryFile`, `201`.

   No answer before the file is on disk under its final name, so `201` means safe. Free space and
   the member's size limit are checked before streaming: `507 Insufficient Storage`. Thumbnail
   renders stay queued through `renderInTurn()` — a burst of uploads must never start two at once.

10. **Upload only.** Phone deletions are never mirrored in the first release. The sync models
    compared (*Research › Sync models*) leave two-way sync out for good and deletions as a later,
    opt-in phase through the Recycle Bin with a mass-deletion brake.

11. **When a member is removed, their personal library is kept.** *(Owner, 2026-11-05.)* It is
    marked orphaned, its devices are revoked, and an admin decides later (assign the files to
    someone, or delete the library through the normal confirmed delete). Nothing is ever deleted
    automatically.

12. **Sync is not backup.** The personal library is files on disk like any library, covered by
    whatever protects the owner's array; home's backups carry its database rows
    (`photo_sync_files`, devices, the library row) like any other table. The My library tab says
    it in one line: the server copy is one copy, not three.

## Phases

One session per phase, in this order; each phase starts from `main` with the previous one merged.
Every phase: `npm run typecheck`, `npm run check:ui` (UI phases), the server/web test suites for
what it touched, a browser check of any UI (admin `test@test.com` / `test1234` on the dev server),
i18n keys in `en` and `ru`, and this file updated (status line, the phase's *As built* notes, any
decision it changed). Releasing follows the usual release process when the owner asks.

### Phase 0 — Spike *(done 2026-11-05)*

A logging WebDAV endpoint (`gallery/sync/spike.ts`, off unless `PHOTO_SYNC_SPIKE=1`), a report
script, and a fake camera roll of CC0 files (`D:/Demo/media/PhoneRoll`). Run against PhotoSync
for Android; results under *Spike results*. Still worth running before phase 3 lands: PhotoSync
for iOS (Live Photos, iOS background triggers), FolderSync, and one backup over a VPN.

### Phase 1 — Personal libraries (no phones yet)

**Goal:** a member can turn on a private library that only they can see, and use it by hand
(upload, browse, move photos to a family library). Useful on its own.

- Migration: `libraries.personal_user_id` + unique partial index (decision 3).
- Access override: owner `manager`, everyone else (admins included) nothing; Access dialog shows
  no grants for it; library lists for admins show it as "Personal — <Name>" with size only.
- Make sure nothing derived reaches others: scope resolvers (`catalog-scope.ts`), Home feed,
  Memories, Map, People, search, activity. Tests that a second member **and an admin** see none
  of it anywhere.
- Face scanning skips personal libraries unless the owner turned it on (decision 5): a per-library
  setting, default off.
- Admin settings (decision 4): allowed on/off (default off), who may, storage root, size limit.
  On an existing control-panel tab, with search terms.
- Profile › **My library**: Turn on, size used, link to open it. Uses `shared/` components only.
- Member removal keeps the library, marked orphaned (decision 11).
- **Adopt an existing gallery library as a member's personal library** (admin action, confirmed;
  the admin's confirmation is enough — open question 8): the Immich migration imports each member's phone history as a
  gallery library, and that history and the phone's future uploads belong in one place. On
  adoption, grants to anyone else are removed — say so in the confirmation. (Open question 8.)
- Docs: `docs/gallery-library.md` (personal libraries section), a user guide section.

**Done when:** a member turns it on, uploads, sees their photos; another member and an admin see
nothing of it in any view or API; the admin sees name and size; removing the member leaves it
orphaned and intact.

**As built (2026-11-05).** Details in [gallery-library.md › Personal libraries](gallery-library.md#personal-libraries).

- Migration 87: `libraries.personal_user_id`, `personal_orphaned_at`, `personal_adopted_at`; one
  live personal library per member (unique partial index on non-orphaned rows). Orphaning is its own
  column because a deleted account re-issued under the same email keeps its user id and must not
  inherit the library.
- Access: one override in `gallery/system-library-access.ts` (owner `manager`, everyone else
  nothing — including an admin *previewing as* the owner, which the plan had not named).
- Code in `modules/library/gallery/personal/`: `personal-libraries.ts` (which are personal, whose),
  `route-guard.ts` (one `onRoute` hook over every `/api/library/(libraries|gallery-libraries)/:id`
  route rather than a check in each), `activity-gate.ts` (a new generic `registerActivityGate` in
  `db.ts`: entries about a personal library's photos are not written), `settings.ts`,
  `service.ts`, `routes.ts`.
- Leaks closed beyond the scopes: person grants and "photos of yourself" (`people-access.ts`),
  missing photos, video streaming, replaced originals, duplicate cleanup (incl. the Inbox check),
  statistics, the Recycle Bin (list and "empty all"), the Access dialog, face settings, the
  activity log, and item shares / guest links made by others (revoked on adoption and orphaning).
- Face recognition: off, no switch (decision 5 as amended above).
- Admin UI: **Library › Storage › Personal libraries** (open question 6): settings, the list
  (whose + size), Make a library personal, Hand over / Delete for orphaned ones. The Libraries page
  shows someone else's as "Personal — <name>" with size and no actions. Search terms added.
- Member UI: **Profile › My library** (`/profile/library`): turn on, size against the limit,
  open in the Gallery, the "one copy, not a backup" line, and a notice when it was adopted.
- Size limit enforced on gallery uploads (`507`).
- Tests: `apps/server/test/personal-libraries.test.ts` (another member and an admin through the
  scopes, map, facets, folders, memories, People, person grants, housekeeping lists, the activity
  log and the HTTP routes; adopt / orphan / hand over; turning one on).
- Guides: `docs/users/your-account.md` (My library) and `docs/users/storage.md` (the admin card).
- Not done here: [immich-migration-plan.md](immich-migration-plan.md) step 2 still describes an
  ordinary granted library; it should use **Make a library personal** when that plan resumes.

### Phase 2 — Phone-sync networks and devices (no endpoint yet)

**Goal:** everything that decides *who* may sync and *from where*, testable before a byte arrives.

- `sync_networks` table + admin card beside Trusted networks (Security group), "Copy trusted
  networks", search terms. Empty = sync off.
- The gate: `isSyncRequestAllowed(request)` — believed address (proxy rule) inside a listed
  network. Unit tests, including the misconfigured-proxy case and IPv6/IPv4-mapped addresses.
- `photo-sync` token scope bound to the owner's personal library; device label; revoke; last
  seen. Abuse flagging on unknown tokens.
- Profile › My library › **Phones**: add a phone (shows server address to type — the LAN address,
  not a public `APP_URL` — path, user name, the token once, a link to the guide), list, revoke.
  Shows "Phone sync is unavailable: no phone-sync network is set" when the list is empty.
- Member removal revokes their devices.

**Done when:** an admin lists a network, a member adds a phone and sees its setup details once,
revoking works, and the gate's tests cover allowed / not listed / proxy-unconfigured.

**As built (2026-11-05).**

- `sync_networks` in `schema.sql` (new table, no migration). Migration 88 adds
  `api_tokens.library_id` — plain TEXT, no foreign key, so a revoked phone keeps naming the
  library it wrote into (phase 3's `photo_sync_files` hang off the token) and deleting the
  library revokes its phones rather than being blocked.
- Code in `modules/library/gallery/sync/` (nothing in `core/` but the new scope name):
  - `networks.ts` — the list, **Copy trusted networks** (a one-off copy of what is missing, with
    labels), the gate (`syncGateVerdict` / `isSyncRequestAllowed`: off when empty, `proxy` when a
    forwarding header arrives with proxy trust unconfigured, else the address must be inside a
    listed network), and the admin's **Address phones use** (`parseSyncAddress`: an http(s)
    origin only; `phoneSyncAddress` splits it into the setup card's server, port and SSL;
    `syncAddressOutsideNetworks` for the warning — decision 2). Nothing is guessed.
  - `devices.ts` — `addPhone` (needs a live personal library; a name per phone, unique per
    member; at most 20), `revokePhone`, `revokePhonesOfUser` / `revokePhonesOfLibrary`, and
    `authenticatePhone(request)` for phase 3: network first (a token is resolved only inside a
    listed network), then the Basic password as a `photo-sync` token whose member is active and
    whose `library_id` is still that member's live personal library — re-checked on every
    request, so orphaning, handing over or a deactivated account stops a phone even without a
    revoke. Bumps `last_seen_at` / `last_ip`. A token matching nothing is flagged as abuse (from
    inside or outside the list); a revoked one and a missing `Authorization` are not.
  - `routes.ts` — admin `GET/POST /api/photo-sync/networks`, `POST …/copy-trusted`,
    `DELETE …/:id`, `PUT /api/photo-sync/address`; member `GET/POST /api/profile/phones`,
    `DELETE /api/profile/phones/:id`. Adding a phone while the list is empty is refused
    (`sync_off`); a missing address is not refused. The token and the setup details (server,
    port and SSL from the admin's address, `/dav/`, the member's email as user name) are in the
    `POST` answer only.
- Revoked: member removed (`DELETE /api/users/:id`), personal library orphaned, handed over
  (anyone else's phones on it), or deleted (`deleteGalleryLibraryRecord`).
- Admin UI: a **Phone-sync networks** card under Trusted networks on Security › Trusted
  networks (`PhoneSyncNetworksCard.tsx`) — list, add, remove, Copy trusted networks, the
  **Address phones use** field (warns when outside the listed networks); search entry
  `phoneSyncNetworks`.
- Member UI: **Phones** under Profile › My library (`PhonesSection.tsx`) — add (name, then the
  setup details and token once, with copy buttons), list with last seen, revoke through a
  `ConfirmDialog`; "Phone sync is unavailable: no phone-sync network is set" while the list is
  empty. The guide link points at `your-account.md#phones` until phase 4's guide exists.
- Tests: `apps/server/test/photo-sync-devices.test.ts` (gate: off, allowed, not listed, apart
  from trusted networks, unconfigured proxy, IPv6 and IPv4-mapped; copy; address; phones and
  every revoke path; abuse flagging; the HTTP routes).
- Docs: `docs/users/your-account.md` (Phones), `docs/users/control-panel.md` (the card),
  `docs/database.md`.
- Not built: an admin view of members' phones (phase 4), the endpoint itself (phase 3).

### Phase 3 — The sync endpoint

**Goal:** a phone backs up into its owner's personal library.

- `/dav` routes in `gallery/sync/` implementing decision 7, behind the gate (decision 2) and the
  token (decision 6); per-token rate limit instead of the spike's none.
- `photo_sync_files` table, the device namespace (decision 8), the PUT pipeline (decision 9),
  client-date parsing (both formats), filename-date parsing for Samsung and Pixel names.
- Remove the spike (`spike.ts`, its block in `src/index.ts`, its test); keep the `/dav`
  exemptions in `core/csrf.ts` and `core/probes.ts`. The report script may stay for debugging.
- Tests: every PUT outcome, `MKCOL` repeat, `PROPFIND` of what a device sent, auth failures,
  network refusal, path escapes, size limit / disk full (`507`), a large streamed upload over a
  real socket.
- Live check: PhotoSync for Android against the dev server with the `PhoneRoll` set — manual
  transfer, a second run (nothing re-sent), Autotransfer with a new photo.

**Done when:** the live check passes and the photos appear, dated and filed per device, in the
owner's personal library — and nowhere else.

**As built (2026-11-05).**

- Tables in `schema.sql` (new tables, no migration): `photo_sync_files` as decision 8 drew it
  (`device_id` → `api_tokens` cascade, `item_id` → `library_items` SET NULL, `UNIQUE(device_id,
  client_path)`), plus **`photo_sync_folders`** for what `MKCOL` made — the plan had not said
  where folders live. Nothing is made on disk for a phone's folder.
- Code in `modules/library/gallery/sync/`:
  - `namespace.ts` — the phone's namespace: `davPathOf` (decoded segments; `.`, `..`, `/`, `\`,
    controls and over-long paths refused → `400`), folder existence (made, or implied by
    something beneath it), listings (direct children by a key range, no `LIKE`), `MOVE` of
    records. No client path reaches the filesystem.
  - `put.ts` — decision 9. Streams into `.upload-sync-<id>/` in the library root, sha256 as it
    writes; refuses before a byte when `Content-Length` is over the library's upload cap
    (`413`), the member's size limit or the free space (`507`), and cuts the stream off when an
    unannounced body passes them. Free space keeps a 256 MB reserve; `ENOSPC` is `507` too.
    Then the length, `OC-Checksum` (MD5/SHA1/SHA256) and `Content-MD5`. Outcomes: same path +
    same sha → `204`; same bytes already in the library (a phone's record, or an item of the same
    size whose digest matches — hashed then, and kept the way the duplicate scan keeps it) →
    recorded against it, `201`; else filed into `<phone name>/YYYY/YYYY-MM-DD/`,
    `uniqueGalleryFileName`, `scanSingleGalleryFile`, recorded, `201`. The date chain is the
    gallery's — EXIF, then the file name (`filename-date.ts` already read Samsung
    `20261105_100150` and Pixel `PXL_20261102_160025120`), then `X-OC-Mtime` / `X-RecordTime`,
    then now — and the phone's date is also written as the file's mtime, the scanner's last
    resort. A `PROPPATCH` that brings the first date re-dates the item. The finishing step runs
    one file at a time per library (two phones sending one photo make one item); renders stay in
    `renderInTurn()` inside the scanner. Unfinished `.upload-sync-*` folders in personal libraries
    are swept when the plugin starts.
  - `dav.ts` — the verbs of decision 7, behind `authenticatePhone()` (network: `403` without a
    challenge; credentials: `401` with one). `OPTIONS` is open and says `DAV: 1, 2` (`LOCK` is
    answered, as the spike did for PhotoSync). `GET` is `403`, `DELETE` `403`, `COPY` `501`.
    Depth infinity is answered as 1. Rate limit **1200 requests a minute per token** (keyed on
    the token's hash; per address when no token is sent), never waived for a trusted network.
    Registered from `gallery/index.ts` as its own encapsulated plugin, so its raw-body parsers
    stay in it.
- The spike is gone: `spike.ts`, its block in `src/index.ts`, `test/photo-sync-spike.test.ts` and
  `scripts/photo-sync-spike-report.mjs` (it only read the spike's log). The `/dav` exemptions in
  `core/csrf.ts` and `core/probes.ts` stay.
- Tests: `apps/server/test/photo-sync-dav.test.ts` — paths and dates; OPTIONS; no, unknown
  (abuse), revoked token and the account password; outside the networks, a network removed, the
  misconfigured proxy, an orphaned library, path escapes; a PhotoSync-shaped run (Samsung, Pixel
  and WhatsApp names, filed and dated), repeated `MKCOL`, `204` on a repeat, the same bytes from a
  second phone and from a hand upload, no overwrite, a purged item still listed, `PROPPATCH`
  re-dating, one phone never seeing another's, `HEAD`/`GET`/`DELETE`/`COPY`/`MOVE`; `415`, `413`,
  the size limit and disk full (`507`), checksums; a 64 MB upload streamed over a real socket and
  one cut off part-way (nothing left behind).
- Docs: `docs/users/your-account.md` (where a phone's photos go), `docs/database.md`.
- **Live check (2026-11-05, passed)** — PhotoSync 4.3.7 for Android on the Galaxy Tab S10+
  (192.168.1.36) against the dev server (192.168.2.137, another subnet; phone-sync network
  `192.168.1.0/24`), Demo Admin's personal library, phone "Galaxy Tab":
  - **Manual transfer** of the `PhoneRoll` set: 44 files, 228 MB, all `201`, none refused. 43
    items under `Galaxy Tab/YYYY/YYYY-MM-DD/`, dated by EXIF or by Samsung, Pixel, screenshot and
    WhatsApp names, with previews; the roll's deliberate copy (`…~2.jpg`) recorded against its
    twin. Nothing in any other library. Per file: `MKCOL` ×2 → `PUT` → `PROPPATCH` — no
    `PROPFIND` of a folder `MKCOL` had just made.
  - **Second manual run**: PhotoSync re-sent all 44 (`MKCOL` 405 ×88, `PUT` **204** ×44,
    `PROPPATCH` ×44, 26 s) — nothing written, still 44 files. A manual transfer of an album does
    not list the server first, so the bytes cross the LAN again; nothing is stored twice.
  - **Autotransfer** with one new photo: sent about 1½ minutes after it was taken, and only that
    one (`MKCOL` 405 ×2, `PUT` 201, `PROPPATCH`), filed under `Galaxy Tab/2026/2026-11-05/`.
- Left for later: a client that uploads to a temporary name of a type the library doesn't take
  (`x.jpg.part`) and then `MOVE`s it is refused `415` at the `PUT` — PhotoSync doesn't; check
  FolderSync in phase 5. Status per phone (last error, counts) is phase 4.

### Phase 4 — Status, admin view and guides

**Goal:** a member can see that backup is working; an admin can see that it is used.

- Per device: last contact, last photo received, files and bytes (24 h / total), last error and
  when ("Disk full", "File type not allowed: .dng"). Activity log entries with the device id.
- Admin: each member's page lists their devices and personal library size; a card on
  Library › Storage totals personal libraries. No new control-panel group.
- User guide `docs/users/phone-backup.md` (listed on the in-app Help page — `check:ui` checks
  it): PhotoSync setup on Android and iPhone, the foreground first backup on iPhone, Samsung
  battery settings (Unrestricted, not in Sleeping apps), Wi-Fi-only Autotransfer, the VPN note.
  Screenshots from the demo site only (no personal photos — use `PhoneRoll`).

**Done when:** status reflects a real run, the guide is on the Help page in both languages.

**As built (2026-11-05).**

- **Per-phone status** (`sync/status.ts`): last contact is the token's `last_seen_at`; the last
  file received and files/bytes in the last 24 h and in all are read from `photo_sync_files` when
  someone looks — nothing is written for a request that went well, and `MKCOL` 405s and `204`
  repeats never count. Only a problem is written, to **`photo_sync_device_status`** (one row per
  phone, new table in `schema.sql`): a code and a detail that is never a file name (the type,
  `.dng`; or the address a refused request came from), at most once a minute per phone and
  problem (in-memory throttle). Codes: `not_listed`, `proxy`, `type`, `too_large`, `quota`,
  `disk_full`, `incomplete`, `checksum`, `library_unavailable`, `server_error`; `PutRefused`
  now carries one. A request refused by network still gets the same `403`, but if its token is a
  live phone the refusal is noted against that phone (without bumping last contact) — so "Refused:
  not from a phone-sync network (10.6.0.3)" reaches the owner; sync turned off altogether is not
  noted (the Phones list says so already).
- **Activity log** (the plan's "entries with the device id"): `photo_sync.refused` /
  `photo_sync.failed` with `target_type = photo_sync_device` and the phone's id, only for
  device-level problems (`not_listed`, `proxy`, `quota`, `disk_full`, `library_unavailable`),
  at most once an hour per phone and problem, never a file name. A refused file type is the
  owner's business and is not logged. `registerActivityGate` (phase 1) was checked: it drops
  every entry about a personal library or its items (the scanner's "photos missing" included) and
  lets these through, since their target is the phone.
- **Privacy line** (decision 3): the owner sees everything above; an admin sees, per phone, its
  name, when it was added, last contact and a device-level problem — **no counts of what was sent,
  no file names, no file-type problems** — and the library's size.
- **Member** (Profile › My library › Phones): each phone shows last contact and last file, the
  24 h and all-time lines, and the last problem — a warning notice while nothing has arrived since,
  a quiet "Earlier problem" line once photos arrive again. The setup card links the new guide.
- **Admin**: a **Personal library and phones** card on a member's page › Account
  (`MemberPhonesCard.tsx`, `GET /api/photo-sync/members/:userId`, admin revoke at
  `DELETE …/phones/:id`, logged as revoked "for a member"); hidden for someone with neither.
  **Library › Storage › Personal libraries** gained totals (libraries · size · phones) and a
  Phones column. No new group; the personal-libraries search entry gained phone terms.
- **Guide** `docs/users/phone-backup.md`, on the Help page under Gallery: My library, adding a
  phone, PhotoSync on Android and iPhone, Wi-Fi-only Autotransfer (Instant on Android; charging,
  location and Shortcuts on iPhone, ~3 minutes a run), the foreground first backup, Samsung
  battery (Unrestricted, not in Sleeping apps), the status and its problems, re-sends storing
  nothing twice, Live Photos, the VPN note, "one copy, not a backup", and a section for the
  administrator. **Both languages**: the guides are English-only by design (no guide has a
  Russian counterpart, and `features/help/catalog.ts` keeps guide text English); the in-app
  strings are in `en` and `ru`. **No screenshots**: the demo site would need a rebuild with
  phases 1–3 and a phone run against it; the guide reads without them. Also updated:
  `your-account.md` (Phones), `storage.md`, `control-panel.md`, `docs/users/README.md`,
  `docs/database.md`.
- Tests: `apps/server/test/photo-sync-status.test.ts` (counts, repeats not counted, the type
  without the name, disk full logged once, a network refusal against the phone, the once-a-minute
  throttle, the owner's and the admin's views, admin revoke); `apps/web/test/PhonesSection.test.tsx`.
- **Status from a real run**: the dev server's Profile shows the tablet run of phase 3 — "Galaxy
  Tab … Last 24 hours: 45 files, 219.7 MB" — and a test phone refused from 127.0.0.1 showed the
  refusal on Profile, on the member page and in the log, then was revoked from the member page.
- Not done: the iPhone steps in the guide follow PhotoSync's documentation and are untested
  (phase 5).

### Phase 5 — Hardening and other clients

- PhotoSync for iOS run (Autotransfer triggers, Live Photos), FolderSync run, a run over a VPN;
  results into *Spike results*.
- Live Photo pairing (HEIC + MOV → one item with motion) — see *Gallery gaps*.
- Stale-device notice ("no contact for 7 days"), size-limit warnings before the limit is hit.

### Later (only when asked)

- **Opt-in deletions**: per-device switch; `DELETE` → Recycle Bin; more than *N* (default 20)
  deletes from one device in an hour pauses that device's deletes and tells the owner.
- **Immich migration** into personal libraries — [immich-migration-plan.md](immich-migration-plan.md).
- Two-way sync: **not planned** (decision 10).

## Security checklist

- Accepted only from a listed phone-sync network **and** with a live device token; empty list =
  off; unbelievable address (proxy unconfigured) = refused.
- Never published through a public proxy or tunnel by the guide; LAN or VPN only.
- One revocable token per device, hashed at rest, shown once; never the account password.
- Personal library: owner only, admins included; nothing derived from it reaches anyone else;
  faces off until the owner turns them on.
- Writes only into the token's personal library and only inside the device namespace; no client
  path reaches the filesystem (`normaliseRelativePath` on every name, `..` refused).
- No delete, no overwrite: an existing name with different content is stored as a new file and
  recorded, never replacing the earlier one.
- Size cap per file, size limit per member, free-space check (`507`); per-token rate limit;
  unknown tokens count as abuse.
- Integrity: length check always, client checksum when sent, sha256 stored and exposed as ETag.
- Partial files never visible: staging + atomic rename; stale `.upload-*` folders swept on start.
- Removing a member revokes their phones and keeps their library.

## Gallery gaps this exposes

| Gap | Today | Needed |
| --- | --- | --- |
| Live Photos | HEIC + MOV with the same name become **two items** | Pair them (phase 5). Until then the guide offers PhotoSync's "still only" setting. |
| RAW (`.dng`, `.cr3`, …) | Not in the gallery extension list | Out of scope; refused with `415`, shown on the device's status. |
| Date fallback | Uploads fall back to "now" | Use the client's date (`X-OC-Mtime`, `X-RecordTime`, `PROPPATCH`) before "now" (phase 3). |
| Filename dates | — | Samsung (`20261105_100150.jpg`) and Pixel (`PXL_20261102_160025120.jpg`) names both parse (phase 3). |

## Open questions

1. ~~Does PhotoSync skip files already on the server?~~ **Yes (Android, spike run 2)**: it lists
   the album folder before every file. iOS to confirm in phase 5.
2. ~~Which chunking scheme does "Upload in chunks" use?~~ **Dropped**: LAN/VPN only, no size cap.
3. ~~One library per member, or a shared one with locked folders?~~ **One personal library per
   member** (decision 3).
4. ~~Where does the admin's device table live?~~ **On the member's page plus a Library › Storage
   card** (phase 4).
5. Should a relative **without an account** be able to back up through a standing drop link into
   an Inbox? Defer until someone asks.
6. ~~Which existing control-panel tab hosts the personal-library settings?~~ **Library › Storage**
   *(owner, 2026-11-05)*: a *Personal libraries* card beside the storage containers and the system
   libraries' folders, which is where storage roots are already chosen.
7. ~~When a personal library is orphaned, may an admin hand it to another member, or only delete
   it?~~ **Hand over or delete** *(owner, 2026-11-05)*. An admin may hand an orphaned personal
   library to another member who has none (it becomes theirs and stays private), or delete it
   through the normal confirmed delete. The admin never opens it, and it never becomes an ordinary
   library again.
8. ~~Is the admin's confirmation enough to adopt a library as personal?~~ **Yes** *(owner,
   2026-11-05)*: the admin confirms through a `ConfirmDialog` that names the member and says every
   other grant goes; it takes effect at once, and the member's My library tab says the library was
   adopted. No pending-offer state. [immich-migration-plan.md](immich-migration-plan.md) step 2
   should adopt the second member's phone library as their personal library.
9. ~~How does home know the LAN address to show on the setup card in Profile › My library ›
   Phones?~~ **The admin types it once, nothing is guessed** *(owner, 2026-11-05)* — see
   decision 2. (An earlier answer in this session, "admin field plus a guess", was given while
   the question read as being about the phone; the owner's considered answer replaced it the
   same day.)

---

## Research findings

Background for the decisions above, kept as it was found (2026-11-05).

### 1. Transfer methods

| | WebDAV | SFTP | SMB | Own HTTP API |
| --- | --- | --- | --- | --- |
| Rides the app's existing HTTP port | **Yes**, it is HTTP | No — a second port, raw TCP | No — LAN only | Yes |
| Supported by PhotoSync (iOS + Android) | **Yes** | Yes | Yes | No |
| Supported by FolderSync, Nextcloud apps, rclone, OS file managers | Yes | Mostly | Mostly | No |
| Who checks the password | **Home**, with its tokens, lockout and abuse counting | A second auth stack (SSH keys / passwords) inside Node (`ssh2`) | Unraid / Samba users, not home's members | Home |
| Server work in home | A small subset of RFC 4918 | An SSH server and a filesystem shim | None (Unraid shares), but home never sees the upload until a scan | Everything, and no client speaks it |
| Encryption | TLS if served over HTTPS; a VPN otherwise | SSH | SMB3 on the LAN only | TLS |
| Resumable uploads | Not in the standard; whole-file retry, or a vendor chunking scheme | `SSH_FXP_WRITE` at offset, if the client does it | Yes on the LAN | Whatever we design |

**WebDAV** is the only method that the mobile apps speak and that home itself can authenticate
with its own per-device tokens, on the port it already serves. SFTP is the runner-up and is left
out: a second listening port on an Unraid box is the kind of exposure
[the hardening work](hosting.md) has been removing, and it brings its own credential system. SMB
stays what it already is — a LAN convenience the owner can point at a library folder through
Unraid, with no help from home (see *Zero-code fallback*).

### 2. Is WebDAV still alive?

Yes, as plumbing rather than as a product. Its standing in 2026:

- **Self-hosted file platforms are built on it.** Nextcloud's and ownCloud's file APIs are
  WebDAV (`remote.php/dav`); ownCloud Infinite Scale keeps WebDAV and adds TUS for resumable
  uploads. Synology, QNAP and Unraid plugins ship WebDAV servers; `rclone serve webdav` is a
  common way to expose a folder.
- **Mobile backup apps still list it as a first-class target.** PhotoSync lists WebDAV beside
  FTP, SFTP, SMB, S3 and the clouds, and has an "Upload in chunks" WebDAV option added for servers
  behind Cloudflare.
- **The desktop mapped-drive client is the part that is dying.** Microsoft deprecated the Windows
  WebClient (WebDAV) service in Windows 11 23H2. It does not matter here: phones use the apps' own
  WebDAV code, not the operating system's.
- **Weak spots to design around:** no standard for resumable or chunked uploads (every vendor has
  its own: Nextcloud chunking v2, PhotoSync's own, TUS); Basic auth carries a password on every
  request, so the password must be a revocable device token, never the account password, and the
  transport must be trusted (LAN or VPN here); and clients differ in what they send (some `PUT`
  straight to the final name, some upload to a temporary name then `MOVE`, some `PROPFIND` first
  to skip what already exists).

**Is WebDAV enough, or does it need server logic?** It is enough as a *transport*. Everything that
makes it a photo backup rather than a file dump — per-device identity, filing by date, not making
duplicates, refusing deletes, handing files to the scanner, showing status — is home's own logic
behind the endpoint. That logic is the real project; the DAV verbs are the small part.

### 3. Mobile apps

| | PhotoSync (iOS) | PhotoSync (Android) | FolderSync (Android) | Nextcloud app | Immich app | Syncthing-Fork / Möbius |
| --- | --- | --- | --- | --- | --- | --- |
| Talks to a plain WebDAV server | Yes | Yes | Yes | No, its own Nextcloud API | No, Immich's API | No, Syncthing protocol |
| Automatic background upload | Yes, within iOS limits (below) | Yes, scheduled / on new media | Yes, scheduled | Yes, mixed reliability reported in 2026 | Yes | Android yes, iOS weak |
| Wi-Fi only / charging only | Yes / Yes | Yes / Yes | Yes / Yes | Yes | Yes | Yes |
| Original quality, HEIC kept | Yes, with Pro/Premium (free tier converts HEIC to JPEG) | Yes | Yes (it copies files) | Yes | Yes | Yes |
| Live Photos | Two files (HEIC + MOV) by default | n/a | n/a | Yes | Yes | n/a |
| Knows what it already sent | On the device; reworked in 4.9.5 to survive iOS upgrades and iCloud restores | Checks the server listing (spike) | Compares with the server listing | Server | Server (hash) | Both sides |
| Propagates phone deletions | No (Autotransfer sends new items only) | No | Optional ("sync deletions") | No | Optional | Yes (two-way) |
| Cost | Pro lifetime ≈ US$6; Premium (needed for Autotransfer) lifetime ≈ US$15–25 or ≈ US$6.49/yr | Separate purchase | ≈ US$5 Pro | Free | Free | Free / paid on iOS |
| Privacy | Phone → our server directly; no PhotoSync cloud in the path | Same | Same | Same | Same | Same |

**PhotoSync on both platforms is the documented path**, because it is the only app that exists on
both, speaks plain WebDAV, keeps originals and has years of background-upload work on iOS.
FolderSync is documented as the Android alternative. The cost is the member's one-off purchase;
the guide says so plainly.

**Rejected on purpose:**

- **Pretend to be Nextcloud or Immich so their free apps work.** Both apps check server version
  and capabilities and change their APIs often; home would be chasing someone else's release
  train for ever, and a silent break means photos quietly stop backing up. Revisit only if one of
  them publishes a stable, versioned upload API.
- **Our own phone app.** The brief rules it out on cost, and iOS 26.1's new PhotoKit background
  upload extension (the first real background-backup API for third parties) does not change that:
  a developer prototyping it for Immich reported that the upload URL has to be declared in the app
  for network validation, which does not fit a self-hosted server whose address differs per
  family, and other reports say the extension is not scheduled while iCloud Photos is on. Watch
  it; do not build on it.

### 4. What "background" really means on each platform

- **Android:** a real scheduler. PhotoSync and FolderSync run on a timer or when new media
  appears, honouring Wi-Fi-only and charging-only. Battery-optimisation settings on some makers'
  phones (Xiaomi, Samsung) hold it back — the spike saw a Samsung delay one upload by over three
  minutes; the guide must say to exempt the app.
- **iPhone:** no app may run whenever it likes. PhotoSync's Autotransfer has three ways in:
  **When charging** (iOS picks the moment and may postpone it), **arriving at a location** (needs
  location access "Always", fires on arrival, ≥200 m away), and a **Shortcuts automation** (e.g.
  "when connected to home Wi-Fi" or "at 02:00 while charging"). Each run gets roughly **three
  minutes** of background time, so a large first backup or a long video will not finish in the
  background. And if the user swipes the app out of the app switcher, iOS stops considering it.

Consequence: **the first backup is done in the foreground**, with the app open and the phone on
charge overnight, and the guide says so. After that, background runs carry the day's handful of
new photos. The server must handle a transfer that stops part-way through a file without leaving
anything behind.

### 5. Sync models

| | A — Upload only | B — One-way with deletions | C — Two-way |
| --- | --- | --- | --- |
| What the apps can do | PhotoSync, FolderSync, all | FolderSync's "sync deletions"; not PhotoSync's Autotransfer | Nothing on iOS can write back into the Photos library as a sync; Android only as file-folder sync |
| Risk | A copy that never shrinks | A phone wiped, reset or stolen empties the backup — exactly when it is needed | Conflicts, duplicates, and the server's own edits (rotations, tags, Replace) colliding with the phone's |
| What it is | **A backup** | A mirror | A second iCloud |
| Verdict | **First release** | Later, opt-in, through the Recycle Bin, with a mass-deletion brake | **Not planned** |

Option C is rejected: iCloud Photos and Google Photos already do two-way sync, and the
server-side edits home is good at (Replace, rotation, people) would have to be written back to a
phone library that these apps cannot write to.

### Zero-code fallback (documented, not built)

On the LAN, the owner can already make an Unraid SMB share of a library folder and point
PhotoSync's SMB target at it; the scanner picks the files up. It has no per-member identity, no
dedupe beyond the app's memory, no network gate and no status — but it works today.

## Running the phase 0 spike

*Removed in phase 3 (2026-11-05); kept as the record of how the results below were gathered —
the commands no longer work.* Built 2026-11-05: `apps/server/src/modules/library/gallery/sync/spike.ts`, tested in
`apps/server/test/photo-sync-spike.test.ts`. It is a plain WebDAV server over a scratch folder
that logs every request, so the phone apps behave as they would against the real thing. It
touches no library, no database row and no account. It is **off** unless the environment asks
for it, and is meant for a dev machine, not the owner's server. Phase 3 deletes it.

| Variable | Meaning |
| --- | --- |
| `PHOTO_SYNC_SPIKE=1` | Mounts WebDAV at `/dav/`. |
| `PHOTO_SYNC_SPIKE_PASSWORD` | The one password every user name signs in with (default `spike`). Give each phone its own user name; the report lists them. |
| `PHOTO_SYNC_SPIKE_DIR` | Scratch folder (default `data/photo-sync-spike/`, beside `data/db`): `files/` holds what arrived, `requests.jsonl` the log. Delete it between runs. |
| `PHOTO_SYNC_SPIKE_DELETE=1` | Lets `DELETE` delete. Off by default, so the spike answers `403` — turn it on only to see what FolderSync's "sync deletions" sends. |

The phone must reach the server, so run it on the LAN address (PowerShell):

```powershell
$env:PHOTO_SYNC_SPIKE="1"; $env:HOST="0.0.0.0"; npm run dev
```

Then on the phone, add a WebDAV target: server `<pc-lan-ip>`, port `4000`, path `/dav/`, SSL off,
any user name, password `spike`. The PC's firewall has to allow inbound port 4000 (with
Bitdefender: an allow rule for `node.exe` on any network type). Test files: copy
`D:/Demo/media/PhoneRoll` onto the device (`adb push`, then a media-scanner broadcast per file).

Then:

```bash
node scripts/photo-sync-spike-report.mjs
```

prints, per app: verbs and statuses, whether it authenticates up front, the `PROPFIND` bodies,
whether it checks a path before uploading, temp-name-then-`MOVE`, chunking headers or paths, date
headers, Live Photo pairs, failed uploads, and what a second run re-sent. Spike-only shortcuts
that phase 3 must not keep: one shared password, no network gate, no rate limit on `/dav`, files
kept where the client put them.

## Spike results

Test material: `D:/Demo/media/PhoneRoll` (43 CC0 / public-domain files laid out like an Android
camera roll, built by `D:/Demo/scripts/phone-roll.mjs`; credits in `D:/Demo/CREDITS.md`), pushed
to a Galaxy Tab S10+ (Android 16) with `adb`.

**Run 1 — PhotoSync 4.3.7 for Android, manual transfer of 44 items over the LAN (2026-11-05).**
All 44 stored, 217 MB, no errors.

- **Auth:** the very first request carries no credentials and waits for the 401 challenge; after
  that, Basic is sent on every request.
- **Layout is the app's:** it creates `/<device model>/<album>/` itself (`/Samsung SM-X820/Camera/`,
  `/…/Screenshots/`, `/…/WhatsApp/`) with `MKCOL`, re-issued before *every* file and accepting
  `405` for "exists".
- **Per file:** `MKCOL` ×2 → `PROPFIND` Depth 1 of the album folder → `PUT` to the final name →
  `PROPPATCH getlastmodified`. No temp name, no `MOVE`, no `LOCK`, no `HEAD`, no
  `Expect: 100-continue`. The `PROPFIND` body asks for CalDAV/CardDAV props as well (a generic DAV
  library); answering only the DAV ones is fine.
- **Dates:** `X-OC-Mtime` and `X-RecordTime` on the `PUT`, unix seconds with decimals
  (`1793893935.00`). For camera items they are the **capture time** (MediaStore `datetaken`); for
  items without one (WhatsApp, screenshots) the file's modified time. The `PROPPATCH` repeats it
  as **bare unix seconds** in `getlastmodified`, not an RFC 1123 date.
- **Content-Type** is right on every `PUT` (`image/jpeg`, `video/mp4`, `image/png`).
- **No chunking by default:** a 129 MB video went as one `PUT` (3.7 s on the LAN). With LAN/VPN
  only there is no size cap to meet, so "Upload in chunks" was not tested.
- Selecting a whole album sends everything in it, including whatever the user already had there.

**Run 2 — Autotransfer switched on (Camera, Screenshots, WhatsApp), same tablet.** Its first pass
walked 46 items in two minutes — `MKCOL` ×2 + `PROPFIND` Depth 1 each — and sent **none**: every
one was already in the folder listing. PhotoSync **checks the server and skips what is there**,
which makes decision 8 load-bearing.

**Run 3 — Autotransfer, "Instant" trigger restricted to Wi-Fi, two new photos.** Both went
together at 16:05:12 UTC: one taken 3 min 20 s earlier, one 55 s earlier. Only the two new files
were sent. The first waited until something woke PhotoSync (the second photo or opening the app)
— Samsung's battery management holding the background job. On-device names are Samsung's camera
names (`20261105_100150.jpg`), not the `PXL_` names of the test roll.

Still to run (phase 5, or before phase 3): PhotoSync for iOS, FolderSync, a backup over a VPN.

## Sources

- PhotoSync: [Autotransfer overview](https://www.photosync-app.com/premium),
  [iOS autotransfer problems](https://www.photosync-app.com/support/ios/answers/how-to-solve-my-autotransfer-problems-on-ios),
  [location trigger](https://www.photosync-app.com/support/ios/answers/how-do-i-automatically-transfer-photos-when-i-arrive-at-a-pre-selected-location),
  [Android autotransfer](https://www.photosync-app.com/support/android/answers/android-autotransfer-howto),
  [plans](https://www.photosync-app.com/support/ios/answers/which-photosync-plan-for-ios-should-i-get),
  [4.8 release notes](https://www.photosync-app.com/support/release-notes/photosync-4-8-for-ios-released),
  [App Store listing and changelog](https://apps.apple.com/app/id415850124)
- iOS 26.1 background upload: [Apple: uploading asset resources in the background](https://developer.apple.com/tutorials/data/documentation/photokit/uploading-asset-resources-in-the-background.md),
  [Neowin](https://www.neowin.net/news/apple-quietly-opens-up-background-photo-backups-to-third-party-apps-with-ios-261/),
  [Immich discussion #23358](https://github.com/immich-app/immich/discussions/23358),
  [not scheduled with iCloud Photos on](https://developer.apple.com/forums/thread/822256)
- Android apps: [Nextcloud auto-upload issue (2026)](https://help.nextcloud.com/t/andoid-app-is-not-syncing-at-all/232366.md),
  [Nextcloud auto-upload missing photos](https://piefed.nullspace.lol/post/71800)
- WebDAV on Windows: [Windows 11 23H2 deprecations](https://petri.com/microsoft-deprecates-features-windows-11/)

Prices are App Store US listings as seen 2026-11-05 and differ by country.
