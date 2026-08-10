# Duplicate cleanup

**Control panel → Utilities → Duplicate cleanup**

Photo libraries collect copies. A phone backup runs twice, a card gets imported into a
new folder as well as the old one, a sync client copies a folder into itself. Duplicate
cleanup finds all of that and helps you clear it out — a job at a time, at your own pace.

It replaced two earlier pages, **Duplicate photos** and **Duplicate folders**, which showed
you one install-wide scan as it stood right now — and rebuilt it, renumbering everything,
whenever anyone opened either of them. This one remembers: close the browser, come back
next week, and pick up where you left off with the same list and the same decisions already
made.

> **This is still being proven.** It proposes deleting photographs. Look at what a card
> actually contains before removing anything, and start with a few rather than working
> through the whole list at once. Everything removed goes to the Recycle Bin and can be
> restored until you empty it.

## One cleanup at a time

Only one cleanup can be in progress. It belongs to whoever started it: they choose what to
compare, work through the results, and delete. Another administrator opening the page sees
the cleanup and how far it has got, but cannot act on it — the padlock says whose it is.

They are not stuck with it, though. Beside that note are **Take over** and **Cancel**.
Taking it over makes the cleanup yours, keeping everything it found and every decision
already made — for when the person who started it isn't coming back. Cancelling stops it
and frees the slot. Neither puts back anything already deleted; that is what the Recycle
Bin is for.

Finishing or cancelling a cleanup frees the slot for the next one.

## Starting one

**Start a cleanup** opens a four-step wizard.

**1 — Libraries.** What the scan looks at.

Copies are only ever found *inside* the libraries you tick, and only ever removed from
there. Ticking one library compares its photos with each other; ticking several also finds
the same photo sitting in two of them.

Every library shows a padlock at the end of its row. A closed one — external libraries, and
any with deleting turned off — means the app may only read it; an open one means files
there can be cleaned up. Read-only libraries are still worth including: a copy kept in one
counts as somewhere the photo survives, so the copies elsewhere can go. Nothing in them is
ever offered for deletion, and no folder instruction can change that.

**2 — Content type.** What counts as a duplicate.

Whole folders **or** single files — one or the other, not both. They are different jobs of
work: clearing folders is a few decisions about a great many photos, and going through
single copies is a great many decisions about a few. Mixed into one list, neither gets
done, and every folder you clear reshuffles the single-file half underneath it. Run a
folder cleanup first; what it leaves behind is what a file cleanup is for.

And photos, videos, or both — a handful of videos can be worth more space than a thousand
photos.

**3 — Folder instructions.** Optional, and the only place in the wizard that touches which
copy survives. Every folder in the libraries you picked is listed, and each can be set to:

- **Keep** — when copies of a photo are in several places, the one here is the one to keep.
- **—** — no instruction; the usual rules decide.
- **Clear** — keep the copies elsewhere and let this folder's go. How you retire a folder
  whose contents have already been filed properly somewhere else.

These outrank every rule the review would otherwise fall back on, because they are answers
rather than guesses. They are set here, before the scan, because the scan decides each set's
keeper as it goes.

**Clear** can never empty a folder. A photo with no copy anywhere else is nobody's
duplicate and never appears in a set at all; and if every copy in a set is in a cleared
folder, there is no preferred survivor, the ordinary rules take over, and one is still kept.
Clearing a folder means "these are safe elsewhere", not "delete these".

"Clear" isn't offered for a library the app may only read — its files are not the app's to
remove.

The instructions belong to this cleanup. They start from whatever is saved for the install
and are this job's from then on, so changing them here leaves other cleanups alone.

**4 — Summary.** Review and run. Once the scan runs, these answers are locked: everything it found
was worked out under them. To compare something else, finish this cleanup and start
another.

**Run scan** fingerprints anything that needs it, then compares. The summary tells you how
many photos that means before you commit: where they are already fingerprinted the scan
takes seconds, and the first scan of a library reads those photos from disk and can take a
good deal longer.

Either way you don't have to sit and watch. The wizard closes, the cleanup shows its
progress, and the scan carries on if you close the page — come back and it will be waiting
in whatever state it reached. Only photos sharing a file size with another photo are ever
read, so most of a library is skipped entirely.

## What it finds

A **folder** cleanup finds the first three kinds below; a **file** cleanup finds the last
two. Strongest statement first.

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

**Folders sharing some photos** — two folders holding some of the same pictures without
either being a copy of the other. Half a memory card re-imported into a new folder, a "best
of" pulled together from several trips.

This one acts more narrowly than the two above: **both folders stay.** Only the shared
copies leave one side, and anything either folder holds on its own is untouched. The card
says which side keeps its copies and how many pictures move.

**Identical files** — byte-identical copies of a single picture: the same file, twice. The
copies are interchangeable, so the only question is which one to keep. One is kept and the
rest can go.

**Near-identical** — pictures that *look* the same but are different files. Matched on
what the image looks like rather than on its bytes.

**This is the one kind that is a judgement, not a fact.** Two quite different things look
alike to the matcher:

- A real copy — the 640 KB version a messaging app made of your 6 MB original, or a JPEG
  exported from a HEIC. Deleting the small one is usually right.
- **Two shots taken moments apart.** Consecutive frames of the same scene are nearly
  identical, but they are two different photographs, and deleting one loses a picture you
  never had twice.

The obvious separate shots are left out for you. A pair is dropped when it looks like two
exposures rather than one picture stored twice: the same resolution and nearly the same
file size, *plus* either timestamps a moment apart or camera frame numbers that count on
(`IMG_1109` beside `IMG_1110`). On a real library that removes a large share of what the
fingerprint matches.

What survives is what cannot be told apart automatically, so open those and look. Each
copy's file size is shown, which is usually the giveaway: a wildly smaller file is a copy,
while two files within a few percent of each other may be two separate shots that happen
to share a timestamp.

Only photos are compared this way. A re-encoded video is found only if it is byte-identical
to another, because videos carry no visual fingerprint.

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
