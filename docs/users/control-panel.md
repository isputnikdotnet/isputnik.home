# The control panel

Everything an administrator runs the server with. It's the last item in the menu
with your name on it, and only administrators see it.

The left-hand nav has six sections, each with a row of tabs across the top of the
page. This guide walks them in order; where a page already has a guide of its own,
it points there rather than repeating it.

| Section | Tabs |
|---|---|
| **Overview** | System, Statistics, Tasks, Logs |
| **Library** | Libraries, Storage, Categories, Tags |
| **Members** | Users, Groups, Invite links, Sessions |
| **Security** | Overview, Policies, Trusted networks, Blocked IPs |
| **Maintenance** | Backup, Scheduled jobs, Recycle Bin, Missing photos, Duplicate photos, Duplicate folders |
| **Settings** | Appearance, Email, Reader access, About |

Every tab has its own address, so any page here can be bookmarked or linked to.

## Finding things

**Search…** at the top of the nav — or **Ctrl+K** (**⌘K** on a Mac) from anywhere in
the control panel — searches every page *and* the settings on them. Typing `smtp`
goes to Settings → Email; `lockout` goes to Security → Policies; `duplicate` goes to
Maintenance → Duplicate photos. Arrow keys move through the results, Enter opens one.

Use it rather than hunting through tabs. It's usually faster even when you know
where a setting lives.

---

## Overview

### System

What the server is doing right now: how many users, active sessions and invites
exist, how many log entries have piled up, the database size, and how long the
server has been running.

The **Database** panel breaks the size down — the file itself, the WAL (SQLite's
write-ahead log, which grows between checkpoints and is normal), and the total on
disk.

Go here first when something feels wrong — it answers "is the server actually up,
and how big is this getting?" before you go looking anywhere else.

### Statistics

What's *in* the catalogue. Pick a media type from the control beside the heading:
audiobooks (libraries, hours, top authors and narrators), ebooks (formats, authors,
largest files) or gallery (photos, videos, largest items).

### Tasks

Every scan and conversion, split into Running, Queued and History, with live
progress. When a scan seems stuck, this is the page that says otherwise.

### Logs

The activity history: who signed in, what was scanned, what was deleted, what an
administrator changed. Searchable, and you can clear old records — the System page
tells you when they've grown large enough to be worth it.

This is where you look after a security alert, to see what actually happened.

---

## Library

### Libraries

Adding libraries and pointing them at folders has [its own guide](libraries.md).

### Storage

The two folders every install needs — somewhere for generated thumbnails, and the
approved folders your libraries may read. Has [its own guide](storage.md).

### Categories and Tags

The two ways things get grouped across every library type. Categories are a fixed,
shelf-like taxonomy the scanner assigns; tags are free-form, and one tag can span
audiobooks, photos and family-tree people at once. Here you rename, merge and delete
them across the whole install.

---

## Members

- **Users** — create accounts, set roles (**Member** or **Admin**), change
  passwords, and reset someone's two-factor when they've lost both their phone and
  their backup codes.

  **"Delete user" doesn't delete anything but the sign-in.** It deactivates the
  account and signs that person out everywhere; their libraries, groups, activity
  history and files all stay.

  The **first administrator** — the account created at first run — carries a
  **Protected** badge: its role can't be changed and it can't be removed here, so
  an install can never be left with no way in. You also can't change your own role
  or remove your own account, for the same reason.
- **Groups** — named sets of people you grant library access to as a unit. Worth it
  the moment you're granting the same three libraries to the same four people.
- **Invite links** — sign-up links, so you don't have to hand out passwords. Create
  one, send it, retire it when it's been used or you've changed your mind.
- **Sessions** — every signed-in device, with the ability to revoke any of them.
  Where you go when a laptop is lost, or when a sign-in alert names a device you
  don't recognise.

Library *access* is granted per library (in Library → Libraries → a library →
members), not here — this section is about who exists, groups are about who they are
as a set.

---

## Security

This is the section that matters if your library is reachable from the internet —
pair it with [Exposing your library to the
internet](exposing-to-the-internet.md).

- **Overview** — whether automatic protection is on, and whether the server is
  reading visitor addresses correctly through your reverse proxy. If that proxy
  reading is wrong, every address looks the same and lockouts hit the wrong people
  — fix it before tuning anything else.
