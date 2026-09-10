# App storage — plan

Status: **Phase 1 built 2026-09-09** (the setting, the resolver, the rooms with
their switches and confirmations, the bin move, the render-bucket move, the
Storage page); phases 2 and 3 remain proposals. Written 2026-09-09 after the photo review
work ([photo-review-plan.md](photo-review-plan.md)) added a fourth kind of
file the app makes for itself, and its phase 0 had already folded three
per-feature library settings into one. This plan finishes that thought for
the rest of the app's own files. Companion to [users/storage.md](users/storage.md),
[recycle-bin.md](recycle-bin.md), [photo-inbox-proposal.md](photo-inbox-proposal.md)
and [stories-v2-proposal.md](stories-v2-proposal.md). Decisions are recorded
so they need not be re-argued; open questions so they are not silently
answered by whoever writes the code.

Mock (private link, kept for reference while building): [the Storage page
with App storage at the top](https://claude.ai/code/artifact/6201557c-e9e1-4b68-93a4-bd9e98e53fa7),
with a room's chooser open and the confirmation box that follows it.

## Goal

One answer to **"where does the app keep its own things?"**, given once, on
the Storage page or on first run. Today that question is answered eight
times in six places, and two of the answers are given nowhere at all:

| What | Where it goes today | Where you say so |
| --- | --- | --- |
| Thumbnails and previews | A folder you name, required before the first library | Library → Storage |
| Recycle Bin | A `.trash` inside each library, or one folder you name | Library → Storage |
| Slideshow renders and uploaded music | Inside the thumbnail folder | Nowhere |
| Legacy story narration (pre-3.x clips) | Inside the thumbnail folder, until the "move recordings" button is pressed | Settings → Stories |
| Backups | `data/backups`, or `BACKUP_PATH` | Docker config |
| Narration, family uploads, movies, voice notes | The Made in the app library | Settings → Gallery |
| Photos waiting for review | A Photo Inbox library | Settings → Gallery |
| Upload staging | The system temp folder | Nowhere |

The idea in one line: **the app gets one folder, lays out its own rooms in
it, and every existing setting becomes an override of a room.**

## The mental model

| Question | Answer |
| --- | --- |
| What is App storage? | One folder inside an approved storage container. The app owns it and makes its own subfolders in it. |
| What lives there? | The Recycle Bin, the Photo Inbox, the Made in the app library, thumbnails, renders and music, and (optionally) backups. |
| Is it required? | No. Neither App storage nor any room in it. Without it the app works exactly as today, one location at a time. With it, each room is a choice: use App storage, use a folder of its own, or (where the room is a feature) leave it off. |
| What happens to an install that already answered some of these? | Nothing. Choosing App storage records a folder; each room keeps what it has until its own row is changed, and nothing is moved without asking. |
| Two kinds of file? | Yes. Things the family *made* (narration, a voice note) are library content and stay in a library the gallery shows. The rest is housekeeping and shows nowhere. Both live under one root; only the first kind is a library. |

## Non-goals

| Not building | Why |
| --- | --- |
| Moving library content or thumbnails when a location changes | Every row that stores a path (thumbnail keys, library `source_path`) remembers where its own files are, and thumbnails are rebuilt by a scan. A "move everything" job is a different, dangerous feature. The two things that do move are the Recycle Bin (decision 10, at the owner's request) and the handful of bucket files behind the Renders room (see Upgrading). |
| Putting thumbnails only under App storage | They are rebuildable and large, and on a NAS they belong on the fast local disk. App storage is their default, not their only home. |
| Putting backups under App storage by default in Docker | A backup on the same volume as the thing it backs up is not a backup. Docker installs mount a volume for them; the row keeps that. |
| A second "system" library type | The Inbox and Made in the app are ordinary gallery libraries with one flag or one nomination. That is what makes them scan, back up and share like everything else. |
| Changing where existing `.trash` folders are | Installs from before 2.23 have per-library bins on disk. The default changes for new installs only. |

## What already exists

| Piece | Status |
| --- | --- |
| Approved containers (`storage_roots`) and the rule that a library must be inside one | **Built** — `modules/library/shared/storage-roots.ts`, `library-source.ts`. |
| Thumbnail folder as a required, validated setting | **Built** — `library.thumbnail_path` in `app_settings`, `modules/library/shared/thumbnail.ts`; slideshow renders (`slideshows/`), music (`music/`) and legacy narration (`narration/`) use it as a bucket. |
| Recycle Bin location, changeable only while empty | **Built** — `GET/PUT /api/storage/trash-root`, `trash.ts`, the Storage page's editor. |
| Made in the app library, nominated once | **Built** — `house-library.ts`, Settings → Gallery (phase 0 of the review plan). |
| Photo Inbox created in one step from a container | **Built** — `POST /api/library/gallery/inbox/create`, the same page. |
| Backups path | **Built** — `config.backupPath` from `BACKUP_PATH`, mkdir on boot. |
| Legacy narration import | **Built** — `POST /api/stories/settings/migrate-narrations`, a button on Settings → Stories. |
| First-run guide | **Built** — the setup checklist after the first admin is made ([users/first-run.md](users/first-run.md)). |

Everything the plan needs exists as a setting. What is missing is the one
that fills the others in.

## Decisions taken

1. **Name: App storage.** Not "System", which sounds like the operating
   system's; not "Data", which is the config folder. "App storage" is the
   folder the app stores things in.
2. **It is a folder inside an approved container**, chosen with the same
   folder picker libraries use, and validated the same way: it must exist,
   sit inside a container, and not be inside a library. The app creates
   the rooms in it on first use; it never creates the folder itself.
3. **The rooms and their names** are fixed, in English, as the house
   library's folders are:

   ```
   <App storage>/
     Recycle Bin/
     Photo Inbox/
     Made in the app/
     Thumbnails/
     Renders/          slideshow movies while they are being made, uploaded music
   ```

   `Backups/` is offered, not made: the row shows the current path and
   offers App storage in its chooser like any other room.
4. **Every room is optional, and each is a three-way choice.** A room can
   *use App storage*, *use its own folder*, or be *off* where the room is a
   feature rather than a necessity. Concretely:

   | Room | Use App storage | Its own place | Off |
   | --- | --- | --- | --- |
   | Recycle Bin | `Recycle Bin/` | one folder you name | each library's own `.trash` (today's default) — and any change between the three moves what is in the bin (decision 10) |
   | Photo Inbox | `Photo Inbox/`, made as a library | any gallery library with the Inbox switch | no Inbox at all |
   | Made in the app | `Made in the app/`, made as a library | any gallery library you nominate | not set: no narration, no family uploads, no voice notes |
   | Thumbnails | `Thumbnails/` | a folder you name | — (something must hold them) |
   | Renders and music | `Renders/` | — | inside the thumbnail folder (today's behaviour) |
   | Backups | `Backups/` | a folder, or `BACKUP_PATH` | — (they always go somewhere) |

   The five existing settings stay exactly as they are and remain the
   "its own place" column; their editors keep working unchanged. A room
   shows which column it is in, in words, and its one **Change** button
   opens a small chooser with the three options; picking "its own place"
   continues into the editor that exists today. That row is the only place
   a room is changed: there is no second list of rooms anywhere, not in the
   Choose step, not on Settings → Gallery (which links to the row instead).

   **Every change is confirmed before it happens.** Picking an option in the
   chooser does not apply it; it opens a confirmation (`shared/ConfirmDialog`)
   that names the room, shows the exact folder it will use from now on, says
   what moves and what does not, and offers Cancel or a verb. Examples:

   | Change | The box says |
   | --- | --- |
   | Recycle Bin → App storage | "Move the Recycle Bin to `D:\Media\iSputnik\Recycle Bin`?" — the 230 items in it are moved there in the background; deleted files go there from now on; libraries are not touched. **Move bin** |
   | Renders → App storage | "Keep renders and music in `D:\Media\iSputnik\Renders`?" — the 16 uploaded tracks are moved there now; nothing else moves. **Use App storage** |
   | Photo Inbox → App storage | "Make a Photo Inbox in `D:\Media\iSputnik\Photo Inbox`?" — a new gallery library, everyone can view, nothing moves. **Create Inbox** |
   | Made in the app → off | "Stop using `Photos` for things made in the app?" — narration, uploads and voice notes already in it stay; nothing new can be recorded until another library is chosen. **Turn off** |
   | Thumbnails → own folder | "Keep thumbnails in `E:\thumbs`?" — new thumbnails go there; the old folder is left as it is and refilled by the next scan. **Use this folder** |

   The same box guards the App storage folder itself (Choose and Change),
   showing the path and stating that no room changes until its row does.

   **Once a room uses App storage, the folder is locked.** Change and Clear
   on the App storage row are refused while any room resolves into it; the
   refusal (`shared/MessageBox`, tone error, "Unable to change App storage")
   names the rooms that use it and says to move each one first from its own
   row. The path is the base of every file those rooms hold, so changing it
   underneath them would be a "move everything" in disguise. The folder can
   be changed again only when no room uses it, which on a fresh install
   means before the first library is scanned, and on any install means after
   each room has been pointed elsewhere or turned off.
5. **Choosing App storage on an install that has answers already changes
   nothing.** The resolver reads the specific setting first and App storage
   second. A thumbnail folder that was set in 2025 stays where it is.
6. **Choosing App storage records a folder and nothing else.** No dialog,
   no list of rooms to tick. What each room does once the folder is known
   follows one default per room, and every default is changed from the
   room's own row:

   | Room | When nothing was ever set for it |
   | --- | --- |
   | Thumbnails | Uses App storage (there is nothing else to use). |
   | Renders and music | Follows the thumbnails: inside App storage when they are, inside the thumbnail folder when they are not. So an upgraded install with its own thumbnail folder sees no move until the row is changed. |
   | Recycle Bin | Per-library `.trash` on an existing install; App storage on a fresh one (decision 9). |
   | Photo Inbox | Off. The row's Change offers "Make one in App storage" and "Use a library I have". |
   | Made in the app | Off. Same two offers. |
   | Backups | Where they are (`BACKUP_PATH`, or beside the database). |

   When a row is switched to App storage for a library room, the library is
   made then, after the confirmation of decision 4: `Made in the app/` as a
   gallery library (Everyone: member, audio extensions on), nominated;
   `Photo Inbox/` as one with the Inbox switch on (Everyone: viewer).
   Switching such a room off later leaves the library as an ordinary library
   and only clears the nomination or the flag; deleting it is the library's
   own delete, confirmed as any other.
7. **Legacy narration moves itself.** Once a house library exists, the
   narration import that today waits for a button runs at startup, one clip
   per tick of the existing scheduler, and the button and its banner go.
   The `story_audio` table is dropped in the release after the one where the
   import has run on every install this project knows about (there is one).
8. **First run offers App storage first, and never insists.** The
   checklist's first item becomes "Choose where the app keeps its own things"
   with the folder picker; thumbnails, renders and the bin then follow their
   defaults from decision 6, and the checklist's later items ("Make a Photo
   Inbox?", "Choose the Made in the app library") keep their place and gain
   the one-click "in App storage" answer, each behind the same confirmation.
   Under the first item, "or choose each folder on its own" opens today's
   thumbnail step, for the admin who wants thumbnails on one disk and the bin
   on another from the start. An install upgraded from before keeps its
   thumbnail folder and is simply shown App storage as unset, with no nag:
   everything still works.
9. **Recycle Bin default flips for new installs only.** A fresh install with
   App storage set gets `Recycle Bin/` under it. An existing install keeps
   per-library `.trash` until the admin changes the bin location, as today.
   The "same disk as your libraries" advice in the guide stays and gains one
   line: App storage on the same disk as the libraries makes deleting an
   instant rename.
10. **The Recycle Bin moves with its location.** Today the bin location can
    only change while the bin is empty. That rule goes: changing it (to App
    storage, to a folder of its own, or back to per-library `.trash`) starts
    a **bin move** that carries every item in the bin to the new place. It
    works because each trashed row already records where its own files are
    (`trashed_items.trash_root`, null for the library's `.trash`), so the
    move is row by row and the bin is never in a state the app cannot read:

    - The setting flips first, so anything deleted from now on lands in the
      new place.
    - A background job (the duplicate-cleanup job shape, one item per tick,
      resumable after a restart) then takes each row whose files are still
      elsewhere, moves its folder with the existing rename-or-copy-then-delete
      helper, rewrites `trash_root` and `trash_path` for the new layout
      (`<bin>/<library>/…` versus `<source>/.trash/…`), and moves on. A row
      that fails to move keeps its old location and is listed; the job never
      leaves a row pointing at files that are not there.
    - Restore and purge keep working during the move, since they read the
      row, not the setting. The one item being moved right now is skipped by
      restore for the seconds it takes, with a "being moved" notice.
    - The Storage page shows "Moving the bin: 14 of 230" on the row, and the
      Recycle Bin page shows the same line at the top; the location cannot be
      changed again until the move finishes or is cancelled (cancel leaves the
      rows where they are, each still correct).
    - Empty per-library `.trash` folders left behind are removed when the
      last row leaves them, as pruning does today.

## Phase 1 — the setting and the resolver

Server: `core/app-storage.ts` (it is infrastructure every module reads, so
it sits with config, not in a module) holds `app_settings.app_storage`
(`{ path }`) and one function:

```ts
resolveAppLocation(kind: "thumbnails" | "trash" | "renders" | "backups"): string | null
```

which returns the specific setting when set, else `<App storage>/<room>`,
else null (thumbnails and trash fall back to what they do today). Consumers
change from reading their own setting to calling this: `thumbnail.ts`,
`trash.ts`, `slideshow-render.ts`, `music.ts`, `backups/index.ts`. Their
override editors keep writing their own settings. `GET/PUT
/api/storage/app-storage` validate the path like a library source and store
`{ path }`, nothing more. Each room is set by its row: `PUT
/api/storage/app-storage/rooms/:room` with `{ mode: "app" | "own" | "off" }`
(the "own" mode is followed by the room's existing editor and endpoint, e.g.
`PUT /api/storage/trash-root`). Room modes are stored in the same setting,
`{ path, rooms: { [room]: mode } }`; a room absent from it follows the
default of decision 6. `GET /api/storage/app-storage` returns, per room,
the current mode, the resolved path, and the path App storage would give it,
plus what a switch would move (bin item count, track count), so the
confirmation box can say exactly what will happen before the PUT. For the bin, that call (and the existing `PUT
/api/storage/trash-root`) stops refusing a non-empty bin and instead starts
the bin move of decision 10: `modules/library/shared/trash-move.ts` holds
the job, `GET /api/storage/trash-root/move` reports it, `DELETE` cancels
it. `trashed_items` gains no column; progress is "rows whose `trash_root`
is not the current one".

Web: the Storage page gains a first block, **App storage**, above the
thumbnail block: the path (or "Not set"), Choose / Change, and under it the
list of rooms with what each one currently resolves to and one "Change" per
row that opens the three-way chooser, then the confirmation box, then (for
"its own place") the existing editor. The thumbnail and bin blocks fold
into that list rather than staying as separate blocks. Search index gains
"app storage". Settings → Gallery's Made in the app picker and Inbox setup
stay, and both show "made in App storage" when that is where they came from.

Docs: [users/storage.md](users/storage.md) rewritten around one folder with
rooms; [users/first-run.md](users/first-run.md) checklist; the Recycle Bin
and Photo Inbox guides gain a line each.

## Phase 2 — first run and the narration import

The first-run checklist asks for App storage first; the thumbnail step goes.
The legacy narration import runs itself at startup once a house library
exists (decision 7), and Settings → Stories loses its banner and button.

## Phase 3 — later, if wanted

- **Renders and music as library content.** Uploaded slideshow music could
  be a `Music/` room of the Made in the app library instead of a bucket file,
  which would make it visible, shareable and backed up with the rest. Waits
  for someone to miss it.
- **Upload staging under App storage** instead of the system temp folder,
  so a large upload does not fill a small root partition. Cheap, but Docker
  images are usually on the same disk as `/tmp` anyway.
- **A "move" for thumbnails**, the one location that is safe to move because
  it is rebuildable: change the folder, and the next scan refills it. Only
  worth building if someone changes disks.

## Open questions

1. **Turning a room off that has files in it.** Turning the Recycle Bin room
   off is a bin move back to per-library `.trash` (decision 10), so it is
   always allowed. Turning Made in the app off leaves the library and its
   files in place and only clears the nomination, so it is always allowed.
   Whether the Inbox row's "off" should refuse while photos are waiting, or
   just leave the library as an ordinary one, is open; the plan leans to
   refusing, since an Inbox full of unreviewed prints that quietly becomes a
   normal library would put them on the Timeline.
2. **`Backups/` under App storage for non-Docker installs.** On Windows the
   backup folder is `data/backups` beside the database, which is the worst
   disk for it. Offering App storage there is probably right; making it the
   default is the question.

## Upgrading an install that exists

The rule is **no behaviour changes on upgrade day, and every move after
that is one room at a time, by hand, under the rules that room already
has.** In order:

1. **The release that adds App storage writes nothing.** There is no
   migration for it: `app_settings.app_storage` stays absent. The resolver
   reads each room's own setting first, so every room resolves to exactly
   what it resolved to the day before. Nothing runs at startup that touches
   a disk. The one deliberate exception is the narration import in phase 2,
   which is its own decision (7) and ships in its own release.
2. **The Storage page shows App storage as "Not set"** with one line of
   explanation and Choose, and no nag anywhere else: no checklist item (the
   first-run checklist is long done), no banner, no dot. The rooms table is
   shown regardless, so an upgraded install gets the one-screen view of its
   locations immediately, each row reading "its own folder" or "off".
3. **Choosing App storage on an upgraded install changes no room.** It
   records the folder. Every room that has its own place keeps it; Renders
   follow the thumbnail folder, so they stay too. On this project's own
   install nothing resolves differently after Choose; the rows simply gain
   "Use App storage" as an option in their chooser, and each switch shows
   its confirmation box with the exact path before anything happens.
4. **Moving a room in later is that room's existing rule**, not a new
   "move everything":

   | Room | How it moves in |
   | --- | --- |
   | Thumbnails | Change the folder; the next scan refills it (phase 3 may add a copy). The old folder is left for the admin to delete. |
   | Recycle Bin | Change the location; the bin move (decision 10) carries every item over in the background, and the row shows progress. |
   | Made in the app | Nominate the new library; the old library stays, with its narration and voice notes where they are, and keeps serving them because every row stores its own path. |
   | Photo Inbox | Already a library; nothing to move. The row shows it. |
   | Renders and music | The one small move: uploaded music and unfinished renders are stored by a key relative to the thumbnail folder, so turning this room on moves the `music/` and `slideshows/` buckets (a handful of files) into `Renders/`, copy-then-delete, refused whole if any file fails. |
   | Backups | Change the path; old zips stay where they are and the Backups page lists both places until the old one is empty. |

5. **Changing or clearing App storage is refused while a room uses it**
   (decision 4). The rows say which rooms those are; each is moved out or
   turned off from its own row first, then the folder is free to change.
   The libraries it made are ordinary libraries and stay wherever they are.
6. **Docker changes nothing.** `BACKUP_PATH` and the mounted volumes keep
   their meaning; App storage is a path inside a mounted container like any
   library, chosen in the app, not in the compose file. The Unraid template
   is untouched.
7. **Data the app already recorded keeps its own path**: `trashed_items.
   trash_root`, voice note and narration `library_items` rows, backup file
   names. Nothing in this plan rewrites those rows, which is what makes step
   1 true.

## How it ends

A fresh install is asked one question about disks and answers it once; the
thumbnails, the bin and the renders follow it, and the Inbox and the library
for what the family makes in the app are each one confirmed click away, in
folders whose names say what they are. An admin who wants it otherwise
points a room somewhere else, or turns it off, from one screen, and is told
exactly what will happen before it does. An old install notices nothing
until someone opens that screen and sees, for the first time, every location
in one place.
