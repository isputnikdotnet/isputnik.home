# About the Project

> ⚠️ **Under active construction — expect movement.**
>
> iSputnik.home is in active, rapid development. Features, APIs, and the UI change frequently, and while the database now migrates between releases and built-in backups exist, breaking changes still happen. Expect rough edges and the occasional bump on upgrade. Keep your own copies of anything irreplaceable. This is an experimental personal project shared as a work in progress, not a stable release.

iSputnik.home is an experimental self-hosted home server project created as a personal vision of what a modern family-oriented digital hub could be. The project is heavily assisted by AI and serves as both a learning experience and an exploration of new ideas in software design, automation, and media management.

The inspiration for iSputnik.home comes from several excellent open-source projects, including Audiobookshelf, Immich, Paperless-ngx, and other self-hosted applications. Rather than replicating any single solution, the goal is to combine the best ideas from these projects into a unified platform tailored for personal and family use.

This project represents my vision of a self-hosted home server where media, documents, books, notes, and other personal content can be organized, accessed, and shared through a simple and modern interface. It started with audiobooks and ebooks and has since grown a photo and video gallery, face recognition, and a family tree; the long-term goal is a broader home hub platform with additional modules and services.

iSputnik.home is still evolving quickly. Some features are experimental, designs continue to change, and the overall direction may shift as new ideas are explored. The project should be considered a work in progress and part of a much larger journey rather than a finished product.

## Documentation

* [User guides](docs/users/README.md) — setting up a new install, and using each
  part of it. Start with [first run](docs/users/first-run.md).
* [Technical reference](docs/architecture.md) — architecture, schema, and the
  design notes behind each module.

## Current Progress

The project has grown into a working family media library with three media types — audiobooks, ebooks, and a photo/video gallery — sharing one catalog: libraries, scanning, metadata, cover artwork, authors and narrators, series, categories, tags, collections, favorites, and search with an A–Z index run across all of them.

Users stream audiobooks and read ebooks directly in the browser, with progress, bookmarks, and highlights that follow them across devices. The gallery organizes photos and videos into timeline and folder views, recognizes faces and groups them into people, and connects those people to an interactive family tree. Multiple user accounts with per-user progress and permissions let a household share one server while keeping personal things personal.

The server side has matured alongside: a full control panel, scheduled jobs, a recycle bin, built-in backups, activity logging with a dashboard, and a security layer (two-factor sign-in, account lockout, rate limits, trusted zones) designed for cautiously exposing the server beyond the home network. Releases ship as Docker images with an Unraid Community Applications template.

Development is ongoing, with active work focused on improving the user experience, deepening the mobile pages, and building the foundation for future modules beyond the media library.

## Current Features

### Library Management

* Audiobook, ebook, and photo/video gallery libraries
* Multiple libraries per media type
* Automatic library scanning
* Metadata extraction and management
* Cover artwork support
* Authors, narrators, series, publishers, and categories
* Tags, collections, and favorites shared across media types
* Advanced search and filtering, with an A–Z index on browse pages

### Listening

* Built-in audiobook player with chapter navigation
* Resume playback across devices
* Listening progress tracking
* Bookmarks
* Playback speed controls
* Mark books as finished or reset progress

### Reading

* Built-in ebook reader for EPUB and FB2, plus in-browser PDF viewing
* Books that come in more than one format, grouped as one title
* Editions — multiple releases of the same work under one entry
* Quotes and highlights, captured from the reader or added by hand
* Send to e-reader, and OPDS feeds for reading apps

### Photos & Videos

* Timeline and folder views, plus albums
* EXIF metadata and video support
* Face recognition that groups faces into people
* Folder locks that protect precious folders from cleanup tools

### Slideshows & Movies

* Ordered sets of photos and videos, playable full-screen in the browser
* Transitions — crossfade, fade, slide, Ken Burns, dip to black, or random —
  with adjustable seconds-per-photo and transition length
* Your own music track, looping under live playback and mixed into the movie
* **Render to MP4** (H.264, 1080p) as a background job with live progress and
  cancel — the live preview and the exported movie use the same timings
* A configurable title card: title and subtitle, hold time, and a background of
  black, one of the slideshow's own photos, a blurred photo, or a photo collage
* Suggested slideshows, clustered from dates, places, and named people — with
  burst shots and near-duplicates automatically collapsed to one photo
* Rendered movies can be filed into a gallery library automatically; re-renders
  replace the old file instead of piling up copies

### Duplicate Cleanup

* A job-based cleanup that survives the browser: close it, come back next week,
  and every decision you already made is still there
* A four-step wizard — pick libraries, choose whole folders or single files,
  photos or videos or both
* Folder instructions: mark a folder **Keep** (its copies win) or **Clear**
  (its contents are safe elsewhere and may go) before the scan runs
* Read-only libraries count as safe copies but are never touched
* One cleanup at a time, owned by whoever started it — with take-over for when
  they aren't coming back
* Everything removed goes to the Recycle Bin and can be restored until it is
  emptied deliberately

### Family Tree

* Relatives, relationships, life events, and photos
* People from the gallery take their place on an interactive chart
* Branch editing — let someone maintain their own part of the tree

### User Experience

* Modern web interface
* Responsive design for desktop, tablet, and mobile devices
* Progressive Web App (PWA) support
* Dark and light theme support
* Customizable library views

### Multi-User Features

* Multiple user accounts
* User groups and permissions
* Shared and personal libraries
* User profiles
* Progress tracking per user

### Mobile & Offline

* Installable on Android and iPhone as a PWA, with phone-style bottom
  navigation for Home, Media, Downloads, Collections, and Profile
* Download audiobooks to the device and keep listening with no server in reach
* A Downloads page that shows what is on the device and how much space it takes
* Downloaded books keep their metadata locally, so detail pages and the player
  keep working fully offline
* Progress made offline syncs back to the server after reconnecting
* Private runtime caches are cleared on logout and account switches, so a
  shared phone doesn't leak one account's library to the next
* QR code integration for quick access from a phone

### Security

* Two-factor sign-in with an authenticator app (TOTP) or emailed one-time
  codes, plus backup codes for when the phone is gone
* Account lockout after repeated failed sign-ins, and IP blocking for
  persistent offenders
* Trusted zones, so your home network isn't treated like the open internet
* Email alerts to admins when something security-relevant happens
* Global rate limiting and a strict Content Security Policy
* HTTPS-aware out of the box: secure cookies, HSTS, an http→https redirect,
  and reverse-proxy trust settings (`TRUST_PROXY`) so logs and rate limits see
  the real visitor
* Sign-ins and security events land in the activity log
* A step-by-step [guide to exposing the server to the internet](docs/users/exposing-to-the-internet.md)
  safely — reverse proxy, HTTPS, and the settings to flip first

### Administration

* Docker deployment, with an Unraid Community Applications template
* Full control panel: libraries, accounts, labels, logs, and settings
* Scheduled jobs and a recycle bin
* Built-in backups with restore
* Activity dashboard with charts
* In-app user guides that ship with the server

### In Development

* Deeper mobile versions of the library pages
* Smarter duplicate detection (near-identical photos)
* Additional home server modules
* Document management
* Notes and personal knowledge features

## Contributing

Bug reports and documentation fixes are welcome; please open an issue before
starting anything large. See [CONTRIBUTING.md](CONTRIBUTING.md), and report
security problems privately as described in [SECURITY.md](SECURITY.md) rather
than as a public issue.

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).

In short: you are free to use, modify, and redistribute this software, but any
modified version you distribute — **or run as a network service that other
people use** — must also be made available under the same license.
