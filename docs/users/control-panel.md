# The control panel

Everything an administrator runs the server with. It's the last item in the menu
with your name on it, and only administrators see it.

The left-hand nav has three groups. This guide walks them in order; where a
section already has a guide of its own, it points there rather than repeating it.

| Group | Sections |
|---|---|
| **Application** | Status, Config, Security, Labels, Logs |
| **Digital Library** | Storage, Libraries, Recycle Bin |
| **User administration** | Accounts |

---

## Application

### Status

What the server is doing right now: how many users, active sessions and invites
exist, how many log entries have piled up, the database size, and how long the
server has been running.

The **Database** panel breaks the size down — the file itself, the WAL (SQLite's
write-ahead log, which grows between checkpoints and is normal), and the total on
disk. Tabs beside it break down what's *in* your libraries: audiobooks, ebooks and
gallery counts.

Go here first when something feels wrong — it answers "is the server actually up,
and how big is this getting?" before you go looking anywhere else.

### Config

Three tabs plus a Backup page.

- **Appearance** — the default theme for new accounts. Everyone can override it in
  their own profile.
- **Email** — outgoing mail, needed for two-factor codes, security alerts and Send
  to e-reader. It has [its own guide](email.md).
- **Reader access (OPDS)** — tokens that let a reading app (KOReader, Moon+ Reader,
  Thorium) browse your ebooks. One token per device, read-only, removable at any
  time.

#### Backup

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

### Security

Four tabs. This is the section that matters if your library is reachable from the
internet — pair it with [Exposing your library to the
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

### Labels

**Categories** and **Tags** — the two ways things get grouped across every library
type. Categories are a fixed, shelf-like taxonomy the scanner assigns; tags are
free-form, and one tag can span audiobooks, photos and family-tree people at once.
Here you rename, merge and delete them across the whole install.

### Logs

The activity history: who signed in, what was scanned, what was deleted, what an
administrator changed. Searchable, and you can clear old records — the Status page
tells you when they've grown large enough to be worth it.

This is where you look after a security alert, to see what actually happened.

---

## Digital Library

### Storage

The two folders every install needs — somewhere for generated thumbnails, and the
approved folders your libraries may read. Has [its own guide](storage.md).

### Libraries

Adding libraries and pointing them at folders has [its own
guide](libraries.md). Three more pages live under this section:

- **Tasks** — every scan and conversion, split into Running, Queued and History,
  with live progress. When a scan seems stuck, this is the page that says
  otherwise.
- **Scheduled jobs** — the recurring work, each with its own on/off switch and
  frequency: scanning each library type for new files, scanning new photos for
  faces, purging missing photos, cleaning task history, emptying the recycle bin,
  and converting unplayable videos. Sensible defaults ship enabled; the face scan
  runs after the nightly library scans so the day's new photos are already
  cataloged.
- **Missing photos** — files the catalog knows about that are no longer on disk.
  Usually a drive that didn't mount, which is why they aren't removed
  automatically.

### Recycle Bin

Deleting from the app moves things here rather than erasing them. They keep their
files for the retention period (the page states it), then go for good — and you can
restore or empty by hand before then.

---

## User administration

### Accounts

Four tabs:

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
- **Invites** — sign-up links, so you don't have to hand out passwords. Create one,
  send it, retire it when it's been used or you've changed your mind.
- **Groups** — named sets of people you grant library access to as a unit. Worth it
  the moment you're granting the same three libraries to the same four people.
- **Sessions** — every signed-in device, with the ability to revoke any of them.
  Where you go when a laptop is lost, or when a sign-in alert names a device you
  don't recognise.

Library *access* is granted per library (in Libraries → a library → members), not
here — this page is about who exists, groups are about who they are as a set.

---

## A sensible first pass

On a new install, in this order:

1. **Storage**, then **Libraries** — nothing works before these
   ([storage](storage.md), [libraries](libraries.md)).
2. **Config → Backup** — schedule it now.
3. **Config → Email** ([guide](email.md)) — so alerts can reach you.
4. **Security → Trusted networks** — add your home network.
5. **Accounts → Invites** — bring in the household.
6. Your own [two-factor](two-factor-authentication.md), especially as an admin.
