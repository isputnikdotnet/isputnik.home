# iSputnik Home — Architecture Restructure Proposal

> **Revised 2026-06-16** against the actual code in `apps/server/src` and
> `apps/web/src`. The original draft described a target that was largely already
> built; this version separates *what already exists*, *what needs fixing now*,
> and *what is genuinely future work*.

## Purpose

Lock in a clean, consistent structure while the project is still early and
database resets are free. The goal is not a big-bang rewrite — most of the
target structure already exists. The goal is to (a) finish enforcing the
boundaries we already started, and (b) write down the conventions so new media
types stay consistent.

---

# Goals

* Keep the architecture simple.
* Maintain a clear separation between platform **infrastructure** (`core`) and
  product **features** (`modules`).
* Keep Audiobooks, eBooks, and future libraries consistent under a single
  library model.
* Make the layout obvious to future contributors and AI tools.
* Avoid large refactoring later.

---

# Current Assessment (accurate as of 2026-06-16)

The structure is already in good shape and mostly matches the original target:

* ✅ Separate `apps/web` and `apps/server` workspaces.
* ✅ Backend already split into `core/` and `modules/`.
* ✅ Media types already live *inside* a library module
  (`modules/library/audiobook`, `modules/library/ebook`) over a shared layer
  (`modules/library/shared`) — this is more library-centric than the original
  proposal's flat layout (see *Library-Centric Design*).
* ✅ Frontend is already feature-based (`apps/web/src/features`).
* ✅ Cross-type **categories**, **tags**, **collections**, **bookmarks**, and a
  **recycle bin** already exist and work across library types.

**The one real, present problem:** `core/` is *already* a catch-all. It mixes
genuine infrastructure with product features. Today `apps/server/src/core`
contains:

| Belongs in `core` (infrastructure) | Should move to `modules` (product) |
| --- | --- |
| `auth-routes.ts`, `sessions.ts` | `users.ts` |
| `permissions.ts` | `groups.ts` |
| `app-config.ts`, `config.ts` | `invites.ts` |
| `logs.ts`, `status.ts` | `profile.ts` |
| `setup.ts`, `shared.ts` | `uploads.ts` |
| `db.ts`, `crypto.ts` | `backups.ts` |

So the risk the original draft framed as "core *may eventually* become a
catch-all" has already happened. Fixing it is the highest-value item here.

---

# Target Structure

This reflects the **current** layout plus the moves recommended below. Items
marked *(future)* do not exist yet.

```text
isputnik.home/

apps/
├── web/
│   └── src/
│       ├── app/
│       ├── pages/                 # routing + layout only
│       ├── features/
│       │   ├── audiobooks/
│       │   ├── library/
│       │   ├── collections/
│       │   ├── share/
│       │   ├── control/
│       │   └── ebooks/            # (future) split out of library if it grows
│       ├── shared/
│       ├── offline/  pwa/         # installable-app concerns
│       └── assets/
│
├── server/
│   └── src/
│       ├── core/                  # platform infrastructure ONLY
│       │   ├── auth/              # auth-routes, sessions, crypto
│       │   ├── permissions/
│       │   ├── config/            # app-config, config
│       │   ├── logging/           # logs, status
│       │   ├── database/          # db
│       │   └── setup/
│       │
│       ├── modules/               # product functionality
│       │   ├── library/
│       │   │   ├── shared/        # crud, access, serializer, trash, …
│       │   │   ├── audiobook/
│       │   │   ├── ebook/
│       │   │   └── gallery/       # (future)
│       │   ├── collections/
│       │   ├── users/             # MOVE from core (users, groups, invites, profile)
│       │   ├── uploads/           # MOVE from core
│       │   └── backups/           # MOVE from core
│       │
│       └── shared/
│
docs/
assets/
```

---

# Core vs Modules

## Core — infrastructure only

Things every module depends on, with no product knowledge:

* Authentication & sessions
* Authorization / permissions
* Database access
* Configuration
* Logging & status
* File storage primitives
* (future) Background-job framework

`core` must never contain audiobook-, ebook-, or user-feature-specific logic.

## Modules — product functionality

### Library (and its media types)

`modules/library` owns the library model and its per-type implementations.
Media types are **nested**, not peers of `library`:

* `library/shared` — crud, access control, ownership, serialization, trash,
  members, metadata, thumbnails, storage roots.
* `library/audiobook` — metadata, tracks, progress, narrators, series,
  chapters, provider enrichment.
* `library/ebook` — EPUB support, reading progress, bookmarks.
* `library/gallery` *(future)* — photos, albums, thumbnails.

### Collections

