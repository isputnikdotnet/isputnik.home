# Digital Library — Ebook Library Type

A standalone library type for EPUB/PDF ebooks, with its own browse area and an in-app reader. It is **built on the shared book tables**, not a parallel stack — see the data-model rationale below.

See [`architecture.md`](architecture.md) for how library types fit together and [`audiobook-library.md`](audiobook-library.md) for the sibling type.

---

## Data model — reuse, don't duplicate

An ebook is a **`books` row whose content is a `book_document`** (the `.epub`/`.pdf` file) instead of `book_files` (audio tracks). It reuses `book_metadata`, `authors`, `series`, `categories`, `tags`, `book_saves`, and the `shares` model unchanged. `libraries.type = 'ebook'` separates ebooks from audiobooks in every query.

Why reuse rather than parallel `ebook_*` tables:
- The architecture's "type-specific tables" means type-specific **scanner and display** — the `libraries` table (and the per-item book tables) are shared.
- `book_documents` (added for audiobook companion files) already models "a file attached to a book", which is exactly what an ebook is.
- Filtering, sharing, author-merge, categories/tags, ownership, and soft-delete all work for ebooks with **no new code**.

The audiobook-only tables (`book_files`, `playback_progress`) are simply unused by ebooks.

---

## Scan pipeline

`modules/library/ebook/scanner.ts`, on its own job type `SCAN_EBOOK_LIBRARY`:

1. Walk the library folder; each `.epub` / `.pdf` is one book (matched to an existing book by relative path for idempotent rescans).
2. **EPUB** — parse the OPF (`META-INF/container.xml` → OPF) for title, creator(s), language, year, ISBN, `dc:subject` (→ tags + category), and the cover image. Extraction uses `adm-zip`; covers are resized to WebP thumbnails with `sharp` (same `{bookId}-cover.webp` / `-cover-large.webp` convention as audiobooks).
3. **PDF** — filename as the title (PDFs carry little reliable metadata).
4. Write `books` + `book_metadata` + `book_authors` (alias-aware, so author merges apply) + tags/category, and store the file itself in `book_documents`.
5. Soft-delete books whose files vanished.

Manual metadata (`book_metadata.source = 'manual'`) is preserved across rescans.

---

## Reading

The detail and document-serving endpoints are **shared** with audiobooks (`GET /api/library/books/:id`, `.../documents/:docId`) — an ebook book returns `files: 0` and the ebook as a `document`.

The in-app reader is a full-screen overlay (portaled to `<body>`):
- **PDF** — the browser's native PDF viewer in an iframe.
- **EPUB** — `epub.js` paginated reader (`EpubReader.tsx`), fetched with credentials so the auth-gated endpoint works. The reader includes one-page/two-page layout control, page navigation, table-of-contents navigation with tolerant TOC href resolution for EPUB path variants, font-size controls, progress display, and CFI-based resume.
- **MOBI / AZW3** — download-only; no in-browser renderer (would require server-side conversion).

Because the reader is shared, an audiobook's bundled companion EPUB is readable the same way.

### Reading progress

EPUB reading progress is stored per user/book/document in `reading_progress`:

```sql
reading_progress
id               TEXT PRIMARY KEY
user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE
document_id      TEXT NOT NULL REFERENCES book_documents(id) ON DELETE CASCADE
cfi              TEXT NOT NULL
percent_complete REAL
label            TEXT
updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
completed_at     TEXT
UNIQUE(user_id, book_id, document_id)
```

The reader keeps a localStorage fallback for fast/offline-ish resume and syncs the current EPUB CFI to the server through `GET`/`PATCH`/`DELETE /api/library/books/:id/reading-progress?documentId=...`. Completion is set when progress reaches `0.98`, matching the audiobook convention.

---

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/library/ebook-libraries` | admin | Create a library and queue a scan. |
| `GET` | `/api/library/ebook-libraries` | any user | List accessible ebook libraries. |
| `GET` | `/api/library/ebook-libraries/:id/books` | any user | List books in a library. |
| `POST` | `/api/library/ebook-libraries/:id/rescan` | admin | Re-scan from disk. |
| `DELETE` | `/api/library/ebook-libraries/:id` | admin | Delete the catalogue entry (files untouched). |

Detail + reading reuse `/api/library/books/:id` and `/api/library/books/:id/documents/:docId`.
Reading progress uses `/api/library/books/:id/reading-progress`.

---

## Browse and detail

- **`/ebooks`** — a browse page with the top-nav **Ebooks** entry, reusing the shared book grid, filter, and sort. The ebook books endpoint returns an audiobook-compatible shape so `BookFilter`/cards work unchanged.
- **`/ebooks/books/:id`** — the shared book detail, made ebook-aware: when a book has no audio files, the primary action is **Read** (not Play), "Mark finished" and the Files section are hidden, and the Documents section drives reading/download.

## Status

- Backend scanner, EPUB metadata + cover extraction, library CRUD/rescan — **done**.
- EPUB reader (`epub.js`) + PDF reader overlay — **done**.
- EPUB reading progress and resume — **done**.
- Control panel management (create/list/rescan/delete ebook libraries) — **done**.
- User-facing `/ebooks` browse + ebook-aware detail page — **done**.
- **Future:** PDF page progress and lazy-loading the reader bundle.
