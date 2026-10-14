# Back sides — proposal

Status: agreed 2026-10-14; **phases 1 and 2 built the same day** (as-built notes
under "Phase 1 as built" and "Phase 2 as built" below); phase 3 (Swap sides,
camera capture) open. Written from a discussion about prints that
carry writing on the back, a look at how other tools handle them, and the owner's own
Epson FastFoto output (`C:\Users\sergeym\Pictures\FastFoto`, 30 prints). Companion to
[gallery-library.md](gallery-library.md), [scanner.md](scanner.md),
[uploads.md](uploads.md), [duplicate-detection.md](duplicate-detection.md),
[recycle-bin.md](recycle-bin.md), [lightbox-panel.md](lightbox-panel.md) and
[photo-review-plan.md](photo-review-plan.md), which describe the pieces this stands
on. Decisions are recorded so they need not be re-argued; open questions are recorded
so they are not silently answered by whoever writes the code first.

Mock of the settings card (private link): https://claude.ai/artifact/K26QHuDn1PwiNBVSUEcVpi

## Goal

An old print often has the only record of who, when and where written on its back.
When both sides are scanned, the app should show **one photo with two sides**, not two
photos: the front in every grid, strip, album, slideshow and share, and the back one
flip away, with its own rotation, wherever the front is looked at closely.

The idea in one line: **the back is an attachment of the front, never an item of
its own.**

## The mental model

| Question | Answer |
| --- | --- |
| What is a back? | A second image file recorded on the front's `gallery_details` row. It has no `library_items` row. |
| Where does the file live? | Beside the front, same folder, the front's name plus a suffix (`X_b.jpg`, `X_back.jpg`). |
| How do front and back get paired? | By file name, under a **rule set per library** (Scanning tab), or by an explicit action on a photo. |
| What does the viewer see? | The front. A small corner mark on the tile says there is a back; **Flip** shows it in the lightbox, Review mode and the share page. |
| What does the back inherit? | Everything: date, place, people, tags, albums, likes, notes belong to the front. The back has only its own rotation. |
| What never looks at a back? | Face recognition, the duplicate scan, slideshows, Memories, the timeline, counts. |
| Can it be undone? | Yes. Remove the back (file to the Recycle Bin) or Split it off (it becomes a photo again). |

## Non-goals

- **Handwriting recognition.** Nobody in the field does it well for 1950s ink; the
  people who want searchable text retype it. No OCR, now or planned.
- **Stitching front and back into one image.** It destroys the original scan and there
  is nothing to flip. Other tools' users do it for lack of anything better and regret
  it.
- **Sets of more than two images** (a letter scanned over five pages, a photo plus
  its envelope plus its frame). Different viewing needs; a different feature. Nothing
  here prevents it later, since the back is one column on the front's row.
- **Archive-style naming where the front is suffixed too** (`_r` / `_v`). Needs a
  front pattern as well as a back one; nothing in the household's workflow produces it.
- **Treating Epson's `_a` enhanced copy as a third side.** It stays an ordinary photo
  until the duplicate cleanup decides which twin survives (see decision 6).
- **Swap sides** (make the back the front). Deferred to a second phase; the pairing
  action already asks which side is the front, so a swap is only ever a correction.

## What already exists

- **One file = one item.** Every gallery photo is a `library_items` row whose
  `folder_path` is its file path, with a 1:1 `gallery_details` row
  (`relative_path`, `rotation`, `preview_storage_key`, …). The scanner walk collects
  every file, ingests each, then **reconciles**: an item whose path is no longer on
  disk is soft-deleted (`scanner.ts`).
- **Rotation** is per item, baked into regenerated thumbnails only, preserved across
  rescans because the UPSERT never writes the column (`rotate.ts`).
- **Uploads** stream to a staging folder, then each file is filed into
  `YYYY/YYYY-MM-DD` by its own EXIF date (upload time when there is none), renamed on
  collision by `uniqueGalleryFileName` (`X (2).jpg`), and catalogued by
  `scanSingleGalleryFile` (`upload-routes.ts`). Drop links, music, voice notes and
  story recordings all land files the same way (`files.ts`).