Polymorphic, cross-type sets of items. Already its own module
(`modules/collections`) — keep it that way.

### Users *(move out of core)*

Users, groups, invites, profiles. Treat as a platform-level product module, not
infrastructure. Access is attached primarily to libraries.

### Scanning

Currently per-type (`audiobook/scanner.ts`, `ebook/scanner.ts`). See *Scanning*
below — extracting a shared pipeline is a future decision, not a now task.

---

# Library-Centric Design

Continue the library-centric model the code already follows. Every media type
shares the same library shape:

```text
Library
 ├─ Name
 ├─ Owner
 ├─ Public / Private
 ├─ Access Control
 ├─ Scan Policy
 ├─ Upload Policy
 └─ Supported Extensions
```

Examples: Audiobook Library, eBook Library, Gallery Library *(future)*,
Document Library *(future)*, Video Library *(future)*.

**Decision (resolved):** keep media types nested under `modules/library/*` with
a shared layer, rather than promoting `audiobooks/` / `ebooks/` / `gallery/` to
top-level peers of `library`. The nested layout *is* the library-centric model —
flat peers would push us back toward a media-type-centric structure.

---

# Users and Permissions

* Permissions logic stays centralized in `core/permissions`.
* Users/groups/invites/profile move into `modules/users`.
* Access is attached to libraries: Public, Private, Shared; roles Read-Only,
  Contributor, Manager, Owner.

This keeps the *enforcement* primitive in `core` while the *user feature* lives
in a module.

---

# Categories, Tags, Collections (already shared — keep, don't rebuild)

These cross-type systems already exist and work across library types:

* **Categories** — `modules/library/categories.ts`, seeded via
  `categories-seed.ts`, with category artwork in `apps/web/src/assets/categories`.
* **Tags** — `modules/library/tags.ts`.
* **Collections** — `modules/collections`.
* **Bookmarks** — per-type, cross-type aware.

No new "shared category system" needs to be introduced. The only convention
worth enforcing: when a new media type is added, make sure its hydrator filters
by `libraries.type` and passes the correct `entityType` so it joins these shared
systems correctly.

---

# Scanning Framework (future spike, not a now task)

Today each media type owns its scanner, which keeps audiobook-specific concerns
(m4b chapter parsing, provider enrichment) separate from image/gallery concerns.

A unified, pluggable scan pipeline is appealing:

```text
1. File Metadata (default)
2. Folder Metadata
3. Folder Structure
4. eBook Detection
5. AI Metadata (future)
```

But audiobook and gallery scanning share little today, so a shared abstraction
should **earn its keep** before we extract it. Recommend treating this as a
spike when the third media type (gallery) lands — that's the point where the
common shape becomes visible. Do not refactor scanning preemptively.

---

# Frontend

Already feature-based — keep it. Conventions to hold:

* `pages/` contains routing and layout only; business logic lives in `features/`.
* Shared UI goes through `apps/web/src/shared` (see `docs/UI-CONVENTIONS.md` —
  Modal, Button, ConfirmDialog, MessageBox). Never inline one-offs.
* Keep `offline/` and `pwa/` as first-class concerns; the installed app is a
  real target, not an afterthought.

Current feature set: `audiobooks`, `library`, `collections`, `share`, `control`.
Split `ebooks` into its own feature folder only if/when its UI outgrows the
shared library views.

---

# AI Development Considerations

The structure is AI-friendly because feature boundaries are explicit, folder
purpose is obvious, new modules can be added in isolation, and context windows
stay small. Finishing the `core`/`modules` cleanup below makes this stronger:
an AI tool can trust that anything in `core` is infrastructure and anything in
`modules` is a product feature.

---

# Recommendation — prioritized, grounded in current state

1. **Purge `core` of product code.** Move `users`, `groups`, `invites`,
   `profile`, `uploads`, `backups` from `core/` into `modules/`. *(Highest value —
   this is the one real structural problem today.)*
2. **Write down the `core` vs `modules` rule** (infrastructure vs product) so the
   catch-all doesn't re-form.
3. **Document the library-centric convention**: media types nest under
   `modules/library/*` over a shared layer; new types must join the shared
   categories/tags/collections systems via correct `type`/`entityType` wiring.
4. **Leave categories/tags/collections as-is** — they already exist; do not
   rebuild.
5. **Defer the unified scanning pipeline** to a spike when Gallery lands.
6. **Keep the frontend feature-based**; split `ebooks` out only when it grows.

Database migrations are not a blocker now — the dev database can be reset and
rebuilt. (This assumption has a shelf life; revisit before the first real
deployment with data worth keeping.)
