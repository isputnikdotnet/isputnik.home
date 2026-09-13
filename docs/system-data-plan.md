# System data & App storage — plan

Status: agreed 2026-09-12, revised the same day to put the four optional features
behind a single App storage switch. **Phases 1 and 2 built 2026-09-12, uncommitted**
(phase 1: migration 75, `gallery/system-libraries.ts`; phase 2: `core/system-data.ts`,
`modules/library/system-data*.ts`, `SystemDataPanel`; both suites, typecheck and
`check:ui` pass, and both were checked on the dev database, which the startup
conversion converted). Phases 3 and 4 not started. Replaces the
room model of [app-storage-plan.md](app-storage-plan.md) (shipped 3.77.0–4.5.0).
Decisions are recorded so they need not be re-argued; open questions so they are
not silently answered by whoever writes the code.

## Why

The Storage page asks an admin for seven rooms with two or three modes each
(App storage / its own place / off), plus the App storage folder, plus a list of
rooms to carry along when that folder changes. That is about twenty settings.
"Its own place" means something different on every row: a folder setting, an
environment variable, a library, or "inside the thumbnail folder". And the rows are
not one kind of thing. Some are required (thumbnails), some are safety nets (bin,
backups), some are caches (map data), and some are family content (Photo Inbox,
App files).

Photo Inbox and App files are also ordinary gallery libraries. The gallery keeps
having to be taught to leave them out (the `policy_json.inbox` flag, and
`isInsideAppStorage()` guessing from a path). That guessing caused the 3.84.1
regression.

## The model in one table

| Question | Answer |
| --- | --- |
| What must exist for the app to work? | **System data**: one folder the admin picks, before the first library. Thumbnails, backups and metadata go there. |
| Can parts of it live elsewhere? | Thumbnails and Backups each have a **Change**. Nothing else in system data does. |
| What is optional? | **App storage**: one switch, off on a new install. |
| What is in App storage? | Four things, always together: **Photo Inbox**, **App files**, **Renders** and **Map data**. On means all four exist; off means none do. |
| Where does App storage live? | **In system data** (a folder inside it) or **a custom folder** the admin picks. |
| What about the Recycle Bin? | Not a storage choice any more. By default it is a `.trash` inside each library, and the one-folder option lives on the Recycle Bin page. |
| Are Photo Inbox and App files libraries? | **System libraries**. Inside, their items are gallery assets. The app makes them, one of each, and they never appear as libraries. |
| Who can see what is in them? | Not library access rules (phase 4). The Inbox: admins and the reviewers an admin names. App files: whoever can see what each file belongs to — the story, the photo, the slideshow, the person in the family tree. |

The Storage page becomes three blocks: **Containers** · **System data** ·
**App storage**.

```
Containers                       where libraries may live                     (unchanged)

System data ⓘ    D:\iSputnikData                        1.6 TB free of 4 TB      Change
  Database       C:\iSputnik\data\db\isputnik.sqlite                 (set at install)
  Thumbnails     D:\iSputnikData\thumbnails            46 MB                     Change
  Backups        D:\iSputnikData\backups               3 files                   Change
  Metadata       D:\iSputnikData\metadata

App storage ⓘ                                                                      ○─  Off / On
  Where          (•) In system data   D:\iSputnikData\app-storage
                 ( ) Custom folder    [ D:\Media\iSputnik        ] Browse
                                                        1.6 TB free of 4 TB      Change
  Photo Inbox ⓘ    …\Photo Inbox       7 photos waiting · 38 MB
  App files ⓘ      …\App files         52 files · 1.9 GB
  Renders ⓘ        …\Renders           nothing rendering
  Map data ⓘ       …\Map data          412 MB of 1 GB
```