- **Replace** swaps the file behind an item without changing its id, and sets the old
  file aside in `replaced/` beside the Recycle Bin rather than overwriting the only
  copy (`replace.ts`, `replaced.ts`).
- **Move** re-homes an item and its thumbnails (`move.ts`, used by Inbox Keep);
  folder moves and storage moves move whole trees.
- **The Recycle Bin** soft-deletes rows with a `TrashSource` (`manual`,
  `duplicate_cleanup`, `photo_inbox`) and restores them with their metadata intact.
- **Per-library scan settings** live in `settings_json` (`scan_extensions`,
  `companion_extensions`, `scan_sources`) and are edited on the library's
  **Scanning** tab (`LibrariesSection.tsx`, `LibraryWizard.tsx`), which for a gallery
  library today holds only the File metadata source.
- **The lightbox** keyboard: Escape, arrows, Space (slideshow), `F` (like). The
  details panel has Description and Notes; Review mode has When and Where pickers and
  dictation.

## What the field does (research, 2026-10-14)

- **Apps built for prints** (Photomyne, Legacybox) keep the back inside the photo,
  mark the tile with a folded-corner icon, flip on one control, and never show the
  back in a grid. Legacybox rotates each side separately and offers "Swap to front".
- **Epson FastFoto** detects writing on the back in one pass and saves it as
  `<name>_b.jpg`; `<name>_a.jpg` is the auto-enhanced front. The suffixes are fixed.
  Blank backs are skipped. The files carry no EXIF at all.
- **General photo managers** (Immich, PhotoPrism, digiKam, IMatch, Piwigo,
  PhotoStructure) have no front/back notion; users stack or group by filename and ask
  for a flip. IMatch's developer called a flip "a lot of work for a small audience".
- **Genealogy tools** (FamilySearch) have nothing; users stitch, or attach both as
  separate photos, or retype the text.
- **Archives** use recto/verso (`_r` / `_v`) with sidecar metadata.

Takeaways: companion files are the mainstream answer and `_b` is already on disk for
every Epson owner; the back belongs inside the photo; per-side rotation and a swap are
worth copying; nobody OCRs handwriting.

## What the owner's Epson folder shows

30 prints → 30 fronts, 30 `_a` enhanced copies, 18 `_b` backs (Epson skipped the
blank ones, correctly). No EXIF: no date, no orientation. The back of print 0015 is
upside down (the inscription "Май 1949 г., 9 мес." sits in a corner rotated 180°).
Back and front dimensions differ by a few pixels (auto-crop). The back's file time can
be 15 minutes after the front's. The `X` / `X_a` pairs are about to go through
duplicate cleanup.

Consequences: pairing is by name only, never by time; per-side rotation is required;
nothing may assume equal dimensions; the back must survive whichever twin the cleanup
removes.

## Decisions taken

1. **The back is an attachment, not an item.** Columns on the front's
   `gallery_details` row; no row of its own; never in counts, scans, slideshows,
   Memories or the timeline. (Rejected: a hidden second item linked by a join table,
   the way voice notes attach an audio item — hidden items leak into every count and
   scan and would have to be excluded everywhere.)

2. **The file lives beside the front under the front's name plus a suffix.** This
   survives rescans, works for bulk flatbed scanning, keeps the two sides together for
   anyone browsing the folder outside the app, and rides along wherever the front's
   file is moved.

3. **Pairing is a per-library rule, set on the Scanning tab.** Presets plus custom
   patterns, like the book layouts, but **not** the `library_scan_rules` engine: a
   back-side rule is one token, and path-scoped overrides, a wizard and a preview
   would be the kind of overcomplication cut before. It is a field in `settings_json`.

4. **Pattern grammar: `{name}` plus literal text**, matched against the file stem,
   case-insensitively, extension ignored. `{name}_b`, `{name}_back`, `back_{name}`.
   The placeholder form (rather than a bare suffix) gives prefix patterns for free and
   reads like `{author}/{title}`. Literal text only; no wildcards.

5. **Presets:** *Epson FastFoto* (`{name}_b`, which also brings the `_a` twin rule
   below) and *Named back* (`{name}_back`, `{name}-back`, `{name}.back`). Plus
   *Custom patterns*, a list the user types. Enabled rows are tried in the order shown.

