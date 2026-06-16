# iSputnik Home - Architecture Restructure Proposal

## Purpose

This proposal recommends a simplified project structure before the project reaches production scale.

Since iSputnik Home is still an early-stage project and database resets are acceptable, structural changes can be made now with minimal cost and maximum long-term benefit.

---

# Goals

* Keep the architecture simple.
* Maintain clear separation between platform infrastructure and business features.
* Make it easier for AI tools and future contributors to understand the project.
* Keep Audiobooks, eBooks, Gallery, and future libraries consistent.
* Avoid large refactoring later.

---

# Current Assessment

The current structure is generally good:

* Separate Web and Server applications.
* Feature-based frontend organization.
* Documentation folder exists.
* Clear distinction between UI and backend.

The primary concern is that the backend `core` folder may eventually become a catch-all location for unrelated functionality.

---

# Recommended Structure

```text
isputnik.home/

apps/
├── web/
│   └── src/
│       ├── app/
│       ├── pages/
│       ├── features/
│       │   ├── audiobooks/
│       │   ├── ebooks/
│       │   ├── gallery/
│       │   ├── libraries/
│       │   ├── users/
│       │   ├── sharing/
│       │   └── settings/
│       ├── shared/
│       └── assets/
│
├── server/
│   └── src/
│       ├── core/
│       │   ├── auth/
│       │   ├── database/
│       │   ├── config/
│       │   ├── logging/
│       │   ├── storage/
│       │   └── permissions/
│       │
│       ├── modules/
│       │   ├── libraries/
│       │   ├── audiobooks/
│       │   ├── ebooks/
│       │   ├── gallery/
│       │   ├── users/
│       │   ├── sharing/
│       │   ├── scanning/
│       │   └── uploads/
│       │
│       └── shared/
│
docs/
assets/
```

---

# Core vs Modules

## Core

Core should contain only platform-wide infrastructure.

Examples:

* Authentication
* Authorization
* Database access
* Logging
* Configuration
* File storage
* Background job framework

Core should never contain audiobook-specific or ebook-specific logic.

---

## Modules

Modules contain actual product functionality.

Examples:

### Libraries

Responsible for:

* Library creation
* Library settings
* Access control
* Ownership
* Public/private visibility

### Audiobooks

Responsible for:

* Audiobook metadata
* Tracks
* Progress
* Narrators
* Series

### eBooks

Responsible for:

* EPUB support
* Reading progress
* Bookmarks
* Notes

### Gallery

Responsible for:

* Photos
* Albums
* Metadata
* Thumbnails

### Scanning

Responsible for:

* Scan jobs
* File discovery
* Metadata extraction
* Folder structure processing
* Encoding detection

---

# Library-Centric Design

The project should continue moving toward a library-centric model.

Every media type should behave similarly:

```text
Library
 ├─ Name
 ├─ Owner
 ├─ Public/Private
 ├─ Access Control
 ├─ Scan Policy
 ├─ Upload Policy
 └─ Supported Extensions
```

Examples:

* Audiobook Library
* eBook Library
* Gallery Library
* Document Library (future)
* Video Library (future)

This creates a consistent user experience across all library types.

---

# Users and Permissions

Recommend treating Users as a platform module rather than media-specific functionality.

```text
Users
Roles
Permissions
Groups (future)
Sharing
```

Access should be attached primarily to Libraries.

Examples:

* Public Library
* Private Library
* Shared Library
* Read Only
* Contributor
* Manager
* Owner

This keeps permission logic centralized.

---

# Categories

Recommend introducing a shared category system.

Examples:

```text
Categories
 ├─ Fiction
 ├─ History
 ├─ Science
 ├─ Fantasy
 ├─ Family Photos
 └─ Travel
```

Categories can be reused by multiple library types.

Advantages:

* Consistent filtering.
* Easier search.
* Reduced duplication.

---

# Scanning Framework

Scanning should be designed as an extensible pipeline.

Initial scan options:

1. File Metadata (Default)
2. Folder Metadata
3. Folder Structure
4. eBook Detection
5. Future AI Metadata

Future scan providers should be pluggable without redesigning the system.

---

# Frontend Recommendation

Use a feature-based organization.

Example:

```text
features/
├── audiobooks/
├── ebooks/
├── gallery/
├── libraries/
├── users/
├── sharing/
└── settings/
```

Pages should only contain routing and page layout.

Business logic should remain inside features.

---

# AI Development Considerations

This structure is highly AI-friendly because:

* Features are isolated.
* Folder purpose is obvious.
* New modules can be generated independently.
* Context windows stay smaller.
* Future code generation becomes more predictable.

---

# Recommendation

Proceed with restructuring now before additional features are added.

Priority order:

1. Establish Core vs Modules boundary.
2. Create Library module as the primary ownership model.
3. Centralize permissions and access control.
4. Introduce shared category support.
5. Build scanning as an extensible framework.
6. Keep frontend organized by feature.

No database migration planning is required because the project can be reset and rebuilt during development.
