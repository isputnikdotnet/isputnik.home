# Vendored: foliate-js

The EPUB rendering/navigation engine behind the [Foliate](https://github.com/johnfactotum/foliate)
reader. Used by the in-app ebook reader (`apps/web/src/features/audiobooks/reader/`).

- **Source:** https://github.com/johnfactotum/foliate-js
- **Pinned commit:** `78914aef4466eb960965702401634c2cb348e9b1`
- **License:** MIT (see `LICENSE`)

## Why vendored
foliate-js is distributed as ES-module source, not a published package, and its author
notes the API may change. We pin a copy so upstream churn can't reach us until we
deliberately re-vendor.

## EPUB-only build
This app only ever feeds EPUB bytes to foliate (PDFs use the app's own `<iframe>`
viewer). `view.js` reaches the other format parsers / TTS via dynamic `import()`,
which the bundler must still resolve — so to avoid pulling in the 13 MB `vendor/pdfjs`
and unused parsers, the following are **throwing stubs**, not the real modules:

- `comic-book.js`, `fb2.js`, `pdf.js`, `mobi.js`, `tts.js`, `vendor/fflate.js`

Everything else is the **unmodified upstream file**:

- `view.js`, `epub.js`, `epubcfi.js`, `paginator.js`, `fixed-layout.js`,
  `overlayer.js`, `progress.js`, `search.js`, `text-walker.js`, `vendor/zip.js`

`view.d.ts` is a local type shim (not from upstream).

## Re-vendoring
1. `git clone --depth 1 https://github.com/johnfactotum/foliate-js` and note the commit.
2. Copy the "unmodified upstream" files above over these.
3. Keep the six stub files and `view.d.ts` as they are.
4. Update the pinned commit above.
