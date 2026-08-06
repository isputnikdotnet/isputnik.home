# The control panel

Everything an administrator runs the server with. It's the last item in the menu
with your name on it, and only administrators see it.

The left-hand nav has seven sections, each with a row of tabs across the top of the
page. This guide walks them in order; where a page already has a guide of its own,
it points there rather than repeating it.

| Section | Tabs |
|---|---|
| **Overview** | System, Statistics, Tasks, Logs |
| **Library** | Libraries, Storage, Categories, Tags |
| **Members** | Users, Groups, Invite links, Sessions |
| **Security** | Overview, Policies, Trusted networks, Blocked IPs |
| **Maintenance** | Backup, Scheduled jobs, Recycle Bin |
| **Utilities** | Gallery → Duplicate cleanup, Missing photos |
| **Settings** | Appearance, Email, Reader access, About |

Every tab has its own address, so any page here can be bookmarked or linked to.
**Utilities** expands in the left nav to a **Gallery** branch, since everything under
it so far works on photos.

## Finding things

**Search…** at the top of the nav — or **Ctrl+K** (**⌘K** on a Mac) from anywhere in
the control panel — searches every page *and* the settings on them. Typing `smtp`
goes to Settings → Email; `lockout` goes to Security → Policies; `duplicate` goes to
Utilities → Duplicate cleanup. Arrow keys move through the results, Enter opens one.

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

It is also where the **Recycle Bin location** is set: one folder for every library's
deleted files, instead of a hidden `.trash` inside each library — which other software
reading the same folders will index and go on showing as though nothing had been
deleted. Best set before you create libraries; afterwards it can only change while the
bin is empty, and it wants to be on the same disk as your libraries (deleting onto
another disk copies every byte instead of being an instant rename).

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

**Where they land.** The page shows the folder the server writes to. In Docker that's
a path *inside the container* — `/config/backups` — which on the host is the `backups`
folder inside whatever you mapped to `/config`. On Unraid with the stock template that
means `/mnt/user/appdata/isputnik/backups`.

> Before 2.15.1 the container wrote backups to `/app/data/backups` instead, which is
> inside the image rather than your mapped folder: invisible from the host, and thrown
> away whenever the container was recreated. Updating fixes it — but updating *is* a
> recreation, so backups still sitting there go with it. To keep them, copy them out
> **before** you update:
>
> ```
> docker cp isputnik:/app/data/backups/. /mnt/user/appdata/isputnik/backups/
> ```
>
> (Substitute your container name and mapped folder.) The server also moves any it
> finds on startup, which covers installs that aren't containers.

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
files for a while, then go for good — and you can restore or empty by hand before
then.

**How long** is set at the top of the page, and there are two answers. The first is
for anything you delete yourself: 30 days to start with, and `0` means nothing is
ever removed automatically. The second is for items a **duplicate cleanup** removed;
leave it blank and cleanups follow the first setting. It exists because the two are
not the same kind of delete — deleting a book by hand is a mistake you might only
notice weeks later, while a cleanup can put thousands of photos in here at once, and
holding all of them for a month is a lot of disk.

Each item is given its date **when it is deleted**, and keeps it. Shortening either
setting therefore applies to what you delete from then on — it never brings forward
the date on something already in the bin, which would delete files you were promised
a month to think about.

Above the tiles is what the bin holds: how many items, how much space they take, and
how many files that is. It follows the library picker, so it counts what you're
looking at — with a library chosen it also says what the whole bin holds, since
"what would emptying this free?" is usually the reason you came.

Under that is **where those files actually are** — a `.trash` folder inside each
library's own folder, so there is one per library rather than one for the install.
That's deliberate: deleting is then a rename within one filesystem, instant even for
a 4 GB video, instead of a copy across shares. It also means the space a deleted item
is still using is on that library's disk, which is the thing the path tells you.

Don't clear those folders by hand while the server is running: the bin's list would
still name files that are gone, and restoring one would fail rather than doing
anything graceful. Empty from this page instead.

Items show as tiles, each led by the cover it had when you deleted it, so you can
recognise a photo or a book without reading filenames. Underneath: the name, the
folder it came out of, its library, its size, when it was deleted and by whom, and
the date it disappears on — its own date, not the page's. A **cleanup** tag marks
anything a duplicate cleanup removed. Anything with no cover — audiobooks without
art, or anything binned before covers were kept — shows an icon for its media type
instead.

The bar above filters to one library and sorts the tiles (most recently deleted
first by default, or by size, name, or what's about to be removed), and sets how
many appear per page. Once the bin holds both kinds, it also filters by how the item
was removed — which is how you find the one book you deleted by hand under a
cleanup's thousands of photos. The two buttons on each tile restore that item or
delete it for good.

**Restore all**, beside Empty in the header, puts back everything the page is
showing — so with a library chosen it restores that library's items and leaves the
rest alone. Each item is put back on its own, so one that can't be doesn't stop the
others: an item whose library has since been removed, or whose old place on disk is
now occupied, stays in the bin and is named afterwards. Nothing is deleted either
way, which is why it asks in ordinary terms rather than the red warning Empty gets.

---

## Utilities

Tools that work *on* a library rather than configuring one. They live under a
**Gallery** branch in the left nav, since everything here so far works on photos.

### Duplicate cleanup

A folder imported twice, a phone backup copied in beside the originals, a whole
library copied into a subfolder of itself — all of it leaves the same pictures in the
library more than once. A cleanup finds them, holds what it found, and lets you work
through it whenever you like.

It has [its own guide](duplicate-cleanup.md), which is worth reading before the first
one: what it looks for, how sure it is of each answer, and what happens when you
confirm.

> **Experimental.** Duplicate detection is still being proven. Look at what a set
> contains before removing anything, and start with a few rather than the bulk action.
> Everything removed goes to the Recycle Bin, so it can be undone until you empty it —
> but check, test, and check again first.

Two earlier pages, **Duplicate photos** and **Duplicate folders**, did some of this
and are gone as of 3.0.0. They were two views of a single install-wide scan that was
rebuilt every time anyone opened either one, so the list renumbered itself underneath
you and nothing you decided survived the next rebuild. The cleanup answers everything
they answered, and remembers. Old links to them land here.

### Missing photos

Files the catalog knows about that are no longer on disk. Usually a drive that
didn't mount, which is why they aren't removed automatically.

Each row shows the photo's last known thumbnail, where it was, and when it went
missing. Restore the drive and the next library scan clears the row on its own.
Photos missing longer than the window at the top are purged automatically — catalog
entry, thumbnail and all — and **Purge eligible now** does it immediately.

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