6. **Epson twin rule.** A `_b` attaches to the plain stem if that file exists,
   otherwise to `_a`. When a front that has a back is deleted (Delete, duplicate
   cleanup, replace-larger sweep) and its twin (`X` or `X_a`) is still an item in the
   same folder, the back is **handed over** to the twin instead of going to the trash
   with the front. No file is renamed; the column moves. Restoring the deleted front
   from the bin does not take the back from the twin.

7. **A candidate is a back only when** the same folder holds a photo with that stem,
   both are photos (never video or audio), and the front is not itself a back. Anything
   else stays an ordinary photo. Two candidates for one front: the first in pattern
   order wins, the rest stay ordinary photos.

8. **Default: off for existing libraries.** Nothing moves to the Recycle Bin behind
   anyone's back. The library wizard offers the card for a new gallery library. A
   **Check this library** button counts, from names alone, what a rescan would pair
   and how many existing photos it would bin, before anything is saved.

9. **The rule governs discovery only.** Pairs already recorded stay paired when the
   rule is turned off, and a file recorded as a back is never catalogued as a photo of
   its own, rule or no rule. Turning the rule off never doubles anything.

10. **Pairing an existing item on rescan is automatic and reversible through the
    bin.** Its row goes to the Recycle Bin with a new `TrashSource`
    (`back_side`, shown as "Paired as back side"), its tags, faces, albums and notes
    kept on the row. **Restore is Split**: the file is renamed to `<stem> (back).<ext>`,
    deliberately not a recognised form, and the row comes back as a photo.

11. **Explicit actions write in the library's own dialect**: the library's first
    enabled pattern names the file (`_b` in an Epson library). With no rule enabled
    they write `{name}_back` and still record the pair, so the actions work in every
    library.

12. **Rotation is per side.** `back_rotation` 0/90/180/270, baked into the back's
    preview exactly as `rotation` is into the front's, preserved across rescans.

13. **Viewing**: the front everywhere; a corner mark on the tile; **Flip** in the
    lightbox (a stage button, tap on the phone, keyboard `B` — `F` is taken by Like),
    in Review mode beside the When and Where pickers, and on the guest share page.
    A plain crossfade, no 3D card animation. Download gives the side being looked at.

14. **A "Written on the back" field** on the details panel, separate from the
    description, plain text, searchable, fillable by dictation in Review mode.
    (Open question 3 asks whether the owner wants it; the decision is that if it
    exists it is its own column, not a convention inside Description.)

15. **Faces and the duplicate scan never look at backs.** The back has no dHash, no
    content hash, no faces. The Inbox check compares fronts only.

16. **No "pair from the Inbox" special case.** The Inbox is a gallery library with a
    role, so it gets the same Scanning card and the same rule. Keep moves the pair into
    the destination as a recorded pair, whatever that library's rule says, and the file
    keeps its name.

## The rule on the Scanning tab

Below the scan sources table, a **Back sides** section (mock above):

- Heading and hint: "A print scanned on both sides stays one photo: the back is kept
  with the front and shown with Flip, not catalogued as a photo of its own. Files are
  paired by name, in the order below."
- A table in the scan-sources style, three rows with checkboxes and reorder arrows:
  - **Epson FastFoto** · Preset · `{name}_b` is the back. When the enhanced copy
    `{name}_a` is kept instead of the original, the back follows it.
  - **Named back** · Preset · `{name}_back`, `{name}-back` or `{name}.back`.
  - **Custom patterns** · chips plus an "Add pattern" input; hint: `{name}` stands for
    the front's file name; everything else is matched as written, ignoring case.
- A line: "Pairs already recorded stay paired if you turn this off. A back added from
  a photo is named with the first pattern: `{name}_b`."
- **Check this library** → an info `MessageBox`: "18 backs would pair on the next
  rescan", with three lines: files matching with a front beside them; how many of
  those are catalogued as photos today and would move to the Recycle Bin as "Paired as
  back side"; files matching a pattern with no front (they stay ordinary photos).
