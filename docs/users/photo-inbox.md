# The Photo Inbox

**Gallery → Photo Inbox** · switched on per library under **Control panel → Library**

Some photos are not part of the collection yet. A box of prints you are feeding
through a scanner, most of which you scanned once before at a worse resolution.
A phone full of pictures a cousin wants to hand over, who has no account here
and never will. Neither belongs on the Timeline until someone has looked at it,
and the second is the wrong thing to be on the Timeline at all until you say so.

A **Photo Inbox** is a gallery library set aside for exactly this: a holding
place that nothing resurfaces. Photos land in it by scan, by upload, or through
a link you hand to someone, and they stay out of the Timeline, Memories, the
Home page, People and the pickers until you decide, one delivery at a time,
what stays. An empty Inbox is a finished review.

![The Photo Inbox: three deliveries, seven photos flagged as copies of what the library already has, and the grid below](images/82-photo-inbox.png)

This guide walks the whole process from the scanner box to a tidy library.

## 1. Set up an Inbox

An Inbox is an ordinary gallery library with one switch on. The quick way is
**Control panel → Settings → Gallery → Photo Inbox**: give it a name, pick the
storage container it should live in, and the folder, the library and its first
scan are made in one step. The long way still works — create a gallery library
the usual way ([Libraries](libraries.md)), pointing it at an empty folder inside
a storage container, then open its settings and, on the **Access** tab, turn on
**This library is a Photo Inbox**. An existing library can become one the same
way, and go back to normal by turning it off.

