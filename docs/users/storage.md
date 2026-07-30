# Storage

Before you can add a library, the server needs to know two things. Both live in
**Control panel → Storage**.

![Storage before anything is configured](images/10-storage-empty.png)

| | What it is | Why it's needed |
|---|---|---|
| **Thumbnail storage** | One writable folder where the app keeps the covers and previews it generates | These are *generated* files. They're kept away from your originals so your media folders stay exactly as you arranged them. |
| **Digital Library containers** | The folders your libraries are allowed to read | A safety boundary: a library can only ever point somewhere inside an approved container, so a mistyped path can't wander off into the rest of the disk. |

Until both are set, **Add library** stays disabled and the Libraries page tells
you so — with a button straight back here.

## Thumbnail storage

Choose **Edit path** and give it a writable folder. Anything works as long as
the server user can write to it and it isn't inside a library you'd rather keep
pristine. A hidden folder alongside your media is a tidy choice:

```
D:\ProjectTesting\AppDocTest\.thumbnails
```

It flips from **Not configured** to **Ready** once saved.

> **Running in Docker?** Use the path *inside the container* — the one you mapped
> your volume to — not the path on the host.

## Digital Library containers

A container is a root folder you're approving. Libraries can then use the whole
container or any folder inside it.

Choose **Add container** and give it a name and a path:

![Adding a storage container](images/12-storage-add-container.png)

| Field | Example |
|---|---|
| **Container name** | `Family media` — a label for you, shown when picking folders |
| **Container path** | `D:\ProjectTesting\AppDocTest` — must already exist on the server |

The folder has to exist already; the app won't create it. If the path is wrong
or unreadable, you're told immediately rather than at scan time.

![Storage once both are set](images/11-storage-configured.png)

Both green? You're ready for **[Setting up libraries](libraries.md)**.

## How to organise the folder underneath

One container with a folder per library is the arrangement most people end up
with, and it's what the rest of these guides assume:

```
D:\ProjectTesting\AppDocTest\      ← the container
├── Audio\                         ← an audiobook library
├── Ebooks\                        ← an ebook library
├── Gallery\                       ← a gallery library
├── FamilyTree\
└── .thumbnails\                   ← generated covers and previews
```

You can add several containers if your media lives on different drives. The
**Libraries** column on this page shows how many libraries are using each one,
and a container can't be deleted while a library still depends on it.

## Your original files are never modified

Worth stating plainly, because it governs the whole design: **scanning reads,
it never writes.** The app catalogues what it finds, and everything it derives —
covers, previews, metadata, your reading position — is kept in its own database
and thumbnail folder. Renaming a library, editing a book's title, or deleting a
library never touches the files on disk.

The exceptions are the things you'd expect to touch files, and only those:
uploading adds a file, and deleting an *item* (when the library allows it) moves
it to the Recycle Bin.