- The same section appears in the library wizard for a gallery library, under its
  Scanning tab. Search terms go in `features/control/search-index.ts`; the card gets an
  `anchor`.

Stored shape (`settings_json`):

```json
"back_sides": {
  "presets": ["epson"],
  "custom": ["{name}_verso"],
  "order": ["epson", "named", "custom"]
}
```

Validation: a custom pattern must contain `{name}` exactly once, be 2–64 characters,
and contain no path separators or characters `uniqueGalleryFileName` strips. Patterns
are compared as lower-case literals; `{name}` is the stem of the front.

## Scanning

The walk (`walkGalleryFiles`) already collects every file before ingesting. Pairing is
one pass over that list, per directory, before anything is catalogued:

1. For each file, test the stem against the enabled patterns in order. A match yields
   a candidate front stem.
2. The candidate is a back if the same directory holds a photo with that stem (plain
   stem first; for the Epson preset, then `_a`), both are photos, and the front is not
   itself a back. Otherwise the file is an ordinary photo.
3. Backs are removed from the item list and handed to the front's ingest.

`ingestGalleryAsset` records `back_relative_path`, `back_size`, `back_modified_at`,
renders `back_preview_storage_key` through `renderInTurn()` (never alongside the
front's render — see the two-pipeline rule in `CLAUDE.md`), and preserves
`back_rotation` the way it preserves `rotation`. A changed back (size or mtime) is
re-rendered; an unchanged one is skipped.

Reconcile gains three outcomes:

- **Back file gone, front present**: the front's back columns clear and the back
  preview is swept. The front stays.
- **Front gone, back present**: the back no longer matches anything and is catalogued
  as an ordinary photo. Nothing is lost.
- **An existing item now matches as a back** (renamed on disk, or an Epson library
  with `_b` items when the rule is first enabled): the file attaches to the front, the
  row is soft-deleted with source `back_side`.

A file recorded as some front's back is skipped by the walk even when the rule no
longer matches it (decision 9). The single-file path (`scanSingleGalleryFile`) gets the
same check: asked to catalogue a back, it attaches to the sibling front and returns the
front's id; asked to catalogue a front, it picks up a back already beside it.

Folder rescans work unchanged, since pairing is per directory.

## Uploads

The batch is paired by name before placing, with the same matcher. A back follows its
front: same dated folder, and if the collision rule renames the front to `X (2).jpg`
the back becomes `X (2)_b.jpg`. The front is placed first, the back second, then one
`scanSingleGalleryFile` of the front catalogues both. A back whose front is not in the
batch is filed as an ordinary photo (no safe way to guess which existing item it
belongs to). Drop links reuse the helper, so a guest can send both sides. Since the
Epson files carry no EXIF, the three files of a print land in the same folder by upload
time anyway.

## Explicit actions

- **Add the back** — lightbox ⋮ menu and details panel; one file, or the camera on the
  phone (`capture="environment"`). Written beside the front under the library's first
  pattern; the front is re-scanned. An existing back moves to `replaced/` first, the
  rule Replace follows, so no only copy is overwritten.
- **Replace the back** — same route, same `replaced/` rule.
- **Remove the back** — file to the Recycle Bin's file area, columns cleared. Confirmed
  (`Remove the back of "X"?`, consequence stated, "Remove back").
- **Rotate the back** — the same two buttons as the front, shown while flipped.
- **Use as back side** — grid selection of exactly two photos from one library; a
  dialog asks which is the front. The other's file moves beside it (the `move.ts`
  mechanics) and is renamed; its row goes to the bin with source `back_side`. The
  confirm lists what that photo carries (people, tags, albums, notes), since those stay
  out of sight until a restore.
- **Split** — restore from the Recycle Bin (decision 10), also offered on the details
  panel as "Split off the back".

## Viewing

- **Tile**: a small folded-corner mark (bottom-right) when a back exists. No second
  thumbnail anywhere in the grid.
- **Lightbox**: a Flip button on the stage; `B`; tap on the phone. The stage crossfades
  to the back's preview at the back's rotation. The rotate buttons act on the shown
  side. Download gives the shown side. The slideshow never flips.
