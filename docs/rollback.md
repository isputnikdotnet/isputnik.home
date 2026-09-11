# Upgrading and rolling back

An upgrade is a new image on the same `/config` volume. The first time a new
version starts, it brings the database up to date with its migrations, and those
only go forward. So getting back to the previous version always means two things
together: the previous **image**, and the **database as it was before the
upgrade**. This page is how to do both.

## Before you upgrade

Nothing is required — the server keeps its own copy of the database at every
upgrade (next section). Two things are still worth a minute:

- **Take a full backup of your own** if you haven't lately: **Control panel →
  Maintenance → Backup → Full backup**, then download it. The automatic copy is
  the database alone and sits on the same disk as the database; a full backup
  also carries the two-factor key and the cover images, and a downloaded one
  survives the disk.
- **Decide what you follow.** The Unraid template and the compose file use
  `:latest`, which moves with every release. Pin a version (below) if you'd rather
  choose when to upgrade.

## The automatic pre-upgrade copy

When a version starts that isn't the one that last ran this database, the server
writes a copy of the database **before** that version's migrations touch it. It
records which version last ran in the database itself; an install from before
that record existed (anything older than 4.0.0) counts as an upgrade, so the
first upgrade to 4.0.0 gets a copy too.

- **What it is.** A consistent snapshot of the database file, taken with SQLite's
  `VACUUM INTO` — including anything still in the write-ahead log. It is the
  database only: no cover images and no `mfa.key`. On the same install that's
  all it needs — the key doesn't change between versions, so the copy still reads
  with the key you have.
- **Where it goes.** It is written beside the database first
  (`/config/db/isputnik.sqlite.pre-upgrade`), and once the server is up it moves
  into the backup folder as `isputnik-<date>-<time>-pre-upgrade.sqlite`. In
  Docker that is `/config/backups` — the `backups` folder of whatever you mapped
  to `/config` — or the Backups room of App storage when that is switched on.
  The activity log records it as *Automatic pre-upgrade database copy …*, naming
  the version it came from.
- **Where to find it.** **Control panel → Maintenance → Backup** lists it with the
  other database copies, where it can be downloaded or restored like any of them.
- **How many are kept.** The newest two. They are counted on their own, so an
  upgrade never pushes out one of your backups and your retention setting never
  deletes a pre-upgrade copy.
- **When it isn't taken.** Not on a brand-new install (there's nothing to
  protect), not when the same version restarts, and not on the start that applies
  a restore — the database just put in place came from a backup, and the one it
  replaced is saved by the restore itself.
- **If the upgrade fails to start.** A copy that couldn't be filed yet — because
  the new version stopped during its migrations, say — stays at
  `/config/db/isputnik.sqlite.pre-upgrade`, and later starts never overwrite it.
  That file is the one to restore by hand (below).

## How the image is tagged

The image is `ghcr.io/isputnikdotnet/isputnik.home`. Every release publishes three
tags for the same build, and only after that release's test suite has passed:

| Tag | Example | Moves? |
|---|---|---|
| The exact version | `:4.0.0` | No — this is what you pin to, and what you roll back to |
| The minor line | `:4.0` | Yes, to each patch release of 4.0 |
| `latest` | `:latest` | Yes, to every release |

The version you are running is on **Control panel → Settings → About**. The image
is built for `linux/amd64` only.

## Why the database has to go back too

Migrations have no way back. A migration may add a column, but it may also drop
one or rebuild a table, and an older version knows nothing about any of it. It
also doesn't check: started against a database a newer version has migrated, it
starts without complaint and then fails at whatever it doesn't recognise — or
writes into a shape it doesn't understand.

**Never run an older version against a database a newer version has migrated.**
Put the pre-upgrade copy back as you change the image, as below. That costs
whatever was written to the database since the upgrade — listening and reading
progress, edits, settings, new catalogue entries. Your media files are never in
the database and are not touched; a library scan picks up files added since.

## Rolling back

### From the Backup page (the app still runs)

Do these in order, without starting the new version again in between:

