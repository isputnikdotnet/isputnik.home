# Leaving Immich — research and plan

Status: research done, approach agreed with the owner (2026-11-05); **on hold until
[photo-sync-plan.md](photo-sync-plan.md) is implemented** — no step runs before then,
including the ones that could (owner's decision, 2026-11-05). Companion to [gallery-library.md](gallery-library.md),
[photo-sync-plan.md](photo-sync-plan.md) (which replaces Immich's phone-backup role),
[duplicate-detection.md](duplicate-detection.md) and
[photo-inbox-proposal.md](photo-inbox-proposal.md). As in the other plans, decisions are
recorded so they need not be argued again, and open questions so that whoever runs the
steps does not settle them quietly.

## Goal

A family that has been running Immich beside iSputnik Home switches Immich off without
losing a single original, and gets the disk back that Immich's caches hold. Stated by
the owner in three lines:

1. every photo and video in the Immich folder must also be in iSputnik;
2. Immich's own metadata — albums, faces, favourites, tags — is **not** wanted;
3. Immich's leftovers — thumbnails, transcodes, database backups — must go.

## The answer in one paragraph

**Nothing is migrated, because the files never moved.** iSputnik already reads Immich's
upload folder and its external library in place, so "migration" is a reconciliation (is
every original indexed?), two gaps to close (the second member's phone folder and a few
stray uploads), one setting to fix (a stale extension list), and then — once PhotoSync
has taken over phone backup — deleting 47 GB of Immich's derived data. Immich's
database, API, `immich-go` and Postgres are read **once, for the census below**, and
never again: no metadata import is written.

## Research findings

### 1. What Immich holds (census of the owner's install)

Read offline from Immich's own nightly dump,
`immich/backups/immich-db-backup-20261101T010000-v3.0.1-pg16.10.sql.gz` (Immich
v3.0.1, 67 tables), with a throw-away script that printed totals only. Immich still
backs its database up nightly, so the census can be re-run on any later dump.

| | Count | Carried over? |
| --- | --- | --- |
| Assets | 18,846 (17,136 images, 1,710 videos) | files stay where they are |
| … in external library "Archive" (`/libraries` in the container) | 13,180 | already iSputnik's **Archive One** |
| … uploaded by `admin`, in `library/admin/YYYY/YYYY-MM-DD/` | 3,518 (+550 motion clips, +43 in `upload/`) | already **Current Phone** |
| … uploaded by the second user, `library/08a12615…/` | 1,555 | **not in iSputnik — step 2** |
| Albums / memberships / album shares | 24 / 7,453 / 27 | no (decision 2) |
| Favourites · descriptions · ratings · tags | 3 · 42 · 1 · 1 tag on 2 assets | no |
| People clusters / named / faces | 1,308 / **0** / 22,572 | nothing to carry |
| Edited dates or places (`asset_exif.lockedProperties`), in-app edits (`asset_edit`) | none | nothing to carry |
| Stacks · partner sharing · shared links · saved memories | 2 · 0 · 4 · 2 | no |
| Trash · offline assets | 0 · 0 | nothing hidden |
| Locked Folder (PIN) assets | 6 | see open question 2 |
| Assets in an unresolved Immich duplicate group | 1,601 | left to iSputnik's Duplicate cleanup (decision 4) |
| Live / Motion photos | 564 pairs | the JPGs keep their clips; Immich's extracted copies go (decision 5) |

Immich's data model, for the record: `asset` (one row per file, `originalPath`,
`checksum`, `isFavorite`, `visibility`, `stackId`, `livePhotoVideoId`, `duplicateId`),
`asset_exif` (what it read plus `description`, `rating`, `lockedProperties` = the fields a
person edited), `asset_edit` (in-app crops/rotations, v2+), `album` + `album_asset` +
`album_user`, `person` + `asset_face`, `tag` + `tag_asset` (hierarchical), `stack`,
`partner`, `shared_link`, `memory`, `library` (external libraries: `importPaths`,
`exclusionPatterns`).

### 2. The Immich folder on disk

`\\192.168.2.83\data\media\photos\immich` (the container's `/photos`); the external
library lives beside it at `…\photos\archive`.

| Folder | Files · size | What | Fate |
| --- | --- | --- | --- |
| `library/admin/` | 3,540 · 51.4 GB | admin's uploads, storage template `YYYY/YYYY-MM-DD/<name>`, plus 22 `.xmp` sidecars | **keep** (= Current Phone) |
| `library/08a12615-…/` | 1,555 · 11.5 GB | the second user's uploads, same template | **keep** (step 2) |
| `upload/<user>/` | 48 + 5 · 0.4 GB | uploads Immich received but never moved into `library/` (newest 2025-07) | **fold into `library/`** (step 3) |
| `encoded-video/` | 2,335 · 38.5 GB | Immich's playback transcodes, **and** 550 motion clips it pulled out of Samsung Motion Photos | delete (step 6) |
| `thumbs/` | 40,205 · 6.7 GB | thumbnails and previews | delete |
| `backups/` | 15 · 1.8 GB | nightly database dumps | keep the newest until step 7, then delete |
| `profile/` | 2 | avatars | delete |
| `.immich` marker files | one per folder | Immich's mount check | go with their folders |

Immich uses the **storage template**, so the upload folders are human-readable and
dated — which is why iSputnik can read them as libraries. An install on the default
template (`upload/<user>/<uuid>.jpg`, no dates) would need a rename pass first; see
*For other installs*.

Phones still upload into Immich: the newest file in `library/admin` is from
2026-10-29. So the cleanup cannot start until [photo-sync-plan.md](photo-sync-plan.md)
has taken over both phones (step 5).

### 3. What iSputnik already has

From the owner's database (copy at `D:\ProjectTesting\database.sqlite`, last scan
2026-11-04) and a walk of both roots, matched by relative path:

| iSputnik library | Root | Indexed | Result |
| --- | --- | --- | --- |
| **Current Phone** | `immich/library/admin` | 3,531 | **complete**: all 3,518 media files indexed; 13 rows whose files Immich has since deleted (a rescan clears them) |
| **Archive One** | `photos/archive` | 12,738 | 649 files not indexed, of which: 417 `.cr2` + 9 `.arw` RAW (unsupported), 12 `.3gp` + 1 `.mpg` (supported, but see step 1), one zero-byte `.jpg`, one `.part`, ~210 non-media (`.event`, fonts, `.aep`, `.zip`, `.txt`, `.psd`…) |
| Archive Two | `photos/archivetwo` | 42 | unrelated to Immich |

The 13 `.3gp`/`.mpg` videos are missing because both libraries were created before
`3gp`, `mpg`, `mpeg`, `wmv` and `flv` joined the scanner's defaults
(`modules/library/gallery/media.ts`), and a library keeps the `scan_extensions` list it
was created with. Nothing is broken; the list just needs the five names added.

### 4. The ways out of Immich, and why none is used

| Route | Keeps | Why not here |
| --- | --- | --- |
| Point iSputnik at the originals (what is already done) | the files, EXIF, folder dates | **this is the plan** |
| Immich REST API (`/api/albums`, `/api/assets`, API key) | everything in the census | needs Immich running and an API key, for metadata that is not wanted |
| `immich-go` / the CLI | copies files out, albums as folders | would copy 63 GB that are already in place |
| Google-Takeout-style export | — | Immich has none |
| Reading the database (dump or live Postgres) | everything | used once for the census; a metadata import on top of it is decision 2's non-goal |

## Decisions taken

1. **Files only; no metadata import.** The owner has used iSputnik for the photos for
   months and wants nothing from Immich's albums, people, favourites or tags. If that
   ever changes, the census shows the whole of it is 24 albums, 3 favourites and 42
   descriptions, and the dump is enough to write an importer from — but it is not
   written now.
2. **Albums are not carried over**, even though it would be cheap. Immich's albums were
   built before iSputnik had its own; the owner's are in iSputnik now.
3. **Faces are never carried.** Immich's 1,308 clusters have no names; iSputnik's own
   face engine recomputes clusters from the originals anyway.
4. **Immich's duplicate groups are ignored.** 1,601 assets sit in unresolved groups
   (uploads that also exist in Archive, by their paths). iSputnik's Duplicate cleanup
   ([duplicate-detection.md](duplicate-detection.md)) answers the same question over
   the same files, with the Recycle Bin behind it; running it *after* the gaps are
   closed sees everything at once.
5. **`encoded-video/` is deleted whole**, including the 550 extracted Motion-Photo
   clips. The clips are still embedded in their JPGs (Samsung Motion Photo keeps the
   MP4 inside the image file); iSputnik does not play them today, and keeping 38 GB of
   transcodes to preserve 550 three-second clips is the wrong trade. Playing embedded
   motion clips is a gallery feature for another day, not a migration step.
6. **No code in home for this.** Every step is a setting, a file move, a rescan or a
   `rm`. The reconciliation script stays a throw-away (it lives in the session
   scratchpad, not the repo); if a second family ever needs it, *For other installs*
   says what it does.
7. **Order: PhotoSync first, cleanup last.** *(Owner, 2026-11-05.)* Nothing under
   `immich/` is deleted, moved away or stopped until the Photo Sync plan is fully
   done, and the newest database dump outlives everything else.
8. **The second member's phone history becomes their personal library** (photo-sync
   decision 3), by adoption after the admin's checks — not an ordinary granted
   library. Admin-side checks happen before adoption, because afterwards the admin
   cannot open it.