- **Review mode**: Flip beside the When and Where pickers, since the back is what the
  reviewer reads to answer them. Dictation can fill "Written on the back".
- **Share page**: the same Flip; the share's file routes gain a `?side=back`.
- **Details panel**: "Back side" row with Add / Replace / Remove / Split off, and the
  "Written on the back" field.

## What must carry the companion

Every path that moves, copies or deletes the front's file: `move.ts` (Inbox Keep,
move to folder), `replace.ts` (Replace keeps the back), Delete and the Recycle Bin
(trash and restore move both files; purge removes both), `folder-move.ts`,
`storage-move.ts`, `library-delete.ts`, the duplicate cleanup's `job-replace.ts`
(replace and replace-larger: the back follows the surviving item, decision 6), backups
(file-level, nothing to do), the family tree package export/import (must include the
back file and the back columns), and `thumbnail-audit.ts` (the back preview is a
known key).

## Data model

Next migration, all on `gallery_details`:

| Column | Meaning |
| --- | --- |
| `back_relative_path` | Library-relative path of the back file; NULL = none. |
| `back_rotation` | 0/90/180/270, user-owned, never written by the scan UPSERT. |
| `back_size`, `back_modified_at` | Change detection for re-rendering the preview. |
| `back_preview_storage_key` | The back's preview thumbnail. |
| `back_text` | "Written on the back", plain text, manual only. |

`TrashSource` gains `back_side`. `settings_json` gains `back_sides` (above). The
API's `GalleryAsset` gains `back: { previewUrl, fileUrl, rotation, width, height } | null`
and `backText`; the list query only needs a boolean `hasBack` for the tile mark.

Routes under `/api/library/gallery/assets/:id/back`: `PUT` (add/replace, multipart),
`DELETE` (remove), `POST …/rotate`, `POST …/split`, `GET …/file` and `…/preview`.
`POST /api/library/gallery/assets/pair` `{ frontId, backId }`.
`POST /api/library/gallery-libraries/:id/back-sides/check` returns the counts for the
Scanning tab.

## Test fixture

The owner's FastFoto folder is the fixture (copied, personal content excluded from the
repo — a synthetic set with the same names and three small JPEGs serves the test). The
scanner test walks it with the Epson preset and asserts: 30 items, 18 with a back, no
item for any `_b` file; delete a raw front and the back moves to the `_a` twin; rename
a `_b` away and it becomes a photo; disable the preset and rescan and nothing doubles.
The upload test posts `X.jpg` + `X_b.jpg` and asserts one item with a back in one
folder; posts `X_b.jpg` alone and asserts an ordinary photo.

## Phases

1. **Rule, scanner, uploads, data model, lightbox Flip and rotate, tile mark, Add /
   Replace / Remove, carry-along in move / replace / trash / cleanup.** Ships the
   Epson case end to end.
2. **Use as back side, Split, Review mode Flip, share page Flip, "Written on the
   back", family tree package, wizard card, guides** (`docs/users/library-gallery.md`
   section with a shot), scanner.md section.
3. **Swap sides** and anything the first two phases turn up.

## Phase 1 as built (2026-10-14)

- **Data**: migration 84 (`back_relative_path`, `back_rotation`, `back_size`,
  `back_modified_at`, `back_preview_storage_key`, `back_text` on `gallery_details`;
  `trashed_items.back_path`). `settings_json.back_sides` is
  `{ sources: [{id, enabled}…], patterns: [] }` with ids `epson` / `named` /
  `custom`, normalised in `library-settings.ts`; the API field is `backSides`.
- **Rule and matcher**: `gallery/back-sides.ts` (pure); scanner pairing, ingest,
  reconcile and the single-file path in `scanner.ts`; the dry run is
  `checkBackSides` behind `POST /api/library/gallery-libraries/:id/back-sides/check`.
- **Deviation from decision 10**: a photo that becomes a back is NOT a Recycle Bin
  row. Its row stays as the scanner's ordinary soft-deleted tombstone, kept out of
  the Missing photos list and purge (`cleanup.ts`), and **Split off the back**
  (lightbox ⋮) renames the file and revives that row, metadata and all. The bin
  would have needed a row whose files are not in the bin; the tombstone gives the
  same reversibility with no new bin state. The Recycle Bin page does not list
  paired-away photos; the dry run says how many there would be.