![The library's Access tab, with the Photo Inbox switch as its last row](images/87-library-inbox-switch.png)

Give it a name you will read on a Home card: "Photo Inbox", "Scans to sort".
One Inbox is enough for most houses; a second is worth having only when you
want the scanner box and a relative's deliveries reviewed apart.

Two things change the moment the switch is on:

- **Nothing resurfaces it.** The Timeline, Memories, the Home page's photo cards,
  People, the map, and every picker for albums, slideshows and stories leave the
  Inbox out. Choosing the Inbox in the gallery's library filter is the one way
  to browse it there, and it is labelled as an Inbox when you do.
- **Faces wait.** Face recognition skips an Inbox, so a box of somebody else's
  prints cannot seed your People page with strangers. A kept photo is scanned
  for faces like any newly added one.

## 2. Fill it

Three ways in, all of which land as a **delivery** — a top-level folder in the
Inbox, so the review can tell Grandma's box from this morning's scanner run.
Every delivery also appears as a row on your **For you** page and at the top of
your Home page, naming who sent it when it came through a link, until the
Inbox is emptied ([Sharing with family](family-sharing.md#for-you)).

**From a folder.** Point your scanner software, or a copy from a card, at a
subfolder of the Inbox's folder — one per box, named for it — and re-scan the
library. Files dropped straight into the root show up as *Loose files*.

**Upload.** The **Upload** button on the Inbox page takes files the same way
any gallery upload does; they are filed by the day they arrived.

**A drop link**, for someone without an account. **Drop link** on the Inbox page
opens the dialog below. Give the link a label — it is shown on the sender's
page and becomes the folder their photos land in — choose how long it lasts,
and cap how many files and how much in total it may receive. **One delivery
only** closes the link after the first batch, for the "just send me those"
case; off, it stays open until it expires, for the relative who sends a few
every week.

![The Drop links dialog: a new link being set up, and one already out with what it has received](images/85-inbox-drop-links.png)

The address is shown once. Copy it then, because only its fingerprint is kept
and it cannot be shown again. The sender sees this:

![What the sender sees: your label, what they may still send, and the dropzone](images/86-drop-page.png)

They pick their photos and get "Received 37 photos. Thank you." back — a count,
and nothing else. No thumbnails, no gallery, no way to see what is in the
Inbox. Whatever the page said, the server counts every batch against the
link's caps itself. A delivery that came through a link wears a link icon on
its chip. Links you have handed out are listed in the same dialog and under
**Shared links** on your profile, and any of them can be taken back at once;
photos that already arrived stay.

Before you hand one out on a server reachable from the internet, read the
note in [Exposing your library to the internet](exposing-to-the-internet.md#drop-links-if-you-hand-them-out).

## 3. Let the check run

After a scan, an upload or a drop, the Inbox is checked against the rest of
the library on its own. You do not start it; the banner at the top of the
Inbox page tells you how it went.

The check is the same engine as [Duplicate cleanup](duplicate-cleanup.md),
pointed one way. Only the Inbox's photos are candidates, so the library is
never compared with itself — a delivery of two hundred scans does not turn
into a cleanup of the whole house — and the library's copy is always the one
kept. It finds byte-identical files, the copies that were re-scanned and are
now a different file of the same picture, and it hashes an incoming scan turned
on its side as well, so a print fed in sideways still finds its upright twin.

It also finds the same print scanned twice — laid on the glass a little
differently each time, and graded to each scanner's own taste, which is enough
to make the two files look unrelated to a fingerprint. Where the fingerprints
are close without being equal, the two pictures themselves are compared, and a
match is shown as **Looks the same** for you to confirm. What is still beyond
it is a photograph re-cropped hard — much past a tenth of the frame — or one
so changed by an edit that it is a different picture; those you will meet in
the grid.

The banner reads "N photos look like copies of ones the library already has",
"Checking for copies…" with a percentage while it runs, or "No copies found".
If a Duplicate cleanup is already in progress the check waits, since only one
runs at a time; **Check for copies** on the page starts it by hand once the
slot is free.

## 4. Settle the copies

**Review copies** on the banner opens the Duplicate cleanup page, where the
check is an ordinary cleanup job with its results below. Its cards read the
other way round from a normal cleanup: the copy marked **In the library** is
what you already have, the one marked **Incoming** is what just arrived, and
the card says so — *kept because: already in the library*.

![The cleanup page with an Inbox check: the job card, Replace larger and Discard in the toolbar, and the first identical set](images/84-inbox-check-results.png)

An **identical** set is the same file twice. There is nothing to choose between
them, so **Discard incoming** sends the new copy to the Recycle Bin — on the
cleanup's shorter clock, not the bin's usual one — and the library is as it
was. **Discard N identical copies** in the toolbar does every identical set on
screen at once.

A **near-identical** set is the interesting case: the same picture, a different
file. The card shows both with their pixel sizes and file sizes, and **Compare**
opens them side by side.

![A near-identical set: the library's two copies, the incoming scan at higher resolution, and Replace on offer](images/88-inbox-check-near.png)

- **Replace** puts the incoming file in the library item's place. The item keeps
  its identity, so every album, story, tag and person pointing at it still
  points at it; the library's old file is set aside beside the Recycle Bin, not
  deleted; and the Inbox copy leaves the Inbox. This is the verb for "the new
  scan is better".
- **Discard incoming** is the verb for "the old one was fine".
- **Not the same** says these are two photographs, not two copies — two shots a
  moment apart, say. It is remembered, so no later check pairs them again, and
  the photo stays in the Inbox to be kept like any other.
- **Replace larger** in the toolbar does every set on screen whose incoming
  copy has more pixels in both directions, and leaves the rest for you.

Every action re-checks the photos against the library as it stands, and refuses
rather than acting on something that has moved since the scan.

## 5. Keep or discard the rest

Back on the Inbox page, what the check did not claim is yours to sort. Pick a
delivery chip to work through one box at a time, or **All**. **Select**, tick
the photos — **All** ticks everything loaded — and choose:

- **Keep** moves them into a real library. The dialog asks which library, and
  then offers two ways to say where in it. **Create new folder** takes a folder
  name you type — or the dated `YYYY/YYYY-MM-DD` layout uploads use. **Use
  existing folder** lists the folders that library already has, with a search box
  and a photo count each, so a box of prints can join the ones scanned last
  month without anybody having to remember what the folder was called. The dated
  layout is right for phone photos and usually wrong for scans, whose date is the
  day they were scanned; that is why Keep asks rather than guesses. Set the dates
  first (select, then **Date** in the gallery) if you want them right. Tags,
  likes and edits travel with a kept photo, and it is scanned for faces on
  arrival. Your last choice is remembered for the session.
- **Discard** sends them to the Recycle Bin on the cleanup's clock.

![Keeping two photos: choose the library, then name a folder or take the dated layout](images/83-photo-inbox-keep.png)

![The other tab: the folders that library already has, searchable, with the library root at the top](images/89-inbox-keep-existing.png)

A delivery whose every photo has been kept or discarded disappears from the
chips; an Inbox with nothing left shows "All reviewed". Keeping or discarding
takes the delete right on the Inbox, and Keep the upload right on the
destination — anyone else can look but not review.

## 6. Ask someone what they know

A box of childhood prints has a date of the day it was scanned and no place at
all, and the person who knows when and where they were taken is not the one at
the scanner. The Inbox has a second screen for exactly that person: **Review
mode**, one photo at a time, four questions, and nothing else to learn.

**Setting it up** is one grant. Give her an account as an ordinary member
([Your account](your-account.md)), open the Inbox library's members dialog
under **Control panel → Libraries**, and add her as **Contributor**. A
contributor can write on the photos but cannot Keep or Discard, so she can
answer without being able to move anything, and she sees nothing outside the
Inbox unless you have shared other libraries with her. If she reads Russian,
set her language on her profile; the screen is in both.

**What she sees.** Her Home page shows one card — "Photo Inbox · Scans · 38
photos want your notes" — with **Add what you know** on it. That opens the
photo large, with the questions beside it (below it on a tablet held upright):

- **When was this taken?** A year from a list, then a month if she knows it,
  then a day once a month is chosen, and **Exactly** or **About**. Nothing is
  typed. The scan date is never offered as an answer; the list starts empty.
- **Where?** One line, in her own words — "the dacha", "Komarovka". Places she
  has already written in this box appear above it as buttons, so the second
  photo from the same place is one tap.
- **Who is in it?** The people the library already knows, as buttons; **Add a
  name** for someone new, who then joins the People page like any hand-tag.
- **Anything you remember?** A box for a line or a page.

**Same as the last one** under When and under Where copies the previous
photo's answer. On a box from one summer it is the button she presses most.
**Next** saves everything and moves on; **Previous** goes back; **I don't know**
marks the photo as looked at and moves on without changing it. There is no Save
button, and leaving the page saves the photo she was on. At the end she gets
"You went through all of them", and the card leaves her Home page.

**What you see afterwards.** Each delivery chip on the Inbox page reads
"12/38", the photo's Info panel says *Noted by Mama, Tuesday* under the
description, and the date reads "around 1962" rather than a day, because a
year is what she knew. Keep files a year-only photo under `1962/` in the dated
layout and a month-only one under `1962/1962-07`, never under a day nobody
named. You can open the same screen yourself with **One at a time** on the
Inbox page, which is a faster way to date a box than the grid when the answers
are mostly "same as the last one".

**Photos already in the house** can be asked about too. Open an album, press
**Send to**, pick her, and tick **Ask what they remember** before sending. She
gets the same card on her Home page — "Sergey asks what you remember about
these photos" — and **Add what you know** opens the same screen over the
album's photos. Sending with the question also gives her the right to write on
those photos, and only those; the rest of the library is untouched, and
whoever made the album (or an administrator) is the only one who can ask.
When she reaches the end, the card leaves her Home page by itself.

**Dates that are only roughly known** are not an Inbox-only idea. The **Date**
dialog on any selection, and the pencil on a photo's date in the Info panel,
now ask *how exact* — exact time, day, month, year or decade — and whether it
is *about*. A photo dated to the year heads its own group on the Timeline
rather than pretending to be from New Year's Day.

## What to expect, and what not to

- **Nothing is lost by an Inbox.** Discard is the Recycle Bin. Replace sets the
  old file aside. Keep moves rather than copies, and the file keeps its name.
- **A scan's date is the scan date.** Old prints arrive dated today. Fix the
  dates before keeping into the dated layout, or keep into a named folder.
- **Only the Inbox is a candidate.** If your library already holds the same photo
  twice, the check pairs the incoming copy with one of them and leaves the other
  alone; a normal Duplicate cleanup is the tool for that.
- **A hard crop is still not matched.** The check allows for a print laid on the
  glass a little differently each time, but a deliberately tighter crop of the
  same photograph reads as a different picture and lands in the grid as new.
  Look before keeping.
- **A drop link writes to your server.** Cap it at what the person needs, label
  it with their name, and take it back when it has done its job.