1. **Control panel → Maintenance → Backup.** Find the newest
   `…-pre-upgrade.sqlite` — its time is when the upgrade started. **Download** it
   first, so a copy is off the server whatever happens next.
2. **Restore** it. Restoring only *stages* the database; nothing changes until the
   server next starts.
3. **Change the image to the previous version's exact tag** (see below for Unraid,
   compose and plain docker) and start it. The older version applies the staged
   database before it opens anything, after saving the database it replaces as
   `isputnik-<date>-<time>.sqlite` in `BACKUP_PATH` (`/config/backups` in
   Docker).

Starting the *new* version in step 3 instead would apply the restore and then
migrate it straight back up — harmless, since the copy is still in the list, but
you'd be where you started.

### By hand (the app won't start)

If the new version crash-loops, there is no Backup page to use. The log's last
lines say why (`docker logs isputnik`, or the container's log on Unraid).

1. **Stop the container.**
2. **Find the copy.** Look in `/config/db/` for `isputnik.sqlite.pre-upgrade` —
   there when the new version never got far enough to file it — and otherwise in
   the backup folder for the newest `isputnik-<date>-<time>-pre-upgrade.sqlite`.
   On the host these are the `db` and `backups` folders inside whatever you mapped
   to `/config` (`/mnt/user/appdata/isputnik/…` with the stock Unraid template).
3. **Move the current database aside** rather than deleting it: rename
   `isputnik.sqlite`, `isputnik.sqlite-wal` and `isputnik.sqlite-shm` in `db/`
   (add `.bad`, say).
4. **Copy the pre-upgrade file to `db/isputnik.sqlite`**, and check that no
   `isputnik.sqlite-wal` or `isputnik.sqlite-shm` is left beside it — those
   belong to the other database, and SQLite would replay them into this one.
5. **Give it to the app's user.** The server runs as `PUID:PGID` — `99:100` on
   Unraid, `1000:1000` by default — and can't write to a file owned by root:
   `chown 99:100 isputnik.sqlite` (with your own numbers).
6. **Change the image to the previous version's exact tag** and start it.

There is a gentler variant of steps 3–5 that lets the server do the swap: copy the
pre-upgrade file to `db/isputnik.sqlite.restore` (owned by the app's user), then
start the previous version. That is exactly what a Backup-page restore stages: on
start the server saves the current database into `BACKUP_PATH`, removes the
`-wal`/`-shm` files and puts the restored one in place.

### Changing the image

**Unraid**

1. **Docker** tab → the isputnik container → **Edit**.
2. Change **Repository** from `ghcr.io/isputnikdotnet/isputnik.home:latest` to the
   version you want, for example `ghcr.io/isputnikdotnet/isputnik.home:4.0.0`.
3. **Apply.** Unraid pulls that image and recreates the container on the same
   `/config` and media mappings.

**docker compose**

```yaml
services:
  isputnik:
    image: ghcr.io/isputnikdotnet/isputnik.home:4.0.0   # was :latest
```

```bash
docker compose pull && docker compose up -d
```

**Plain docker**

```bash
docker pull ghcr.io/isputnikdotnet/isputnik.home:4.0.0
docker stop isputnik && docker rm isputnik
# recreate it with the SAME -v <appdata>:/config and media mounts, the same
# environment, and only the image tag changed
```

## Going forward again

Once a fixed release is out, set the tag back to `:latest` (or to the new exact
version). Its first start takes a fresh pre-upgrade copy and migrates the database
again, exactly as the first attempt did.

If an upgrade failed, please [open an issue](https://github.com/isputnikdotnet/isputnik.home/issues)
with the version you came from, the one you went to, and the end of the log.

---

For the maintainer: the copy is taken in `apps/server/src/db/pre-upgrade.ts`
(called from `db.ts` before `migrate()`), filed by `adoptPreUpgradeCopy()` in
`modules/backups/run.ts`, and a staged restore is applied by `applyPendingRestore`
in `db.ts`. Tests: `apps/server/test/pre-upgrade-copy.test.ts`.
