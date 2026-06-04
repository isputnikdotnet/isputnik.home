DONE (v0.6.0): server-side search/filter/sort/paging for audiobooks lives in
`POST /api/library/audiobooks/catalog` + `GET /api/library/audiobooks/facets`
(catalog.ts / books-routes.ts), consumed by the `useAudiobookCatalog` hook.
Search is LIKE-based for now; SQLite FTS5 is the upgrade path if ranked/typo-
tolerant full-text is wanted. Still client-side: Authors/Narrators/Series browse
pages and the Ebooks library type.