## Non-goals

- Importing albums, favourites, descriptions, ratings, tags, stacks, partner sharing,
  shared links or memories from Immich.
- Emulating Immich's mobile API so the Immich app keeps working (judged a moving target
  in [photo-sync-plan.md](photo-sync-plan.md)).
- RAW support (`.cr2`, `.arw`) in the gallery scanner — a feature request, recorded in
  open question 3, not part of leaving Immich.
- Playing Motion-Photo clips embedded in JPGs.
- Keeping Immich's transcodes for playback. iSputnik streams originals and transcodes
  on its own ([gallery-library.md](gallery-library.md) *Serving*).

## Phases

Each step is small and can be checked before the next. The owner's rule (2026-11-05):
**nothing under `immich/` is deleted, moved away or stopped until the Photo Sync plan
is fully done** — not its folders, not the Immich containers, not a phone's backup
target. Steps 1–4 and step 2's half 1 only add to iSputnik and touch nothing in
`immich/` (step 3 moves 53 files *within* it; do that one last, with the rest); the
owner has still chosen to run the whole plan together once PhotoSync is in place.

### Step 1 — fix the extension list on Archive One (and Current Phone)

On each library's settings, add `3gp`, `mpg`, `mpeg`, `wmv`, `flv` to *Scan
extensions* and rescan. Expected: 12 `.3gp` + 1 `.mpg` join Archive One; nothing
changes on Current Phone. Check: the walk in §3 reports no supported extension left
unindexed.