- **Policies** — the thresholds: how many failed sign-ins lock an account and for
  how long, when an address is auto-blocked, sign-in alerts, and the password
  policy. Changes apply immediately.
- **Trusted networks** — address ranges (your home LAN, typically) that are exempt
  from rate limits, lockout and the new-network alerts. Add your own network so
  household devices don't trip the protection meant for strangers.
- **Blocked IPs** — what's been auto-blocked, and where you unblock it or add a
  block by hand.

The alerts these produce only reach you if email is set up.

---

## Maintenance

### Backup

Worth setting up on the day you install, not the day you need it.

- **Create backup now** makes one immediately.
- **Scheduled backups** run daily at a time you pick, keeping the last N (default
  10) and deleting older ones.
- **Include covers** decides between a full `.zip` (database *and* the generated
  thumbnails) and database-only. Covers regenerate from your originals, so
  database-only is much smaller — but see the warning below.
- You can **upload** a backup from your computer; it joins the list ready to
  restore.

**Restoring is a two-step operation.** Choosing Restore *stages* the backup; it
takes effect when you **restart the server**. That's deliberate — swapping the
database out from under a running server is how databases get corrupted.

> **The one thing covers aren't.** The thumbnail folder is mostly a cache and
> regenerates. The exception is family-tree portraits uploaded before 2.3.0, which
> exist nowhere else. If you have any, take full backups.

### Scheduled jobs

The recurring work, one row each: scanning each library type for new files, scanning
new photos for faces, looking for duplicate photos, purging missing photos, cleaning
task history, emptying the recycle bin, and converting unplayable videos. Sensible
defaults ship enabled; the face scan runs after the nightly library scans so the
day's new photos are already cataloged.

Rows are grouped by what the job is about — audiobooks, ebooks, gallery, then the
system chores — and each carries a matching tag, so the library scans sit together
instead of being scattered through the list. Hover a job's **i** for the full
description of what it does.

Each row carries how often it runs and at what time, when it last ran and when it
runs next, an on/off switch, and **Run now**. There's no Save button: a change to
the cadence, the day, the time or the switch is saved as you make it, and the "next
run" beside it updates to match.

**Run now** starts a job immediately, whatever its schedule says — and keeps
reporting until the work is genuinely finished. That matters because most of these
jobs don't do the work themselves; they queue it. A photo library scan hands off to
the scanner and returns in milliseconds, while the scan itself may run for an hour.
So the button stays spinning, and the message above the table says what was queued
with a link straight to **Overview → Tasks**, where you can watch the progress bars.
When the last queued task finishes, the message says so. Jobs that do their work on
the spot — emptying the recycle bin, purging missing photos — simply report their
result and are done. Only one job can be started by hand at a time; several of them
skip themselves anyway when another heavy task is already running.

### Recycle Bin

Deleting from the app moves things here rather than erasing them. They keep their
files for the retention period (the page states it), then go for good — and you can
restore or empty by hand before then.

Items show as tiles, each led by the cover it had when you deleted it, so you can
recognise a photo or a book without reading filenames. Underneath: the name, the
folder it came out of, its library, its size, when it was deleted and by whom, and
the date it disappears on. Anything with no cover — audiobooks without art, or
anything binned before covers were kept — shows an icon for its media type instead.

