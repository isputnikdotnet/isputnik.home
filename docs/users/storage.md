# Storage

Before you can add a library, the server needs to know where things live. It all
sits in **Control panel → Library → Storage**, in three parts:

| | What it is | Why it's needed |
|---|---|---|
| **Digital Library containers** | The folders your libraries are allowed to read | A safety boundary: a library can only ever point somewhere inside an approved container, so a mistyped path can't wander off into the rest of the disk. |
| **System data** | The one folder the app needs to run: thumbnails, backups and metadata go there | Required. No library can be added until thumbnails have somewhere to go. Thumbnails and backups can each have a folder of their own. |
| **App storage** | One optional switch for the Photo Inbox, the library for what the family makes in the app, renders and map data, kept in one folder | Off until you switch it on. The four parts go together, so it is one answer rather than four. |

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

App storage is one switch for four things that always go together:

| Part | What it holds |
|---|---|
| **Photo Inbox** | Scans and drop-link uploads waiting to be reviewed ([Photo Inbox](photo-inbox.md)) |
| **App files** | Story recordings, voice notes on photos, family-tree uploads, finished slideshow movies and uploaded music |
| **Renders** | Work files while a slideshow is saved as a movie |
| **Map data** | Kept maps and the place-name databases ([Maps](control-panel.md#maps)) |

It is **off** on a new install, and it is optional: libraries, stories, albums and
the gallery all work without it. While it is off, recording and uploading in the
app, slideshow movies and music, kept maps and the Inbox are unavailable, and the
places that offer them say so, with a link here for admins.

![Storage before anything is configured](images/10-storage-empty.png)

### Switching it on

Before switching on, choose where it lives:

- **In system data** (already chosen): a folder called `app-storage` inside system
  data. One click, and fine for a small household, but it shares that disk with the
  thumbnails and backups.
- **Custom folder**: type a folder, on any disk. It does not have to be inside a
  container, but it can't be a container itself or sit inside a library. In a
  household with a lot of video, a folder on your media disk is the better home.

The free space on that disk shows under the choice, and the ⓘ beside the heading
gives a rough idea of what each part needs. Then flip the switch: a box names the
exact folder, and nothing happens until you confirm.

Switching on makes the **Photo Inbox** and **App files** libraries and the
**Renders** and **Map data** folders there. Nothing is downloaded: kept maps are
still switched on from the Maps page. Music waiting to be imported and map data
already kept elsewhere follow into App storage as tasks.

Both libraries are **system libraries**: the app makes them, keeps their names,
and they are not listed on the Libraries page or in the gallery's library filter.
Nothing in them shows up on the Timeline, Memories, the Home page, People, the map
or the pickers on its own; a recording or a voice note is reached from the story or
the photo it belongs to, and a photo a story, album or slideshow already holds keeps
showing there. Who reviews the Inbox is set from **Reviewers** on its row: admins
always do, and anyone you name can add details or keep and discard
([Photo Inbox](photo-inbox.md)).

**Who sees a file in App files** follows what it belongs to; there is nothing to
set. Admins see everything. Anyone else sees:

| The file | Seen by |
|---|---|
| A story recording, or a photo a story holds | whoever can see the story |
| A voice note | whoever can see the photo, and whoever recorded it |
| A slideshow's photos, cards, clips and saved movie | whoever can see the slideshow |
| Uploaded music | every member |
| A family-tree photo or portrait | every member |
| A file nothing in the app owns | admins only |

Files put into App files by hand, or ordinary photos in a library chosen as App
files before 4.6, are used by nothing in the app, so only admins see them. The App
files row says how many there are, and the Contents page lists each file with what
it belongs to, if anything. Move the folders of the ones nothing uses to another
library to share them again. Where a file sits does not matter: a photo uploaded
while writing a story lands in a dated folder and still belongs to the story.

![Storage once configured](images/11-storage-configured.png)

### The parts

Under the switch, one row per part: its folder, what it holds, and an ⓘ with what it
is for, the space it needs and what switching off does to it. There is no switch per
part. A part may still sit **outside App storage**: a Photo Inbox or App files
library made before 4.6 keeps its folder, and renders or map data the 4.6 upgrade
found elsewhere stay there. Such a row says so and offers **Move in**, which moves it
as a task after a box naming the folder.

App files made under its former name, *Made in the app*, offers **Rename folder**:
the same task, the library following its folder, so nothing is rescanned.

### Moving it

**Change**, while App storage is on, moves it to another folder: in system data, or
a custom one. Everything inside moves along, each part as a task; a part outside it
stays where it is. Every check happens first: if the new folder already holds one
of the parts' folders, a library is being scanned, or a move is still running,
nothing changes and the box says why.

### Switching it off

Switching off removes the parts, so it is refused while any of them still holds
something the family would lose:

- photos are still waiting in the Photo Inbox;
- App files holds files (the Contents tab shows what owns each one);
- the Recycle Bin holds items from either library;
- a slideshow movie is rendering, or the place-name database is being built.

The switch says why before you confirm. Otherwise kept maps and place names are
deleted (both download again), the empty libraries and folders go, and the sign-in
location databases move back beside the database.

### What it holds: the Contents page

**Library → Storage contents**, the tab beside Storage, answers the other question
about App storage: what is in it, and why. The top table gives every part a count
and a size, counted from the app's own records where it keeps them (the two
libraries) and from the disk where it does not (renders, map data), plus the hidden
`.staging` folder where uploads wait between arriving and landing. Under it, the
**App files** library is listed folder by folder and file by file, each with the
thing it belongs to: the story a recording narrates, the photo a voice note sits on,
the track a music file plays as, the slideshow a movie was rendered from, the person
a family-tree photo is of, each a link where there is a page to go to.

![The Contents page: every part with its size, and the App files library folder by folder with what owns each file](images/107-storage-contents.png)

A file nothing owns any more, because the story, photo or slideshow it served has
since gone, is marked an **orphan**, and that is the one thing the page deletes: it
goes to the Recycle Bin like any deleted file. Files the app's folders do not account
for, such as photos uploaded into the library by hand, are listed as **Other files**,
with the way out: open their folder in the gallery and move it to another library.

### How a move runs

Every move is a **task**: it appears on the Tasks page as a *Storage move* with its
progress and an estimate, it can be stopped there or from the row, it is timed, and
a server restart picks it up again where it was. The row on this page shows
"Moving… 14 of 230" while it runs, and afterwards anything it could not carry with a
**Try again**. The activity log records when a move starts and how it ended.

What keeps it safe:

- On the same disk a move is a rename: instant whatever the size, and either it
  happens or it does not.
- Across disks nothing is copied while you wait. The task copies one file at a time
  and checks each one arrived whole, by size, before the original is removed. A file
  that does not check out stays where it was and is listed.
- A library keeps its old folder until the last file is across and verified, then
  switches to the new one in one step and the old folder goes. Stopping the move, or
  a failure, leaves the library exactly where it was.
- One move runs at a time, and never while a library is being scanned; a scan waits
  for a move the same way.

Once system data is chosen and a container is listed, you're ready for
**[Setting up libraries](libraries.md)**.

### An install that already had these set

Nothing moves when you update to 4.6. The first start writes system data from what
was already in use: the folder that holds your `thumbnails` folder when it has that
name and holds no library (in Docker, `/config`), otherwise the folder next to the
database. Thumbnails, backups and a Recycle Bin that lived somewhere else keep that
folder as a place of their own.

App storage becomes its one switch the same way. An install with an App storage
folder has it on, at that folder. An install that used a Photo Inbox, App files,
uploaded music or kept maps without one has it on, in system data, with each of
those left where it was and offering **Move in**. An install that used none of
them has it off.

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
to the Recycle Bin, and moving a folder on this page moves what it holds, after
telling you so.

Uploads wait in a hidden `.staging\` folder inside App storage while they
arrive, rather than in the system's temp folder, so a long recording cannot
fill a small root partition.
