It's SQLite (better-sqlite3), and the list endpoint to mirror is GET /api/library/audiobook-libraries/:id/books (books.ts:614) — a per-library query joining book_metadata, authors/narrators, series, and per-user playback_progress. A search endpoint would essentially be that same query with a WHERE title/author/narrator LIKE ? (or FTS) and spanning libraries instead of one.

