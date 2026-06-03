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
- **EPUB** — `epub.js` paginated reader (`EpubReader.tsx`), fetched with credentials so the auth-gated endpoint works.
- **MOBI / AZW3** — download-only; no in-browser renderer (would require server-side conversion).

Because the reader is shared, an audiobook's bundled companion EPUB is readable the same way.

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

---

## Status

- Backend scanner, EPUB metadata + cover extraction, library CRUD/rescan — **done**.
- EPUB reader (`epub.js`) + PDF reader overlay — **done**.
- Control panel management (create/list/rescan/delete ebook libraries) — **done**.
- **Pending:** a dedicated `/ebooks` browse page for users and an ebook-appropriate detail page (today an ebook opened via the audiobook detail shows audio actions like Play that don't apply).
