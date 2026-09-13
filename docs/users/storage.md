# Storage

Before you can add a library, the server needs to know where things live. It all
sits in **Control panel → Library → Storage**, in three parts:

| | What it is | Why it's needed |
|---|---|---|
| **Digital Library containers** | The folders your libraries are allowed to read | A safety boundary: a library can only ever point somewhere inside an approved container, so a mistyped path can't wander off into the rest of the disk. |
| **System data** | The one folder the app needs to run: thumbnails, backups and metadata go there | Required. No library can be added until thumbnails have somewhere to go. Thumbnails and backups can each have a folder of their own. |
| **App storage** | One optional folder for the Photo Inbox, the library for what the family makes in the app, renders and map data | So those answers are given once, in one place. Each of its rooms can use it, keep a place of its own, or stay off. |

Until system data is chosen and at least one container exists, **Add library**
stays disabled and the Libraries page tells you so, with a button straight back
here.

The Recycle Bin's location is not on this page: it is on the **Recycle Bin**
page, in its settings, where you are when you think about deleted files.

## Digital Library containers

A container is a root folder you're approving. Libraries can then use the whole
container or any folder inside it.

Choose **Add container** and give it a name and a path:

![The Add storage container dialog](images/12-storage-add-container.png)

| Field | Example |
|---|---|
| **Container name** | `Family media` — a label for you, shown when picking folders |
| **Container path** | `D:\ProjectTesting\AppDocTest` — must already exist on the server |

The folder has to exist already; the app won't create it. If the path is wrong
or unreadable, you're told immediately rather than at scan time.

Containers come first on the page because libraries and App storage live inside
one.

## System data

System data is the folder the app keeps what it needs in: the **thumbnails** it
makes, the **backups**, and exported book **metadata**. The **database** is not
part of the choice. Every setting lives in it, including this one, so it stays
where the server was installed (`DB_PATH`), and the block shows its path so you
know where it is.

On a new install the block asks for the folder and suggests the one next to the
database: `/config` in Docker, the app's `data` folder otherwise. Take the
suggestion or type another folder, on any disk. It doesn't have to be inside a
container, but it can't be inside a library, and it can't be a container itself.
The app makes the folder if it isn't there yet and checks that it can write in it.
Choosing it shows a box with the exact path first.

Under the folder, a line tells you how much of its disk is free, and the ⓘ beside
the heading gives a rough idea of how much room the app needs: about 80 KB per
photo or video for thumbnails (roughly 8 GB for 100,000), a few hundred MB per
backup, and a few KB per book of metadata. When less than a tenth of the disk is
free, the block warns you.

Once it is set, the block lists what lives there:

| Row | Where it goes | Change |
|---|---|---|
| **Database** | set when the app was installed | — |
| **Thumbnails** | `thumbnails` in system data | a folder of their own, for example on a faster disk |
| **Backups** | `backups` in system data | a folder of their own, for example on another disk |
| **Metadata** | `metadata` in system data | — |

When backups sit on the same disk as the database, the row says so: a failed disk
would take both. A folder on another disk, or a copy made regularly somewhere
else, is the safer arrangement.

An environment variable still works for a folder: `THUMBNAIL_PATH`,
`BACKUP_PATH` or `METADATA_PATH` are used when no folder was chosen on this
page, and the row says so.

**Change** on the block moves system data somewhere else. Thumbnails, backups and
metadata that live in it move along, each as a task; the ones with a folder of
their own stay where they are. **Change** on the Thumbnails or Backups row gives
that one a folder of its own, or sends it back to system data, and carries what
is already there across the same way.

> **Running in Docker?** Use the path *inside the container* — the one you mapped
> your volume to — not the path on the host.

## App storage

On a new install the App storage block says **Not set** and every room below it
reads **Not set** or **Off**:

![Storage before anything is configured](images/10-storage-empty.png)

Choose **Choose folder** and pick a folder inside one of your containers. It has
to exist already, it can't be the container itself (the app makes its own
folders in it), and it can't be inside a library. A folder beside your media is
the tidy choice:

```
D:\ProjectTesting\AppDocTest\iSputnik
```

