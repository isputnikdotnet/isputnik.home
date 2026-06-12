# Digital Library — Special Sections

## Overview

A **Special Section** groups one or more audiobook libraries under a single master entry in the audiobook sidebar, and lets each member library **overwrite** selected metadata for every book it contains. It was built for collections like *Model for Assembly* (МДС) — a long-running radio program whose files were gathered from many sources, so embedded tags are inconsistent and a constant Narrator/Category/Description is wanted across the whole set.

A Special Section is **not a new library type**. It reuses the entire audiobook engine — the same scanner, streaming, player, bookmarks, My List, and progress. It adds only two things:

1. A small grouping entity (`library_sections`) that owns an identity — name + icon.
2. Per-library **overrides** stored in each member library's `settings_json`, applied by the scanner on add and rescan.

---

## Model

```
library_sections (id, name, icon)        ← the grouping shell: identity only
        ▲
        │  settings_json.section_id
        │
libraries (type = 'audiobook')           ← each member library
   settings_json.overrides = {            ← its own overwrite rules
     author, narrator, description,
     category_key, tags[]
   }
```

- A section owns **only** name + icon. It holds no metadata of its own.
- Membership is a `section_id` written into the library's `settings_json` — no schema change to `libraries`.
- **Overrides are per-library**, not per-section. Each library you add to a section gets its own overwrite values; nothing is inherited or hardcoded.

---

## Display

- Each section appears as an item in the **audiobook sidebar** (`AudiobookNav`), below the standard links, using its chosen icon. The nav self-fetches `GET /api/library/sections`, so every audiobook page shows the section links.
- Clicking a section opens its view (`/audiobooks/sections/:id`) — a combined book grid across the section's member libraries, with search and a per-library filter.
- Member-library books are **excluded from the main Books grid** and from the library filter on the Books page. They are reachable only through the section.

---

## Overwrite-on-add

When a library belongs to a section, its `settings.overrides` are applied during scan (`prepareBookScan`) for every book:

| Field | Behaviour |
|---|---|
| Author | Replaces scanned authors. **Blank → keep scanned author** (e.g. each story's real writer from the tag). Comma-separated for multiple. |
| Narrator | Replaces scanned narrators. Blank → keep scanned. |
| Description | Replaces scanned description. Blank → keep scanned. |
| Category | Forces the book's primary category by key. Blank → normal keyword matching from tags. |
| Tags | Replaces the book's tag set. Blank → keep scanned genre tags. |

Rules:

- Overrides apply on **initial scan and every rescan**.
- They are written as `source = 'scan'`, so the existing **manual-edit lock still wins** — a per-book manual edit (`source = 'manual'`) is never overwritten by overrides.
- A library with active overrides **bypasses the unchanged-files fast path** on rescan, so changing the override values and rescanning re-applies them to every book.
- Editing overrides on an existing library updates `settings_json` only; click **Rescan** on that library to apply the new values to already-scanned books.

---

## Custom category

The Category override reuses the existing category system. Create a custom category first in **Control Panel → Categories** (e.g. "Model for Assembly"), then select it in the library's override fields. No special handling is needed — it is an ordinary admin-created category.

---

## Admin management

Under **Control Panel → Digital Library → Audiobooks**, which has two deep-linkable tabs:

- **Audiobooks** tab (`/control/libraries`) — normal libraries only; adding a library here creates a normal (non-section) library.
- **Special libraries** tab (`/control/libraries/special`) — section-member libraries plus section management:
  - **Add section** — name + icon picker (radio, archive, library, podcast, …).
  - Section list with edit/delete. Deleting a section **detaches** its member libraries (their `section_id` is removed and they reappear in the main grid); no books or files are removed.
  - **Add library** here attaches to a section and shows the per-library override fields (Author, Narrator, Category, Tags, Description).

Editing any library exposes the section selector + override fields, so a library can be moved between the normal grid and a section.

---

## API

```
GET    /api/library/sections                 → { sections: [{ id, name, icon, libraryCount }] }   (any authenticated user)
POST   /api/library/sections                 { name, icon }                                        (admin)
PATCH  /api/library/sections/:id             { name, icon }                                        (admin)
DELETE /api/library/sections/:id             → detaches members, deletes section                   (admin)

POST   /api/library/audiobook-libraries      { …, sectionId?, overrides? }                         (admin)
PATCH  /api/library/audiobook-libraries/:id  { …, sectionId?, overrides? }                         (admin)
```

The `overrides` payload (camelCase) is `{ author?, narrator?, description?, categoryKey?, tags? }`. It is stored snake_case in `settings_json` and exposed back to admins on the library list.

---

## Database

```sql
library_sections
----------------
id          TEXT PRIMARY KEY
name        TEXT NOT NULL
icon        TEXT NOT NULL DEFAULT 'radio'
created_by  TEXT NOT NULL REFERENCES users(id)
created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Membership and overrides live in `libraries.settings_json`:

```json
{
  "section_id": "<library_sections.id>",
  "overrides": {
    "author": "",
    "narrator": "Vladislav Kopp",
    "description": "Model for Assembly — literary-musical radio program…",
    "category_key": "model_for_assembly",
    "tags": ["radio show", "МДС"]
  }
}
```

Member counts are derived with `json_extract(libraries.settings_json, '$.section_id')`.

---

## Safety

Unchanged from the audiobook library type: source files are never modified, overrides only affect database metadata, and deleting a section never deletes books or files.
