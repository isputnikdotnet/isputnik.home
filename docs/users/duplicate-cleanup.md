# Duplicate cleanup

**Control panel → Utilities → Duplicate cleanup**

Photo libraries collect copies. A phone backup runs twice, a card gets imported into a
new folder as well as the old one, a sync client copies a folder into itself. Duplicate
cleanup finds all of that and helps you clear it out — a job at a time, at your own pace.

It is different from the **Duplicate photos** and **Duplicate folders** pages next to it,
which are still there. Those show you the last scan as it stands right now. This one
remembers: you can close the browser, come back next week, and pick up where you left off
with the same list and the same decisions already made.

> **This is still being proven.** It proposes deleting photographs. Look at what a card
> actually contains before removing anything, and start with a few rather than working
> through the whole list at once. Everything removed goes to the Recycle Bin and can be
> restored until you empty it.

## One cleanup at a time

Only one cleanup can be in progress. It belongs to whoever started it: they choose what to
compare, work through the results, and delete. Another administrator opening the page sees
the cleanup and how far it has got, but cannot change it — and can step in to finish,
cancel, or take it over if the person who started it isn't coming back.

Finishing or cancelling a cleanup frees the slot for the next one.

## Starting one

**Start a cleanup** opens a three-step wizard.

**1 — Which libraries.** Copies are only ever found *inside* what you tick, and only ever
removed from there. Ticking one library compares its photos with each other; ticking
several also finds the same photo sitting in two of them.

Libraries the app may only read — external ones, and any with deleting turned off — show a
padlock. They are still worth including: a copy kept in one counts as somewhere the photo
survives, so the copies elsewhere can go. Nothing in them is ever offered for deletion, and
no folder rule can change that.

**2 — What to look for.** Whole folders **or** single files — one or the other, not both.
They are different jobs of work: clearing folders is a few decisions about a great many
photos, and going through single copies is a great many decisions about a few. Mixed into
one list, neither gets done, and every folder you clear reshuffles the single-file half
underneath it. Run a folder cleanup first; what it leaves behind is what a file cleanup is
for.

Then photos, videos, or both — a handful of videos can be worth more space than a thousand
photos.

**3 — Review and run.** Once the scan runs, these answers are locked: everything it found
was worked out under them. To compare something else, finish this cleanup and start
another.

**Run scan** reads no files. It works from fingerprints the library already stores, so it
takes seconds rather than a pass over your photos.

## What it finds

A **folder** cleanup finds the first two kinds below; a **file** cleanup finds the third.
Strongest statement first.

**Identical folders** — two or more folders holding exactly the same pictures, file for
file, whatever they are called. One is kept and the others can go whole.

**Folders already stored elsewhere** — photos that also sit somewhere else, so these copies
can go and nothing is lost. The commonest case by far is a folder copied into itself.

Each card compares **one folder with one other folder**:

> These 2 photos also sit in "Holiday 2019".

Copies are often scattered — one photo survives in one folder, the next in another — so a
single folder can produce several cards, one per destination:

> These 2 photos in "test" also sit in "Holiday 2019".
> This photo in "test" also sits in "Card import".

Each card stands on its own. Every photo it offers has its counterpart in the folder named,
so you can act on one card and leave the others, and the folder empties as you work through
them. Clearing all of a folder's cards is what empties it completely.

**Duplicate photos** — byte-identical copies of a single picture. One is kept and the rest
can go.

## Which copy is kept

Decided in this order, and the card tells you which rule won:

1. A copy in a library nothing can be deleted from. Not a preference — the only outcome
   available.
2. A folder you marked **Keep**.
3. Not a folder you marked **Clean out**.
4. The copy carrying tags, albums, collections or tagged people.
5. Then the usual guesses: not named like a copy, not in a Downloads or app folder, has
   date and camera information, highest resolution, largest file, added first.

Nothing is lost by a copy losing: before a photo is removed, its tags, albums, collections
and tagged people are handed to the copy that survives it. The files are identical, so
tagged faces still line up.

## Working through the list

**Search** and **Filters** narrow what is on screen — by kind of result, by how far you have
got, or by any word in a folder, file or library name.

Each card offers three things, and they mean different things:

| Button | What it means |
|---|---|
| **Skip** | Not in this cleanup. The next one will offer it again. |
| **Not the same** | These are not duplicates. No future scan pairs them again, here or on the older pages. |
| **Delete copies** | Move the copies to the Recycle Bin, keeping the one the card names. |

Skip is a note on your afternoon's work. **Not the same** is a standing decision that
outlives the cleanup — so use Skip when you just want to deal with something later.

## Coming back later

A cleanup keeps everything: the libraries, the scan, your folder rules, which cards you
have looked at, what has already been deleted.

Because time passes, nothing is taken on trust. The moment you confirm a deletion, every
photo involved is checked against the library as it stands: still there, same size, same
content, same modification date — and so is the copy it was promised to survive in. If
anything has changed, **nothing at all is removed** and the card tells you what moved.

That covers the cases that matter: a photo deleted somewhere else, a file re-saved by an
editor, a library turned read-only since the scan, or the Recycle Bin emptied underneath a
promise.

If a library has changed since the cleanup started, the job card says so.

## Finishing

**Finish** closes the cleanup and keeps it as a record of what was removed and how much
space came back. Anything you never acted on is simply found again by the next cleanup.

**Cancel** stops it and discards the list. Photos already moved to the Recycle Bin stay
there — cancelling does not put them back. Nothing on this page ever empties the bin.