### Step 2 — a library for the second member's phone, then adopt it as their personal library

Aligned with [photo-sync-plan.md](photo-sync-plan.md) decisions 3–5 and phase 1
(owner, 2026-11-05): phone backups land in a member's **personal library** — an
ordinary gallery library marked `libraries.personal_user_id`, which only its owner can
open (not other members, not admins), with faces off until the owner turns them on.
Phase 1 can **adopt** an existing gallery library as a member's personal library.

Two halves, in this order:

1. **Create and check (admin).** Create a gallery library over
   `/media/media/photos/immich/library/08a12615-de3d-4a23-8271-bac5b35abfea`
   (1,555 files, 11.5 GB; years 2022–2025), named after the member the way *Current
   Phone* is. Scan it, run the §3 walk on it (expected 0 missing), run step 4's
   Duplicate cleanup across it and the family libraries — everything the admin needs
   to see with their own eyes happens **now**, while the admin can still open it.
2. **Adopt (admin action, confirmed, with the member's agreement — photo-sync open
   question 8).** Make it that member's personal library. The phone's history and its
   future PhotoSync uploads then live in one place. What adoption costs, stated in
   the confirmation: every grant to anyone else is removed, and **the admin can no
   longer open the library** — only its name, size and devices stay visible. Faces in
   it are off until the member turns them on (decision 5 there), so the family's
   People pages are not fed from it.

No grant to the member is given in half 1: it would be removed by adoption anyway, and
until adoption the library is the admin's to check. If phase 1 is not built when the
plan runs, stop after half 1 and leave the library admin-only (no grants) until it is.

*Current Phone* is the admin's own phone history; whether it, too, becomes the admin's
personal library is the admin's choice at the same time, by the same adoption, with the
same checks done first.

### Step 3 — fold `upload/` into `library/`

53 files (48 of admin's, 5 of the second member's) that Immich received but never
filed. Move each into the owner's `library/<user>/YYYY/YYYY-MM-DD/` by its EXIF date
(file date when EXIF has none), the same shape Immich's template produced; keep the
original names; refuse to overwrite. Then rescan both phone libraries. Alternative if
the dates are doubtful: drop them into the **Photo Inbox** and let Keep / Discard
decide, which also runs the asymmetric duplicate check against the rest of the
collection.

### Step 4 — reconcile and run Duplicate cleanup

Rescan everything, run the §3 walk once more over all three roots, and keep its report
(counts per extension of what is unindexed, every supported-but-missing file by name).
Then run a Duplicate cleanup over the three libraries. **Before step 2's adoption**:
once a library is personal the admin cannot open it, so the walk and the cleanup
cannot look inside it any more. Immich's 1,601-asset duplicate
set is expected to reappear here, mostly as phone uploads that were later copied into
`archive/`; the owner decides keepers library by library, as the cleanup already
supports.