The bar above filters to one library and sorts the tiles (most recently deleted
first by default, or by size, name, or what's about to be removed), and sets how
many appear per page. The two buttons on each tile restore that item or delete it
for good.

### Missing photos

Files the catalog knows about that are no longer on disk. Usually a drive that
didn't mount, which is why they aren't removed automatically.

### Duplicate photos

A folder imported twice, or a phone backup copied in beside the originals, leaves
the same picture in the library several times. This page finds those and lets you
decide, copy by copy, which ones stay.

> **Experimental.** Duplicate detection is new and still being proven. Look at what a
> set contains before removing anything, and start with a few sets rather than the bulk
> actions. Everything removed goes to the Recycle Bin, so it can be undone until you
> empty it — but check, test, and check again first.

Results come in two groups here, and they deserve different amounts of trust. Whole
folders live on their own tab — see **Duplicate folders** below — and are worth
working through first: one decision there settles hundreds of the sets on this page.

**Identical files** are byte-for-byte the same, so a set is never a guess. Finding
them is cheap because identical files must be the same size: photos whose size
matches nothing else are skipped without ever being opened.

**Near-identical** means the same picture in a different file — a resized copy, one
re-saved by a messaging app, an export at another quality. These are matched on
what the picture *looks* like, deliberately narrowly, so two similar shots of the
same moment are left alone. Read them before removing anything; only the identical
sets can be cleared in bulk.

Pick a library from the first control in the bar and choose **Scan now**. A library
with files still to read says how many; one with nothing new says nothing at all.

That picker decides who is compared with whom. Choose a library and the page
compares *its* photos with each other: only sets with two or more copies inside it
are listed, and each set shows only the copies living there. Copies of the same
photo in other libraries drop out of the comparison and are never deleted from
here — the set says how many there are, so you know they exist. It also limits
what the next scan reads.

**All libraries** is the wider question: sets are assembled across every library,
so the same album imported into two places shows up as one set with its copies
side by side, each saying which library it's in. Two libraries holding one copy
each only appear there.

#### Working through the list

Search matches a filename, folder or library name, and keeps a whole set if any
copy in it matches. Sort by size to reclaim, number of copies, identical-first,
filename or newest, and choose how many sets to show per page.

Sets whose copies share *both* a filename and a byte size collapse to the copy
being kept, behind a chevron — three thumbnails of the same picture with the same
name tell you nothing. Open one to see the rest. Sets whose copies differ in either
respect stay open, because there the pictures are exactly what you need to compare.

#### Choosing what goes

Every copy is marked either **Keep** or **Delete**, and clicking a copy switches it
between the two. The scan's own suggestion is the starting point: it favours
whichever copy carries work you can't get back — tags, albums, tagged people — then
hand-edited details, then originals over things that look like copies
(`IMG_1234 (1).jpg`, files under *Downloads* or *WhatsApp*).

Each copy shows the folder it lives in and its file size — with every library in
view, the library it belongs to as well — so two copies sharing a filename can still
be told apart. Size is on the tile because in a near-identical set it's the quickest
read on which copy is the original. The **i** button opens the rest — full path,
dimensions, date taken, camera, and how many tags and links it carries — with a link
that opens its folder in the gallery in a new tab.

Marks last for as long as you're on the page. They aren't saved: reload, or run
another scan, and every set goes back to the scan's suggestion. Nothing is acted on
until you press Delete.

#### Looking at them properly

The expand button on a set opens the copies full size — one at a time, with the
arrow keys to step through, or two side by side. Comparing two is the point for
near-identical sets, where the difference is in the picture itself and a thumbnail
won't show it. A set of two opens straight into the comparison. Clicking a picture
there marks it, exactly as clicking a tile does, and each one links to the original
file if you want to see it at full resolution.

#### Deleting

- **Delete N copies** — every copy you've marked Delete goes to the Recycle Bin.
  Before it does, its tags, albums and collections are merged onto a copy you're
  keeping, so nothing you filed by hand is lost. Tagged people move too for
  identical files, where the faces line up exactly; for near-identical ones they
  don't, because a face marked on a resized copy sits in the wrong place on the
  original.
- **Not duplicates** — the set disappears and those photos are never grouped again.
  Nothing is deleted.

You can keep more than one. Marking two of three to keep deletes only the third,
and the set stays on the page while two copies of the picture remain.

You can also mark *every* copy, which is not de-duplicating any more — it removes
the picture from the library altogether. That asks in its own words rather than the
usual reassurance, because there is no kept copy: the tags, albums and tagged people
have nowhere to move to and go with it, unless the photo also exists in a library
you aren't looking at, in which case they move onto one of those copies and the
dialog says so. The files still land in the Recycle Bin, so it's undoable until you
empty it.

**Delete all extras** works on every **identical** set at once, keeping one copy in
each. It follows the library picker exactly as the list does: pick a library and it
thins that library down to one copy per set, leaving copies in other libraries
untouched — so a photo can still be duplicated *across* libraries afterwards, and
the confirmation says how many sets that applies to. It ignores your marks and your
search, and says how many sets it covers. Near-identical sets are never swept in
bulk; they're a judgement call, one at a time.

Two things worth knowing. Nothing is deleted without you asking — a scan only ever
reports. And if a photo has been edited on disk since the last library scan, it's
left out of the comparison and the page says so; re-scan that library from
**Library → Libraries**, then scan for duplicates again.


### Duplicate folders

Whole folders that duplicate another folder, on their own tab because they are a
different unit of work: clearing one settles hundreds of the photo sets next door.
Both lists below come from the scan you start on **Duplicate photos** — this tab
reports, it never scans.

A folder is matched on what it holds, not what it's called: every file below it,
by content and by the path it sits at. *Italy 2019* and *Backup/holiday-2019* pair
up; two folders holding the same pictures arranged differently do not, and neither
do two that agree on all but one photo. Nothing has to be read from disk for this —
it reuses the fingerprints the identical-file scan already took.

Only the topmost pairing is shown. If two whole libraries match, you get one set for
the libraries, not one for every folder inside them.

Each folder is a tile showing a few of its own pictures, where it lives, how many
photos it holds and how much space they take. Exactly one folder in a set is kept —
click a tile to make it that one. The suggestion favours the folder whose photos
carry tags, albums or tagged people, then passes over anything named or filed like
a copy (*Backup*, *Downloads*, *WhatsApp*, *… copy*), then prefers the folder nearer
the top of the library, then the one added first.

**Delete** moves every photo in the other folders to the Recycle Bin. Each one hands
its tags, albums, collections and tagged people to the photo at the same place inside
the kept folder first — an exact match, since the two files are identical. The
folders are checked again the moment you confirm: if anything in them has changed
since the scan, nothing is deleted and you're asked to scan again. The empty folders
themselves are left on disk for you to remove.

**Not the same** drops the set and stops future scans pairing those folders. The
photos inside them are still compared with each other individually.

#### Folders already stored elsewhere

Each row names one folder that can go and one that keeps its photos: *all 6 photos in
X are also in Y*. It also says how many photos Y holds beyond them — 0 means the two
hold the same pictures arranged differently.

The commonest source is a folder copied inside itself, which sync clients and photo
managers produce all the time. Only the topmost such folder is listed: removing it
takes anything below it too. And when two folders cover *each other* — the same photos
in a different layout — only one is offered, because acting on both would delete every
copy between them.

**Delete** moves that folder's photos to the Recycle Bin, handing each one's tags,
albums and tagged people to its copy in the folder being kept first. Coverage is
re-checked the moment you confirm: if even one photo no longer has a copy over there,
nothing is deleted. **Leave it** drops the row for good — the folder stops being
suggested however its photos are covered later.

#### Choosing what to work on, and where to keep it

Two controls in the bar work in folders rather than in sets, and both list only folders
something duplicated was actually found in.

- **Choose folders to work on** narrows the page to sets with a copy in the folders you
  pick, exactly as the search box narrows it. It changes nothing and is forgotten when
  you leave.
- **Where to keep photos** is a decision, and it is saved. When copies of a photo sit in
  more than one place, the one in a chosen folder is the copy kept — for photo sets and
  folder sets alike, outranking every automatic guess, since nothing is lost either way
  (the other copies' tags and people are merged onto it). A folder you've chosen is also
  never offered for removal. Saving re-picks every automatic keeper immediately; copies
  you picked by hand stay as they are.

Both treat a folder as covering everything below it.

---

## Settings

- **Appearance** — the default theme for new accounts. Everyone can override it in
  their own profile.
- **Email** — outgoing mail, needed for two-factor codes, security alerts and Send
  to e-reader. It has [its own guide](email.md).
- **Reader access** — OPDS tokens that let a reading app (KOReader, Moon+ Reader,
  Thorium) browse your ebooks. One token per device, read-only, removable at any
  time.
- **About** — version, credits, and what changed in each release.

---

## A sensible first pass

On a new install, in this order:

1. **Library → Storage**, then **Library → Libraries** — nothing works before these
   ([storage](storage.md), [libraries](libraries.md)).
2. **Maintenance → Backup** — schedule it now.
3. **Settings → Email** ([guide](email.md)) — so alerts can reach you.
4. **Security → Trusted networks** — add your home network.
5. **Members → Invite links** — bring in the household.
6. Your own [two-factor](two-factor-authentication.md), especially as an admin.