- **Hand-over** (decision 6) is `backSidesForTrash` in `gallery/back-side-files.ts`,
  called through the media-type hook `companionsForTrash` from `trashBook`. The
  twin's preview renders on its next ingest; until then the lightbox shows the file
  (`mapAsset` falls back to `/back/file`). Restore seeds the pair before the scan
  (`seedRestoredCompanion`).
- **Routes** (`gallery/back-routes.ts`): `POST …/assets/:id/back` (add or replace;
  POST rather than PUT, since the shared uploader posts), `DELETE …/back`,
  `POST …/back/rotate`, `POST …/back/split`, `GET …/back/file`. A removed or
  replaced back goes to `replaced/` (the Replace rule, `setAsideReplaced`).
- **Uploads**: `pairUploadedBackSides` / `placeBackSideBeside` in `files.ts`, used
  by the upload route and drop links.
- **Web**: `GalleryAsset.back` / `backText`; tile corner mark; lightbox Flip pill on
  the stage, `B` key, rotate acts on the shown side; ⋮ gains Add / Replace / Split
  off / Remove the back; `GalleryBackSideModal`; Scanning-tab card
  `BackSidesEditor` in the edit dialog (with the dry run) and the wizard; search
  index entry; strings in both locales.
- **Not in phase 1**: camera capture on the phone (the shared uploader has no
  capture mode yet), Review mode Flip, the share page, "Written on the back"
  (column exists, no UI), the user guide, `docs/scanner.md`.
- Tests: `test/gallery-back-sides.test.ts` (matcher, settings) and
  `test/gallery-back-sides-scan.test.ts` (Epson folder end to end, dry run,
  retire + Split, twin hand-over, bin round trip, move, by-hand actions, lone back).

## Phase 2 as built (2026-10-14)

- **"Written on the back"**: `backText` on the asset edit route (`edit.ts`),
  searched with the title and caption (`catalog.ts`); a section on the lightbox
  Details tab with its own small editor; a "What is written on the back?" card in
  Review mode, shown for a print that has a back or already has words. No OCR,
  no dictation wiring (the note dialog's dictation is for the memory, not the
  inscription).
- **Review mode Flip**: a chip at the foot of the photo; the back at its own
  rotation. No rotate in Review mode (it never had one).
- **Share page**: a single-photo share says `hasBack`; `GET /api/share/:token/file?side=back`
  serves the back, metadata-stripped like the front; the guest page has a Flip
  under the picture. Set and album shares show fronts only.
- **Lightbox File tab**: a "Back side" row with Add / Replace, Split off, Remove.
- **Family tree package**: a photo's back travels as `media/photos/<id>_back.<ext>`
  (`backFile`, `backRotation`, `backText` on the photo record, all optional);
  import pairs it beside the front under the house library's naming and restores
  the turn and the words.
- Guide: "Scanned on both sides" in `docs/users/library-gallery.md` (no screenshot
  yet); `docs/scanner.md` §8 and a "Back sides" note.
- **Not built**: Swap sides; camera capture on the phone; a "Paired as back side"
  listing in the Recycle Bin (decision 10's deviation stands).

## Open questions

1. Should the Named back preset be **on by default for new gallery libraries**, or
   should every new library start with the card off as existing ones do?
2. When "Use as back side" demotes a photo that has **confirmed people**, should the
   dialog refuse until the faces are cleared, or just warn? (Leaning: warn and list;
   the row survives in the bin.)
3. Does the owner want **"Written on the back"** as a field, or is the image enough?
   The column is cheap; the Review mode wiring is the real cost.
4. A back added from the **phone camera** is a photograph of a print, not a scan: should
   it get a hint about glare and squareness, or is that for the guide?

## How it ends

A print is one photo. The grid shows its face; a corner mark says there is more; Flip
shows the back, the right way up, wherever someone looks closely. An Epson folder
pairs itself when its library's rule is on; nothing is lost when the rule is off, when
a twin is cleaned up, or when a pairing was wrong.