### Step 5 — PhotoSync takes over both phones

Per [photo-sync-plan.md](photo-sync-plan.md). Until a phone has made its first
successful PhotoSync upload, it keeps backing up to Immich. Check: the newest file
under `immich/library/<user>` stops moving.

### Step 6 — switch Immich off and delete its derived data

**Gate: the Photo Sync plan is fully done** — every phase, not just phase 1 — and
both phones have backed up through it (step 5). Until then nothing here runs: no
container stopped, no folder deleted. Stop the Immich stack (server, machine learning, Postgres, Redis) and keep it stopped
for a week while people use iSputnik. Then delete:

- `immich/thumbs/` (6.7 GB)
- `immich/encoded-video/` (38.5 GB; decision 5)
- `immich/profile/`
- `immich/backups/` **except the newest dump**
- the `.immich` marker files in `library/` and `upload/`

`library/` stays as it is: it is now plain photo storage that two iSputnik libraries
read. Leave it where it is rather than moving it out from under `immich/`, so the
libraries' paths and the PhotoSync targets stay valid; renaming the parent folder to
something like `phones/` is cosmetic and can be done later with a path edit on each
library.

### Step 7 — remove Immich and the last backup

After a month with nothing missed: remove the Immich containers and their Docker
volumes (the Postgres data is the only state outside `/photos`), the Unraid template
entry, and the last database dump. The census in §1 is the record of what it held.

## Checks

- After steps 1–3: the walk reports 0 supported-but-unindexed files under
  `immich/library/admin`, `immich/library/08a12615…` and `photos/archive`; `upload/`
  is empty.
- After step 6: `du` on `immich/` is within a few GB of 63 GB (the two `library/`
  folders) and iSputnik's three libraries still open and play.

## For other installs

A family on Immich's **default** storage layout (`upload/<user>/<ab>/<cd>/<uuid>.jpg`)
has undated, unreadable folders. Two routes: turn on Immich's storage template
(*Administration › Settings › Storage Template*) and let it move the files into
`library/<user>/YYYY/YYYY-MM-DD/` **before** switching Immich off; or point an
iSputnik library at `upload/` as it is — the scanner dates by EXIF, then filename,
then mtime ([gallery-library.md](gallery-library.md) *When was it taken?*), so the
Timeline is right even when the Folder view is not. The reconciliation is the same
either way: walk the root, compare relative paths against `gallery_details`, group the
unindexed by extension.

An install that **does** want its albums carried would read `album`, `album_asset` and
`asset.originalPath` from the dump, match each path to the item iSputnik scanned (root
+ relative path, `asset.checksum` as the fallback), and create `gallery_albums` rows
owned by the matching member. It is a one-evening script; this plan deliberately does
not include it (decision 1).

## Open questions

1. **Who owns the second phone library?** The second Immich user (`08a12615…`, no
   storage label) needs an iSputnik account to adopt it as their personal library in
   step 2 and to receive PhotoSync uploads in step 5. Whether they must accept the
   adoption from their Profile is photo-sync open question 8.
2. **The 6 Locked-Folder assets.** They are ordinary files under `library/admin`;
   Immich hid them behind a PIN, iSputnik shows them to everyone with access to
   Current Phone. Leave, or move them out of the library folder before step 6?
3. **RAW.** 426 RAW files in `photos/archive` are invisible to iSputnik. Is RAW
   support (decode via `sharp`/libraw or `dcraw` for thumbnails, originals served as
   files) wanted as a gallery feature, or do the JPGs beside them cover it?
4. **`archive/` housekeeping.** ~210 non-media files (`.event`, fonts, After Effects
   projects, zips) sit among the photos. Not iSputnik's concern, but step 4's report
   lists them if the owner wants to tidy.

## Sources

- Immich database dump `immich-db-backup-20261101T010000-v3.0.1-pg16.10.sql.gz`
  (schema and the census in §1; aggregate counts only).
- The folder walk of `\\192.168.2.83\data\media\photos\immich` and `…\photos\archive`
  (§2, §3) and the owner's database copy at `D:\ProjectTesting\database.sqlite`.
- Immich documentation, 2026: storage template, external libraries, API keys and the
  REST API; `immich-go` README.
- iSputnik: [gallery-library.md](gallery-library.md),
  [duplicate-detection.md](duplicate-detection.md),
  [photo-inbox-proposal.md](photo-inbox-proposal.md),
  [photo-sync-plan.md](photo-sync-plan.md); `modules/library/gallery/media.ts`
  (scanner extensions) and `scanner.ts` (`settings.scan_extensions`).
