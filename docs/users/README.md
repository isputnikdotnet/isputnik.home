# User guides

Friendly, task-focused guides for people using and running isputnik.home.

![The Home page of a library in use, with recent photos and newly added books](images/02-home.png)

> These files are **shipped inside the app**. The web build copies this folder to
> `apps/web/public/guides/` and renders it at `/help/<name>`, so a server with no
> internet still has its documentation and always shows the version it's running.
> Editing a guide here changes what the app shows on the next build — and
> `npm run check:ui` fails if a guide isn't listed on the in-app Help page.
>
> Two things follow from that: link between guides with a plain relative name
> (`[Storage](storage.md)`), which is rewritten to an in-app route, and keep images
> under `images/`, which is rewritten to `/guides/images/`.

## Getting started

New install? These three, in order, take you from a blank page to a working
library.

1. [First run — creating your account](first-run.md) — the setup admin, signing
   in, and what you see before anything is configured.
2. [Storage](storage.md) — the two things every install needs: somewhere to keep
   generated thumbnails, and at least one approved folder your libraries may read.
3. [Setting up libraries](libraries.md) — the Add-library wizard, pointing a
   library at a folder, and what happens on the first scan.

## Your account

- [Your account](your-account.md) — display name and sign-in email, themes, the
  e-reader address, and where likes, bookmarks, quotes, collections and things
  shared with you live.
- [Quotes](quotes.md) — passages you highlight while reading, famous lines and
  family sayings; the quote of the day, categories, and importing a pack.
- [Sharing with family](family-sharing.md) — one **Send to** button for
  everything: pass a book to someone, mail it to your e-reader, or make a guest
  link; notes under a book, a photo or a person; and **For you**, where what
  people send you lands.
- [Passkeys](passkeys.md) — signing in with a fingerprint, face or PIN instead of
  a password, and why no one-time code is needed.
- [Two-factor authentication](two-factor-authentication.md) — add a one-time code
  to your sign-in, manage backup codes, and what to do if you get locked out.
- [Link a device](link-a-device.md) — signing a TV, wall display or tablet in by
  scanning a code with your phone, and removing one later.

## Using your libraries

- [Audiobooks](library-audiobooks.md) — how folders become books with chapters,
  and where your place is kept.
- [Ebooks](library-ebooks.md) — EPUB and PDF, the in-app reader, and books that
  come in more than one format.
- [Gallery](library-gallery.md) — photos and videos, the timeline, albums,
  slideshows, and face recognition.
- [The Photo Inbox](photo-inbox.md) — re-scanning prints and taking photos from
  relatives: the holding library, the copy check, Keep and Replace, drop links,
  and asking someone what they remember.
- [Family tree](family-tree.md) — adding relatives, life events and photos, and
  letting someone edit their own branch.
- [Stories](stories.md) — writing a page from what the house already holds:
  chapters and their pages, narration, collections with their own access,
  reviews, and guest links.

## Running the server

- [The control panel](control-panel.md) — a tour of every section: status, backups,
  security, labels, logs, scheduled jobs, the recycle bin, and accounts.
- [Duplicate cleanup](duplicate-cleanup.md) — clearing out copied photos and
  folders, a saved job at a time, and what stops a delete going wrong.
- [Setting up email](email.md) — the SMTP settings, what the server sends, and why
  a save-and-test usually fails the first time. Needed before anyone can use
  emailed two-factor codes or receive security alerts.
- [Exposing your library to the internet](exposing-to-the-internet.md) — for the
  person running the server: putting it behind HTTPS and the settings to set first.

Two reference pages for whoever runs the server live outside this folder, because
they describe the container rather than the app:
[the configuration reference](../configuration.md) (every environment variable)
and [upgrading and rolling back](../rollback.md).

---

Looking for how it works under the hood rather than how to use it? The technical
reference lives in [`docs/`](../) — start with
[`architecture.md`](../architecture.md).