A box shows the exact path and asks you to confirm. Choosing the folder records
it and nothing else: no room changes until you change its row. Two rooms do
follow it straight away when they were never given a place of their own:
**Renders** go to `Renders\` under it, unless you have told the row to stay
inside the thumbnail folder, and **Map data** goes to `Map data\` under it.

### The rooms

Nothing inside App storage shows up in the gallery on its own. The two rooms
that are gallery libraries, the Photo Inbox and App files, are left out
of the Timeline, Memories, the Home page, People, the map and every picker,
the way an Inbox always was; what they hold is reached from the stories,
photos and family tree that made it, or by choosing the library by name in
the gallery's library filter, where it is labelled. A photo from such a
library that a story, an album or a slideshow already holds keeps showing
there, and opens in the viewer as before. The other rooms are not libraries
and are never scanned.

| Room | Use App storage | Its own place | Off |
|---|---|---|---|
| **Photo Inbox** | `Photo Inbox\`, made as a library | a gallery library of your own becomes the Inbox | no Inbox |
| **App files** | `App files\`, made as a library | any gallery library of your own | nothing can be recorded or uploaded from the app |
| **Renders** | `Renders\` | inside the thumbnail folder | — |
| **Map data** | `Map data\` | its own folder (`MAP_DATA_PATH`, else beside the database) | — |

Uploaded slideshow music is not really a room any more: once an App files
library exists, every track lives in its `Slideshow music\` folder as an
ordinary audio asset, visible in the gallery and backed up with the rest, and
music uploaded before that moves itself there shortly after the server starts.
The Renders room then holds only finished slideshow movies.

Each row says which column it is in, in words, and **Change** opens a small
chooser with the options for that room. Picking one doesn't apply it: a box
names the room, shows the exact folder it will use from now on, says what moves
and what doesn't, and offers Cancel or a verb. Nothing happens until you press
the verb.

![The Renders chooser: use App storage, or stay inside the thumbnail folder](images/101-storage-room-chooser.png)

For the two library rooms, **A library of my own** lists your gallery libraries:
pick one to hold what the family makes in the app, or to become the Photo Inbox.

![The App files chooser with A library of my own picked and the library list under it](images/105-storage-own-library.png)

Two rooms are worth a word each:

- **Photo Inbox.** Switching to App storage when you already have an Inbox of
  your own moves that library's folder into App storage whole, photos waiting
  and all, and it stays the Inbox; the confirmation says how many come along,
  and nothing is rescanned. With no Inbox yet, a new gallery library is made in
  the room's folder. Switching off leaves the library as an ordinary library
  with its files where they are; it refuses to turn off while photos are still
  waiting in it, so nothing lands on the Timeline unreviewed.
- **App files.** Switching to App storage when a library of your own is
  nominated moves that library's folder into App storage whole, with everything
  in it, and it stays the library for what is made in the app. With none
  nominated, a new gallery library is made in the room's folder and nominated.
  Switching off only clears the nomination.

### What it holds: the Contents page

**Library → Storage contents**, the tab beside Storage, answers the other question about App storage:
what is in it, and why. The top table gives every room a count and a size,
counted from the app's own records where it keeps them (the two libraries) and
from the disk where it does not (renders, map data),
plus the hidden `.staging` folder where uploads wait between arriving and
landing. Under it, the **App files** library is listed folder by folder and
file by file, each with the thing it belongs to: the story a recording
narrates, the photo a voice note sits on, the track a music file plays as,
the slideshow a movie was rendered from, the person a family-tree photo is
of, each a link where there is a page to go to.

![The Contents page: every room with its size, and the App files library folder by folder with what owns each file](images/107-storage-contents.png)

A file nothing owns any more, because the story, photo or slideshow it served
has since gone, is marked an **orphan**, and that is the one thing the page
deletes: it goes to the Recycle Bin like any deleted file. Files the app's
folders do not account for, such as photos uploaded into the library by hand,
are listed as **Other files**, with the way out: open their folder in the
gallery and move it to another library.

### How a move runs

Every move is a **task**: it appears on the Tasks page as a *Storage move*
with its progress and an estimate, it can be stopped there or from the row,
it is timed, and a server restart picks it up again where it was. The row on
this page shows "Moving… 14 of 230" while it runs, and afterwards anything it
could not carry with a **Retry**. The activity log records when a move starts
and how it ended: how much it carried, how long it took, and what failed.

What keeps it safe:

- On the same disk a move is a rename: instant whatever the size, and either
  it happens or it does not.
- Across disks nothing is copied while you wait. The task copies one file at a
  time and checks each one arrived whole, by size, before the original is
  removed. A file that does not check out stays where it was and is listed.
- A library keeps its old folder until the last file is across and verified,
  then switches to the new one in one step and the old folder goes. Stopping
  the move, or a failure, leaves the library exactly where it was.
- One move runs at a time, and never while a library is being scanned; a scan
  waits for a move the same way.

### Changing the folder once rooms use it

The folder is the base of every file its rooms hold, so **Change** on the top
block asks about each room that uses it. The confirmation lists those rooms
with a tick beside each: a ticked room is carried to the new folder, an
unticked one stays where it is and leaves App storage.

![The App storage folder-change confirmation: the new folder, and a tick beside each room that uses it](images/106-storage-folder-change.png)

What "carried" means depends on the room:

- **Renders** and **Map data** are carried by the same tasks their rows use,
  one task each, and the rows show the progress. Left behind, renders go back
  inside the thumbnail folder and map data to its own folder.
- **Photo Inbox** and **App files** move as whole folders, each its own
  task, and the library follows its folder once every file is across: nothing
  is rescanned, and what is waiting for review stays waiting. Left behind, the
  library stays where it is as a library of your own, still the Inbox or still
  nominated.

Every check happens before anything changes: if the new folder already holds
a room's folder, a library room is being scanned, or a move is still running,
nothing changes and the box says why. The tasks then run one after another.
**Clear** takes the leave-behind path for every room. Both wait for a move
already running on the page to finish first.

Once system data is chosen and a container is listed, you're ready for
**[Setting up libraries](libraries.md)**.

### An install that already had these set

Nothing moves when you update to 4.6. The first start writes system data from
what was already in use: the folder that holds your `thumbnails` folder when it
has that name and holds no library (in Docker, `/config`), otherwise the folder
next to the database. Thumbnails, backups and a Recycle Bin that lived somewhere
else, including inside App storage, keep that folder as a place of their own.
App storage keeps its folder and its other rooms as they were.

One name did change: the App files room was called *Made in the app* until
3.86.0, and an install that made the folder under that name keeps it. The room
still reads as using App storage, and nothing moves. If you would like the
folder to match, the App files row offers **Rename folder**: a box shows the
exact before and after, and the rename runs as the same task a library move
uses, the library following its folder in the same step, so nothing is
rescanned. On the same disk it is a single rename.

![Storage once configured](images/11-storage-configured.png)

## How to organise the folder underneath

One container with a folder per library and App storage beside them is the
arrangement most people end up with, and it's what the rest of these guides
assume:

```
D:\ProjectTesting\AppDocTest\      ← the container
├── Audio\                         ← an audiobook library
├── Ebooks\                        ← an ebook library
├── Gallery\                       ← a gallery library
├── FamilyTree\
└── iSputnik\                      ← App storage
    ├── Photo Inbox\               ← a library the app made
    ├── App files\                 ← a library the app made
    ├── Renders\
    └── Map data\
```

System data sits wherever you chose, often outside the container altogether:

```
/config\                           ← system data (Docker)
├── db\                            ← the database, set at install
├── thumbnails\
├── backups\
└── metadata\
```

You can add several containers if your media lives on different drives. The
**Libraries** column on this page shows how many libraries are using each one,
and a container can't be deleted while a library still depends on it.

## Your original files are never modified

Worth stating plainly, because it governs the whole design: **scanning reads,
it never writes.** The app catalogues what it finds, and everything it derives —
covers, previews, metadata, your reading position — is kept in its own database,
in system data and in App storage. Renaming a library, editing a book's
title, or deleting a library never touches the files on disk.

The exceptions are the things you'd expect to touch files, and only those:
uploading adds a file, deleting an *item* (when the library allows it) moves it
to the Recycle Bin, and changing a room on this page moves what that room holds,
after telling you so.

Uploads wait in a hidden `.staging\` folder inside App storage while they
arrive, rather than in the system's temp folder, so a long recording cannot
fill a small root partition.