Mock (private link, interactive):
[System Data Storage Mock](https://claude.ai/code/artifact/1c8be658-dec4-469f-822c-922f038b98da).
It shows both a new Windows install and the upgraded Unraid box, plus the setup
guide steps, the Recycle Bin location card and an "App storage is off" notice.

## Decisions taken

### System data

1. **System data is required, and the admin picks it.** The app installs on Unraid,
   on other Docker hosts and on bare Windows, so no single default is right. The
   picker suggests the folder next to the database (`/config` in Docker,
   `<app>\data` elsewhere), and the admin confirms that or picks another. No
   library can be created until system data is set. This replaces "Configure
   thumbnail storage before creating a library".
2. **The database is not inside the choice.** Every setting, including system
   data itself, lives in the database, so the running app cannot pick where the
   database lives. It stays where the install put it (`DB_PATH`, default
   `<app>/data/db`) and is shown read-only in the System data block. Moving it is
   the open question below.
3. **Folder names are fixed and lowercase inside system data**: `thumbnails/`,
   `backups/`, `metadata/` and, when App storage is kept there, `app-storage/`.
   The first three are the names Docker installs already use under `/config`, so
   an existing install needs no move on Linux, where case matters.
4. **Thumbnails and Backups can each be changed.** An override is stored as its
   own setting (the existing `library.thumbnail_path`, and a new `backup_path`).
   Without an override they follow system data. Changing either shows a
   confirmation naming both paths and the size, then runs one `MOVE_STORAGE` task
   (same disk: rename; another disk: copy, verify, then delete).
5. **Backups on the same disk as the database are allowed.** The Backups row then
   shows a line suggesting a copy on another disk. The check compares device ids
   (`fs.statSync().dev`).
6. **The Dockerfile stops setting `THUMBNAIL_PATH`, `BACKUP_PATH` and
   `METADATA_PATH`.** Those are now defaults under system data. The variables
   still work: a folder chosen on the Storage page wins, then the variable, then
   system data, and a row the variable decides says "Set by `BACKUP_PATH`" and
   still offers **Change** *(as built: the page's choice wins rather than the
   variable pinning the row, so an install that set both keeps what it had)*.
   Without `BACKUP_PATH`, the last resort is `backups` beside the database's
   folder (`/config/backups` in Docker), never the image's own filesystem.

### App storage

7. **One switch for all four.** App storage is a `shared/ToggleSwitch` in its
   block's heading, off on a new install. On, the app creates Photo Inbox, App
   files, Renders and Map data together; off, none of them exist. There are no
   per-feature switches, so there are no dependencies to explain (Renders needing
   App files, for instance).
8. **Where it lives: In system data, or a custom folder.** Two radio choices under
   the switch:
   - **In system data**: `<system data>/app-storage/`. Preselected, because it is
     one click and fine for a small household.
   - **Custom folder**: a path field with Browse. The folder holds the four
     subfolders directly, which is what existing installs already have.

   The where-choice can be made before switching on. Switching on with neither set
   uses the preselected one. Afterwards **Change** moves the whole of App storage
   as one `MOVE_STORAGE` task, with one confirmation naming both paths and the size.
9. **The four are listed, not switched.** Under the where-choice, a plain grid has
   one row per part: name with a `shared/InfoHint` · folder · what it uses. Cards
   were tried in the mock and read as too busy. The info hint holds what the part
   is for, its rough space need, and why App storage may refuse to switch off.
10. **Folder names inside App storage** stay as today, so current installs keep
    theirs: `Photo Inbox/`, `App files/` (a `Made in the app/` folder is still
    recognised), `Renders/` and `Map data/`.
11. **App storage decides where map data lives, not whether it is downloaded.**
    Offline tiles and place names stay separate switches on the Maps page. So
    switching App storage on downloads nothing. While App storage is off, those
    Maps switches are disabled, with a line pointing to Storage.
12. **An empty Photo Inbox stays out of sight.** With App storage on, the Inbox
    always exists, even in a household that never scans prints. While it holds
    nothing, it shows nowhere a member looks: no Review entry, nothing on For you.
    Admins reach it from its row on the Storage page, which is where drop links and
    the first scan into it start.
13. **What App storage off means elsewhere.** Every feature that writes into it
    (story recordings, voice notes on photos, family-tree uploads, slideshow movies
    and music, offline maps, the Inbox) is refused by its route with a clear error
    and shown disabled in the UI. Admins see "Turn on App storage in Storage" with a
    `controlHref()` link; everyone else sees "Ask an admin to turn on App storage".
    The Storage page stays the one place that decides storage.
14. **Switching off:**
    - Refused while the Inbox holds photos or App files holds files. The message
      says how many, and links to Review and to the Contents tab.
    - Refused while a movie is rendering.
    - Otherwise a confirmation says the map tiles and place names will be deleted
      (both download again) and the empty folders removed.

### Disk space

15. **Disk space is shown wherever a folder is chosen or shown.**
    - Every folder line carries a free-space meter ("1.6 TB free of 4 TB on D:"),
      read from `fs.statfs`. Folder fields update the meter as the admin types.
    - The guidance lives in info hints, so the page stays quiet. Only the
      low-space warning is a `MessageBox`, because it is something to act on.
    - System data's hint, "How much space system data needs": thumbnails
      about 80 KB per photo or video (roughly 8 GB for 100,000, and an SSD keeps
      browsing quick), backups a few hundred MB each times the number kept, and
      metadata a few KB per book.
    - App storage's hint, "Plan for growth": it holds family photos and videos
      and only gets bigger, so a custom folder on a media disk is right for a
      large household. Kept in system data, it shares that disk with thumbnails
      and backups, and a line under the path says so.
    - Each part's hint gives its rough need. Photo Inbox: the photos imported,
      until reviewed. App files: about 130 MB per minute of phone video, 1 MB per
      minute of voice. Renders: about twice a movie while it renders. Map data:
      the map cache limit plus tens of MB for place names.
    - Below 10% free, a warning `MessageBox` names the disk and what will fail
      when it fills. It shows in the picker, the confirmation and on the block.
      The thresholds and estimates are to be checked against real installs while
      building.

### Shared rules

16. **Validation for the system data and custom App storage folders:** an absolute
    path that exists or can be created, that the app can write to (checked with a
    test file), not inside any library, and not a container itself. Neither has to
    be *inside* a container. Containers approve folders people browse, and these
    are the app's own. In the UI, App storage is never called a "container": that
    word already means where libraries live.
17. **Photo Inbox and App files are system libraries**, marked with a new
    `libraries.role` column (`'inbox' | 'app-files'`, at most one of each, enforced
    by a unique partial index created in migration 75, not in `schema.sql`).
    - `role` replaces `policy_json.inbox`, the `house_library` setting, and
      `isInsideAppStorage()` as the way to recognise them.
    - The app creates them when App storage is switched on. They cannot be
      created, renamed or deleted by hand (the library routes return 409). Moving
      one means changing App storage.
    - Left out of: the Libraries list, the Add library wizard, the library filter
      and containers' library counts.
    - The scopes stay two, now defined on the column: *reachable* = accessible
      minus `role = 'inbox'` (stories, albums, slideshows, viewer), and *browse* =
      accessible and `role IS NULL` (timeline, folders, map, People, Home). Never
      take App files out of the reachable scope again (3.85.0).
    - Until phase 4, access rules stay on the library row, and phase 3 opens their
      editor from the part's row on the Storage page. Phase 4 removes them
      (decisions 20–25).
    - They are scanned, backed up and face-scanned exactly as today.
    - A system library is exempt from the container rule in `library-source.ts`.
      A user library may not be created inside App storage.
18. **The Recycle Bin leaves the Storage page.** The existing `trash_root` choice
    (inside each library, or one folder) moves to a Location card on the Recycle
    Bin page, with the existing bin move task behind it.
19. **The setup guide** (WelcomePage) gets a required **System data** step before
    **Create a library**, then a recommended **App storage** step with the switch
    already on and **In system data** preselected, so it takes one click. It can
    be skipped. The step lists what App storage unlocks.

### Access without library rules (phase 4)

Added 2026-09-12: the last place the two system libraries still behave like
libraries is their access settings. Being libraries under the hood stays (their
items are gallery assets, which is what gives them thumbnails, the viewer, links
from stories and the move-on-Keep for free); having an owner, a visibility and a
member list does not.

20. **Neither system library has access rules of its own.** No owner, no
    visibility, no public role, no member list, and the Access editor never opens
    for them. Who may see the Inbox is a reviewer list (decision 21); who may see a
    file in App files is decided by what it belongs to (decision 22). Their
    `assignments` rows are removed by the phase 4 migration, after what they
    granted is carried across.
21. **Photo Inbox: admins, plus the reviewers an admin names.**
    - The Inbox row on the Storage page gets **Reviewers**: members and groups,
      each with one of two levels. **Can add details**: dates, places, notes and
      voice notes (today's edit right). **Can keep or discard**: everything above,
      plus Keep, Discard and drop links (today's delete right).
    - Admins always review. Nobody else sees anything of the Inbox: not in Review,
      not on For you.
    - Asking someone what they remember keeps working as it does now, through an
      album shared for editing, so they see only the photos they were asked about.
    - Migration: every user or group holding viewer, member or contributor on the
      Inbox becomes a reviewer who can add details, and manager becomes can keep
      or discard. The Everyone grant maps the same way onto the Everyone group.
      Nobody who can see the Inbox today loses it (the owner's call, 2026-09-12:
      a viewer becomes someone who can add details rather than being dropped).
22. **App files: a file is visible to whoever can see what it belongs to.**

    | The file is | Who sees it |
    | --- | --- |
    | A story recording, or a photo placed in a story | whoever can see the story |
    | A voice note on a photo | whoever can see that photo |
    | A slideshow's finished movie | whoever can see the slideshow |
    | Uploaded slideshow music | whoever can see a slideshow that uses it, and whoever can make slideshows (the music picker's audience) |
    | A family-tree photo | whoever can see that person in the family tree, including branch-scoped access |
    | Owned by several things | whoever can see any one of them |
    | Owned by nothing (an orphan) | admins only, from the Contents tab |

    Admins see every file, and the person who added a file always sees it. A file
    whose only owner the viewer can't see stays hidden, and the owner shows the
    same "not something you can see" state it shows today.
23. **Changing a file follows its owner too.** A file enters App files only through
    the feature that owns it, and is changed or removed there (a story's recording,
    a photo's voice note, a slideshow's music). Edit rights on the file are the
    edit rights on its owner. The gallery's own tools (move folder, tags, the
    Recycle Bin page's delete) never offer App files items on their own.
24. **One check, used everywhere an item is named by id.** A single
    `appFileAccess(user, itemIds)` in `gallery/app-files-access.ts`, built on
    the owner joins the Contents page already uses (`app-storage-contents.ts`).
    The reachable scope stops including App files as a whole library. Every route
    that serves or hydrates an item by id (thumbnail, stream, lightbox, story,
    album and slideshow hydration, the family tree) asks this check for App files
    items. The browsing scopes don't change: App files is never browsed.
25. **Nothing about them shows outside Storage.** No Libraries-list row (phase 3
    already), no library filter entry, no access editor. The Storage page's parts
    grid keeps **Open** (Inbox, for admins) and **Contents** (App files), and loses
    **Access**, which becomes **Reviewers** on the Inbox row.

## Upgrading an existing install

Upgrading moves nothing. A one-time conversion at startup (after migration 75)
writes the new settings from what is in effect today:

| Today | After |
| --- | --- |
| Thumbnails at a path (setting, env or App storage room) | system data = the parent folder, if the path is `<parent>/thumbnails`. Otherwise system data = the folder next to the database, and the thumbnail path is kept as an override |
| `BACKUP_PATH` / backups room | `backup_path` override, unless it equals `<system data>/backups` |
| `app_storage.path` set | App storage **on**, custom folder = that path |
| No App storage path, but an Inbox, a nominated App files library, renders or map data in use | App storage **on**, in system data. What already exists stays put (next row) |
| Nothing in use | App storage **off** |
| An Inbox library (`policy_json.inbox`) | `role = 'inbox'`. If several exist, the one inside App storage (else the oldest) gets the role, and the others become ordinary gallery libraries with a notice on the Storage page |
| `house_library` nominated | that library gets `role = 'app-files'` |
| A part outside App storage (a system library elsewhere, map data at `MAP_DATA_PATH`, renders inside thumbnails) | stays put. Its row says "outside App storage" and offers **Move** (one task, one confirmation) |
| Recycle Bin room = App storage | `trash_root` = that folder, shown on the Recycle Bin page |

The owner's Unraid box, as a check: system data `/config` (thumbnails and backups
already there), App storage on at `/media/media/iSputnikApp`, Photo Inbox and the
Random library (at `…/Made in the app`) become the two system libraries, and Recycle
Bin `/media/media/iSputnikApp/Recycle Bin` moves to the Recycle Bin page. No file
moves.

## What goes away

- `APP_ROOMS` and room modes (`app | own | off`), `app-storage-rooms.ts`,
  `app-storage-switch.ts`, the carry list in `app-storage-path.ts`, and
  `PUT /api/storage/app-storage/rooms/:room`.
- The own-library pickers for Inbox and App files.
- `galleryLibrariesLeftOutOfScope()` path inference, `photoInboxLibraryIds()`
  flag reads, and the `house_library` setting.
- The "(App storage)" suffix in library filters, because system libraries are not
  in them.
- Rename folder (3.90.0) is kept only while a `Made in the app/` folder exists.

## Phases

**Phase 1: system libraries.** *(built)* `libraries.role` plus backfill; scope
resolvers, face scanner, duplicate inbox check, feed and serializer read the
column; `getHouseLibrary()` / `setHouseLibrary()` read and write the role; create,
rename and delete refused for system libraries. No change to where anything lives,
and today's Storage page keeps working on top of the role. Until phase 3 takes them
out, system libraries stay in the Libraries list with a System badge, no Delete, a
locked name and no Inbox toggle. Tests: scope resolvers on role, backfill with
zero, one and two Inboxes, and the 409s.

As built, beyond that: handing the Inbox role to another library (the Storage
page's "own" choice) is refused while the current Inbox has photos waiting, because
there is only one Inbox now; `createLibraryRecord` answers 409 when the role is
already held; the Libraries list's old "System library" label for a library with no
owner is now "No owner", so the words mean one thing; the library payload's
`appStorage` flag is gone in favour of `role`, and the gallery filter labels App
files as such.

**Phase 2: system data.** *(built)* `system_data` setting and its resolvers in
`core/system-data.ts`; thumbnails, backups and metadata default under it;
`backup_path` override plus Change with a move task; library creation gated on
system data; same-disk backups line; the upgrade conversion for system data;
Dockerfile ENV cleanup; `search-index.ts` terms; en/ru keys.

As built:
- The Recycle Bin, Thumbnails and Backups rooms are gone from App storage's code
  (`APP_ROOMS` is Inbox, App files, Renders, Map data), not just hidden. The
  bin's location is `changeTrashRoot()` behind the Recycle Bin page's existing
  location row and `PUT /api/storage/trash-root`; the setup guide's bin step lost
  its "Use App storage" button.
- Server: `modules/library/system-data.ts` (validation, view, changing the folder,
  thumbnails and backups), `system-data-routes.ts` (`GET/PUT
  /api/storage/system-data`, `PUT …/thumbnails`, `PUT …/backups`,
  `POST/DELETE …/moves/:room`, `GET /api/storage/disk-space?path=`), and
  `system-data-upgrade.ts`, called from `index.ts` before the backups plugin.
  `MOVE_STORAGE` gained the `backups` and `metadata` kinds.
- The conversion takes a thumbnail folder's parent as system data only when that
  parent holds no household library and no container (so `D:\Demo\thumbnails`
  beside `D:\Demo\media` does not make `D:\Demo` system data), and recognises
  the old image's `/config/thumbnails|backups|metadata` by the image's database
  path. On the dev database it wrote system data = the repo's `data` folder,
  kept thumbnails at `D:\Demo\thumbnails` and the bin at its App storage folder.
- Web: `features/control/sections/storage/SystemDataPanel.tsx` and `SpaceMeter.tsx`,
  with `styles/system-data.css` (a page stylesheet, because the setup guide shows
  the same panel and does not load `admin.css`). The setup guide's thumbnail-folder
  fallback is gone; its Storage step is containers, the panel, then App storage.
- The system data folder is typed (with the suggestion as placeholder), not picked
  with the container folder picker: it need not be inside a container.
- Left for phase 3: screenshots 10–12, 103, 106 and 107 still show the old rooms,
  and 102 (the bin's room confirmation) was dropped from the guide.

**Phase 3: App storage switch.** The `app_storage` setting becomes
`{ enabled, where: "system" | "custom", path }`; the switch, where-choice, parts
grid and Change on the Storage page; switching on creates the system libraries and
folders; switching off with its refusals; routes and UI refuse and disable while
off (decision 13); the Maps page's offline switches follow decision 11; the empty
Inbox hidden (decision 12); system libraries leave the Libraries list; the upgrade
conversion for App storage; the setup guide steps (decision 19); guides
`users/storage.md` and `users/first-run.md` rewritten; screenshots 10–12 and
101–107 regenerated or retired.

**Phase 4: access without library rules.** A migration turns the Inbox's
assignments into reviewers (decision 21) and deletes both system libraries'
assignments; `gallery/app-files-access.ts` with one test per owner kind in the
table of decision 22, plus several owners, the uploader and an orphan; every
caller of `resolveGalleryScopeLibraryIds` (38 today) and every item-by-id route
audited to ask the check for App files items; Reviewers on the Storage page's Inbox
row; the Access link gone; guides `users/photo-inbox.md` and
`users/storage.md` updated. Done after phase 3, because the parts grid it changes
is built there.

## Non-goals

| Not building | Why |
| --- | --- |
| Switching the four parts on separately | One switch is the point. A part a household does not use costs an empty folder. |
| Changing the media type of Inbox or App files | Their items are gallery assets. Thumbnails, the lightbox, faces and story blocks all rely on that. A `role` is enough. |
| Access settings on a single file in App files | A file is seen through what it belongs to (decision 22). Sharing a recording on its own is sharing its story. |
| Moving pre-2.23 per-library `.trash` folders | As before, default changes apply to new installs only. |

## Open questions

1. **Moving the database.** Should a later phase allow it? It would need a small
   pointer file beside the app, read before the database opens, plus a restart.
   Until then the database stays where the install put it (decision 2).
2. **Working out App files access at request time, or keeping a table.** Decision
   24 starts from the owner joins the Contents page already runs. If a page naming
   many items (a long story, a slideshow) gets slow, the alternative is an
   `app_file_owners (item_id, owner_type, owner_id)` table that each feature
   writes when it attaches a file. Measure on the owner's Unraid box before
   choosing.
