# Dashboard and per-service backups — plan

Status: agreed direction 2026-10-28, not built. Mockup (both pages, clickable):
https://claude.ai/artifact/BZ8TFK1XdntA7RSU5fERYH — private to the owner.

Home now sits in front of two containers (Games, Video) and the Dashboard still
describes only itself; the containers live four clicks away under Apps. Backups
already carry each container's database (`modules/apps/backup.ts`), but nothing
can put one back. This plan does both, because the Dashboard's backup card is
where a missed container shows up first.

## Dashboard (Overview › Dashboard)

One page, no view row (the 4.15 rule in `features/control/nav.ts` stands). It
reads and points; it never holds a setting.

1. **Attention line.** The worst things first, each a link to the page that fixes
   it: a container not answering or refusing the secret, a container left out of
   the last backups, low disk, an old backup, errors in the last 24h, failed
   sign-ins. Nothing wrong → one green line ("Everything is running").
2. **Services diagram.** Home (Core) on top with its address, a Gateway pill, a
   branch per container. The branch is the connection: solid green answering,
   dashed red not reachable, dashed amber secret rejected; its label is
   `route → :port · round trip`. Each card: address, where it came from
   (environment / Setup), secret state and pairing date, network, two numbers,
   shortcuts to that app's Events · Log · Access · Setup. At ≤720px the
   branches stack.
3. **Security & access.** Members, signed-in devices, open invites, failed
   sign-ins (24h).
4. **Errors · last 24h.** One bar per service, each to its log filtered to errors.
5. **Storage & backups.** A bar per disk (below), memory, database, uptime; last
   backup as a row per part (Home / Games / Video, with "skipped — why").

### Disks

Today `dataDisk()` in `core/status.ts` measures only the database's folder — on
Unraid that is appdata on the cache pool, not where the libraries are. Instead:

- **Home's disks.** Collect every path Home knows — database folder, each library
  root, system data (thumbnails, metadata), app files, `BACKUP_PATH`, the recycle
  bin — measure each with `diskSpace()` and group them with `sameDisk()` (device
  id), both already in `core/system-data.ts`. `/api/status` returns `disks: [{
  path, freeBytes, totalBytes, holds: [{ kind, name, bytes? }] }]`; `disk` stays
  for older clients. The label is the mount path as Home sees it (`/media`); an
  optional admin-given name per disk is a later nicety.
- **Container disks.** The status contract (phase 4) gains `disks` in the same
  shape for the container's own library folders — Video's `/movies`. Shown with
  the container as owner and "last reported …" when it is not answering.
- **Attention.** A disk under the existing low-space tone (`diskTone`) joins the
  attention line, naming the disk and what is on it.
- **Limits, said on the page's help, not hidden.** Inside a container Home sees
  its mount paths, not Unraid's names. A share mapped through `/mnt/user/…`
  reports the combined user-share filesystem, so one full drive inside the array
  does not show; mapping `/mnt/cache/…` or `/mnt/diskN/…` reports that pool or
  drive exactly.

### Data

| Shown | Source | New? |
|---|---|---|
| Container address, source, secret, pairing, version, reachable | `GET /api/apps/admin/status` (`AppStatus`) | no |
| Round trip to a container | time the status probe in `modules/apps/status.ts` | small |
| Home's own address and public origin | server config | expose in system status |
| Network name (`br0`) | not visible from inside a container | drop, or an admin label |
| Errors per service (24h) | home log + each container's log tail | count endpoint |
| Failed sign-ins (24h) | sign-in log | count in system status |
| Per-part last backup | `backup.json` `apps` block | no |
| Container numbers (matches, titles, queue) | containers | phase 4 contract |
| Home's disks, grouped, with what each holds | `diskSpace()` + `sameDisk()` over known paths | `disks` in `/api/status` |
| A container's library disks | container status | phase 4 contract |

## Backups: home stores all, each part restores alone

**Decision.** Home schedules every backup and keeps every file in `BACKUP_PATH`.
Containers keep no backup store. Rejected: backups stored on each container and
managed from Home — they would share the appdata disk they protect, need one
off-site copy job per container, and each container would re-implement list,
retention, download and delete. The databases are small (metadata only, 512 MB
cap), so moving them to Home costs nothing worth saving.

### Behaviour

- **One schedule** (Maintenance › Backups): Full and Minimal as today, retention
  per kind as today, plus an *Include* switch per app (Home is always in).
- **Parts.** The list shows each backup's parts as chips — Home, Games, Video, or
  "Video skipped" with the reason on hover. Zip layout unchanged
  (`apps/<id>.sqlite`, `backup.json.apps`).
- **Restore dialog** (`ConfirmDialog`, `danger`): title `Restore from "<backup>"?`,
  a checkbox per part, parts not in that backup disabled with the reason, a note
  when the snapshot is from an older app version; confirm label counts parts
  ("Restore 2 parts").
  - **Home:** today's restore (database staged for restart, covers live).
  - **A container:** Home sends the snapshot to it; the container swaps it in at
    once. A container that is down is reported, not queued.
- **Undo a restore.** Each service keeps the database a restore replaced, until
  the next restore — Home already does (`adoptPreRestoreSnapshot`). That one file
  is the only backup a container ever holds. The Backups page lists them with
  "Put it back…".
- **Disaster recovery order:** restore Home (pairing comes back with it), then
  each container from the same backup.

### Container contract (games, video, any future app)

`POST <prefix>/api/admin/restore`, `admin` role, signed like every gateway call.

- Body: the SQLite file (`application/vnd.sqlite3`); header
  `X-Isputnik-Backup-Version` as it was stored.
- The container checks the SQLite header and its schema version: a snapshot from a
  **newer** version is refused (409, "update the container first"); an older one
  is accepted and migrated when opened.
- It writes the current database to `<db>.pre-restore`, replaces the live one
  (close → rename → reopen, or stage-and-restart as Home does), and answers 200
  with its version. `GET <prefix>/api/admin/restore/undo` describes the
  pre-restore copy (when, size, version) and `POST …/restore/undo` puts it back.
- Old containers answer 404 → Home says "update the container to restore it".
- Every restore is an event in the container's `events` table and a line in
  Home's activity log.

Video note: its catalog can be rebuilt by rescanning; what a restore really saves
is hand-made metadata (posters, picked titles, sound track choices).

## Phases

1. **Dashboard, home-only data.** *Built 2026-10-28, not released.* Attention
   line, services diagram from `AppStatus` (+ `server.roundTripMs`), security,
   problems and storage blocks, a bar per Home disk. The server side is one
   route, `GET /api/dashboard/overview` (`modules/dashboard/overview.ts`: disks,
   Home's addresses and public URL, failed sign-ins and failed tasks of the last
   day) rather than more keys on core's `/api/status` — disks need the library
   list, which core must not know. "Errors" became *problems*: failed tasks for
   Home (Home keeps no error log), and each container's error events of the last
   day, read by the page through the gateway like Apps › Events. Per-part backup
   rows moved to phase 2 — they need the listing to read each zip's manifest.
2. **Per-part backups in Home.** Include switches, part chips, restore dialog with
   per-part choice (container parts disabled until phase 3).
3. **Restore contract in containers.** `restore` + `undo` in isputnik.games and
   isputnik.video; Home enables container parts and the Undo card.
4. **Container numbers.** Status contract gains uptime, one or two headline
   numbers, the last error and the container's library `disks`; the Dashboard
   cards and disk list show them.

Conventions to keep: `shared/Modal` / `ConfirmDialog`, `KpiCard`, `MessageBox`,
i18n keys in `en` + `ru`, search terms for new settings in
`features/control/search-index.ts`.
