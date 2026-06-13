# About the Project

> ⚠️ **Heavily under construction — not ready for prime time.**
>
> iSputnik.home is in active, rapid development. Features, database schema, APIs, and the UI change frequently — often with breaking changes and without migrations. Expect incomplete features, rough edges, and updates that may require starting from a clean slate. Don't rely on it for important data. This is an experimental personal project shared as a work in progress, not a stable release.

iSputnik.home is an experimental self-hosted home server project created as a personal vision of what a modern family-oriented digital hub could be. The project is heavily assisted by AI and serves as both a learning experience and an exploration of new ideas in software design, automation, and media management.

The inspiration for iSputnik.home comes from several excellent open-source projects, including Audiobookshelf, Immich, Paperless-ngx, and other self-hosted applications. Rather than replicating any single solution, the goal is to combine the best ideas from these projects into a unified platform tailored for personal and family use.

This project represents my vision of a self-hosted home server where media, documents, books, notes, and other personal content can be organized, accessed, and shared through a simple and modern interface. While audiobooks and ebooks are currently the primary focus, the long-term goal is to expand into a broader home hub platform with additional modules and services.

iSputnik.home is still in its very early stages of development. Many features are experimental, designs continue to evolve, and the overall direction may change as new ideas are explored. The project should be considered a work in progress and the beginning of a much larger journey rather than a finished product.

## Current Progress

The project currently includes a functional web interface for managing audiobook and ebook libraries. Existing features include library scanning, metadata management, cover artwork, authors, narrators, series organization, categories, tags, and search capabilities.

Users can stream content directly from the browser, track listening progress, create bookmarks, adjust playback speed, and resume playback across devices. Support for multiple libraries and user accounts has also been implemented, allowing content to be organized and shared within a family environment.

Additional work has been completed on mobile-friendly interfaces, Progressive Web App (PWA) support, phone-style bottom navigation, offline listening, progress synchronization, QR code integration, and Docker-based deployment.

Development is ongoing, with active work focused on improving the user experience, modernizing the interface, hardening offline behavior, and building the foundation for future modules beyond audiobooks and ebooks.

## Current Features

### Library Management

* Audiobook and ebook library support
* Multiple library support
* Automatic library scanning
* Metadata extraction and management
* Cover artwork support
* Authors, narrators, series, publishers, and categories
* Tags and custom organization
* Advanced search and filtering

### Reading & Listening

* Built-in audiobook player
* Built-in ebook reader
* Resume playback and reading position
* Listening progress tracking
* Bookmarks
* Playback speed controls
* Chapter navigation
* Mark books as finished or reset progress

### User Experience

* Modern web interface
* Responsive design for desktop, tablet, and mobile devices
* Progressive Web App (PWA) support
* Phone-style PWA bottom navigation for Home, Media, Downloads, Collections, and Profile
* Icon-only secondary navigation for personal library, profile, downloads, collections, and theme pages on phones
* QR code integration for quick access
* Dark and light theme support
* Customizable library views

### Multi-User Features

* Multiple user accounts
* User groups and permissions
* Shared and personal libraries
* User profiles
* Progress tracking per user

### Mobile & Offline

* Installable on Android and iPhone as a PWA
* Offline listening support
* Download books for offline use
* Downloaded books keep local metadata for offline detail and player fallback
* Private runtime caches are cleared on logout and account switches
* Progress synchronization after reconnecting

### Administration

* Docker deployment
* Library management tools
* User management
* Metadata management
* Activity logging
* Configuration through web interface

### In Development

* Android companion application
* Additional home server modules
* Document management
* Notes and personal knowledge features
* External library integrations
