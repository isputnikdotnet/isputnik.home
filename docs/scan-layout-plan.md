# Scan layout plan

Status: agreed design, not started. Supersedes the open questions in
[`custom-scan-rules-proposal.md`](custom-scan-rules-proposal.md); the current
scanner behaviour is documented in [`scanner.md`](scanner.md).

Design mocks (private links, kept for reference while building):

- Layout panel with the default row: https://claude.ai/code/artifact/5582b4aa-4917-4e51-938f-c10d472a837d
- Wizard step 1, Folders: https://claude.ai/code/artifact/8e188a9e-0f7d-4b00-b381-60433f0eb1cc
- Wizard step 2, Layout: https://claude.ai/code/artifact/eef1b614-f5ac-43df-89a1-41a276b08471
- Wizard step 3, Preview: https://claude.ai/code/artifact/24ffeeb0-58e3-456f-bdd3-ee5791fbfcf3

## Why

Ebook and audiobook libraries answer the same three questions with different
controls, and one of the questions is hidden:

1. **How are books arranged on disk?** Audiobooks answer with two "metadata
   source" toggles (`folder_structure`, `single_file`) that secretly change
   grouping and parse names with a fixed `Author - Title [Narrator]` pattern,
   plus an undocumented "parent folder is the author" guess. Ebooks answer with
   scan rules, which only the ebook scanner consults.
2. **Which folders are exceptions?** Ebooks: scan rules. Audiobooks: nothing.
3. **Where do details come from?** Both: the ordered `scan_sources` list, which
   for audiobooks also holds the two grouping toggles from question 1.

The rule engine, schema (`library_scan_rules`, `library_scan_rule_paths`,
`library_items.scan_rule_id`), routes and modal are already type-neutral and
already know `{narrator}`. Only the audiobook scanner half is missing. The
plan integrates it, extends the engine for the cases in
`D:\ProjectTesting\iSputnik_scan_rules_challenging_cases.md`, and rebuilds the
interface around the three questions above.

## Decisions

- **One concept, "layout".** A layout is an ordered list of patterns tried in
  order; the first that fits a book key wins. This replaces "optional folder
  level" and "optional section" as the user-facing idea. `[...]` optional
  sections exist in the text grammar only, as sugar that expands into two
  patterns.
- **The default layout is a rule anchored at the library root** (`paths = [""]`,
  which `resolveOwner` already treats as the least specific owner). At most one
  root rule per library; it cannot be deleted from the panel, only edited. A
  library without a root rule keeps today's scanner behaviour.
- **Captured fields win.** Inside a rule, a value the pattern captures beats the
  same field from tags or OPF, as the ebook scanner does today. Fields the
  pattern omits fall through to the library's sources per field. The audiobook
  "parent folder is the author" guess is suppressed inside any rule.
- **Audiobook book boundary = the directory at the pattern's depth.** Every
  audio file beneath it, in any subfolder, is a track of that book (the
  `top_level_folder` gathering, applied at the matched directory). Disc ordering
  keeps using `discNumberFromFolderName` then numeric path order.
- **Unmatched paths inside a rule are still catalogued**, with no path-derived
  fields, exactly as today. They are counted and shown, never dropped.
- **Sources stop changing grouping for new libraries.** `folder_structure` and
  `single_file` stay functional for existing libraries and are hidden from the
  library wizard once a root rule can express them. No automatic migration of
  existing toggles into rules.
- **Naming.** The admin-facing word is "Layout" (panel title "Layout · Ebooks";
  wand icon shown for both types). "Scan rule" stays in code and API paths.
- **Deferred:** one book in several series (A5), an any-depth `**` wildcard,
  round-tripping hand-edited pattern text back into builder labels beyond the
  cases where the text still matches the example.

## Target model

```
library
├─ default layout  = rule with paths [""]          (0 or 1)
├─ rules           = rule with paths [folder, …]   (0..n, nested allowed)
│    ├─ layouts    = [pattern, pattern, …]         (ordered, ≥ 1)
│    └─ enabled
└─ sources         = scan_sources (+ tag encoding)  unchanged, metadata only
```

Ownership resolution is unchanged: most specific enabled rule folder wins; a
disabled most-specific folder falls to the default scanner (which, with a root
rule, is that rule).

## Engine (`shared/scan-rule-pattern.ts`)

| Change | Detail |
| --- | --- |
| `matchLayouts(patterns, key)` | Returns `{ matched, layoutIndex, fields }`. Tries patterns in order. Depth semantics per pattern are unchanged. |
| Optional sections | `[...]` in a pattern expands to the with-section and without-section variants, with-section first. Nested brackets rejected. `validatePattern` reports the expanded set's errors once. |
| Tokens `{year}`, `{publisher}` | Map to `item_metadata.year_published` / `publisher`. `{year}` must parse as a 4-digit number or is dropped with a warning, like `{position}`. |
| Author name form | A captured author of the form `Last, First` is normalised to `First Last` before alias resolution, so E4 files alias to the same person as tags do. One comma, no further heuristics. |
| Validation | Duplicate real role across the expanded pattern set; `{narrator}` only for audiobooks; `{position}` without `{series}` is a warning surfaced by preview, not an error. |

Tests (`scan-rule-pattern.test.ts`): E1 optional series, E2 two-depth fallback,
E3 series-first with trailing author, E4 skip trailing publisher and capture
year, E5 numeric folder skipped, adjacent-token rejection, `Last, First`
normalisation.

## Data model

- `library_scan_rules.layouts_json TEXT NOT NULL DEFAULT '[]'` holds the
  ordered pattern list. **Migration 63** adds the column and backfills
  `[pattern]` from the existing `pattern` column. `pattern` stays as a mirror of
  the first layout (kept in sync on write) so nothing breaks mid-transition; it
  is removed in a later cleanup once no reader is left. New tables would
  auto-apply from `schema.sql`, but this is a new column on an existing table,
  so it needs the migration entry (see the migrations 25 and 58 note: no index
  on a migrated column in `schema.sql`).
- No new column on `library_items`. "Which layout matched" and "fits no layout"
  are recomputed by running the matcher over the rule's items' `folder_path`
  values; rules are small and the matcher is pure.
- Root-rule uniqueness is enforced in `createScanRule`/`updateScanRule`, not in
  the schema, alongside the existing same-folder conflict check.

## Server

### Rule persistence and API (`shared/scan-rules.ts`, `scan-rules-routes.ts`)

- `ScanRule` gains `layouts: string[]`; `pattern` remains in responses as
  `layouts[0]` for the current modal until it is replaced.
- `POST`/`PATCH` accept `layouts`; a body with only `pattern` is still accepted
  and stored as a one-layout list.
- `GET …/scan-rules` returns, per rule: `books` (items with that
  `scan_rule_id`, not deleted), `unmatched` (those whose key fits no layout),
  `missingFolders` (rule paths that no longer exist on disk),
  `lastScannedAt` (new nullable column, set by rule-scoped and full scans).
- `GET …/folders` gains `books` per folder (count of non-deleted items whose
  `folder_path` is under it) and `ownedBy: { ruleId, name, enabled } | null`,
  so the Folders step can draw counts and lock badges without extra calls.
- `PUT …/libraries/:id/default-layout { layouts }` creates or updates the root
  rule; `DELETE` on the root rule is refused with a message.
- `POST …/scan-rules/:ruleId/scan` enqueues a rule-scoped scan: the job
  payload carries `ruleId`; the scanner walks only that rule's folders and
  reconciles only `scan_rule_id = ruleId`. Both scanners.
- `POST …/scan-rules/preview` takes `{ folders, layouts }` and returns rows
  `{ path, layoutIndex | null, author, series, position, title, narrator,
  formats | tracks, warnings[], change }` where `change` is one of
  `moves-from-default`, `moves-from-rule:<id>`, `merges:<n>`, `unchanged`,
  `added-without-fields`, computed from today's `library_items` for the same
  paths. Warnings: duplicate `(series, position)` inside the previewed set,
  non-numeric position or year, position without series. It dispatches on
  library type to `previewEbookRulePattern` or the new audiobook preview.

### Ebook scanner (`ebook/scanner.ts`)

- `matchPattern(rule.pattern, …)` → `matchLayouts(rule.layouts, …)` in the
  full scan, `scanSingleEbookFile` and the preview.
- `ingestEbookGroup` persists `year` and `publisher` from fields when present
  (it already writes `year_published` and has a `publisher` column available).
- Nothing else changes; reconcile per owner already exists.

### Audiobook scanner (`audiobook/scanner.ts`)

1. **Partition in the walk.** `walkAudiobookFiles` takes the library's rules.
   For each audio file it resolves the owner of the file's directory path. A
   file under an enabled rule is grouped by the book directory
   `anchor + first N segments`, where N is the depth of the first layout whose
   depth the path can satisfy (layouts are tried at their own depth; the first
   that matches the candidate key wins, and a path deeper than every layout is
   grouped at the deepest layout's depth and reported unmatched if none match).
   Files under no rule keep today's `groupingMode` logic. The map value carries
   `{ ruleId, layoutIndex, fields }` alongside the files.
2. **Gather beneath the book directory.** `readBookFolderFiles` receives a
   `gatherAll` flag for rule-owned books, behaving as `top_level_folder` does
   today (recurse into every subfolder), so A2 and A3 become one book each.
3. **Ingest.** `prepareBookScan` receives the owner. Inside a rule:
   `authorHint` is null; a `path_pattern` candidate holding the captured
   fields is merged first; series and position captured by the pattern go
   through the existing `upsertSeries` + `series_items` path with
   `source = 'scan'`, respecting `series_source = 'manual'`. `writeBookScan`
   writes `scan_rule_id`.
4. **Reconcile per owner.** The soft-delete block at the end of
   `scanAudiobookLibrary` becomes owner-scoped like `reconcileOwnedItems`:
   default scan touches `scan_rule_id IS NULL`, each rule its own id, and a
   rule-scoped job touches only its rule.
5. **Single-book rescan.** `rescanSingleBook` resolves the owner from the
   item's `folder_path` and applies its layouts, so restore-from-bin and
   metadata reset stay inside the rule.
6. **Preview.** `previewAudiobookRulePattern(libraryId, folders, layouts)`
   walks directories under each anchor, applies the same boundary logic, and
   returns book rows with track counts and the `change` classification
   (a rule-owned book whose directory today holds several catalogued books is
   `merges:<n>`).

Tests (`audiobook-scan-rules.test.ts`, temp-dir fixtures): A1 series-first
with author from tags, A2 twenty files one book, A3 Part folders one book with
correct track order, A4 two narrators two books, rule-scoped reconcile does not
touch default items, `rescanSingleBook` keeps `scan_rule_id`, preview reports
the A3 merge.

## Web

### Layout panel (replaces the list view of `ScanRulesModal`)

Opened from the Libraries table wand for ebook **and** audiobook libraries.
Sections, as in the mock:

- **Default layout row**, pinned: layout in words (`humanize(pattern)`, "+1
  more"), book count, "N fit no layout" pill, last scan, Edit layout / Preview
  / Rescan. When no root rule exists: "scanner defaults" pill, a per-type
  sentence describing today's behaviour, and "Set up layout".
- **Rules for specific folders**: name, layout, folder chips (struck through
  when missing), counts, on/off switch, Preview / Scan these folders / Edit /
  Delete. Nested rules indent under their parent with a one-line note.
  Off rules dim and say which folders the default covers meanwhile.
- **Details come from** strip: the library's sources, read-only, linking to
  library settings.
- Delete goes through `shared/ConfirmDialog` (`Delete rule "X"?`, books stay,
  re-read by the default layout on next scan, confirm label "Delete rule").

### Wizard (`AddScanRuleWizard`, three steps, also used for edit and for the default layout)

1. **Folders.** Checkbox tree rooted at the library with a "Whole library"
   node. Folders owned by an enabled rule are locked with the rule name;
   children stay selectable and show "takes over from …". Ticking a parent
   drops ticked descendants. Find box. Selection summary with counts and
   ownership notes. Editing the default layout skips this step.
2. **Layout.** Rule name (auto-named until edited). Preset chips per type that
   fill the selected layout. A list of layout cards, each with an example
   picker (representative paths by depth and leaf shape), the labelled path
   (role select per piece, separators as join buttons, double-click to split),
   a Book folder select for audiobooks with the greyed tail and track count,
   inline warnings, "Reads as" line and live "matches N of M". Unmatched panel
   with "Add a layout for these". Collapsed "Pattern (advanced)" with the text
   form; edits there re-label the builder when the text still matches the
   example, otherwise the card shows text only.
3. **Preview.** Four tiles (recognized, fit no layout, warnings, boundaries
   change) doubling as filters, notices only for decisions (boundary rebuilds,
   duplicate positions, "saving does not scan"), per-layout filter chips, the
   table with role-tinted values and "from file" placeholders, a Change column,
   and Save / Save and scan these folders.

Shared pieces: `LayoutBuilder` (pieces, roles, join/split, pattern
generation and best-effort parsing), `humanizePattern`, role colour tokens
(author blue, series mint, position gold, title rose, narrator amber) reused
by the preview table.

Conventions: `shared/Modal` panel variant, `shared/Button` variants,
`shared/MessageBox` for notices, strings in `controlAdmin.json` with the
Russian mirror, `npm run check:ui` clean. Roles and presets are data, so the
builder needs no per-type branches beyond the narrator role and the boundary
control.

### Library wizard and settings

- New libraries: a "How are your books arranged?" step (wizard step 2 with the
  folder fixed to root, plus a scanner-defaults choice) that creates the root
  rule on save. The two grouping toggles are not shown for new libraries.
- Existing libraries keep their toggles in settings. A library with
  `folder_structure` or `single_file` enabled and no root rule shows that in
  the default row's sentence.
- The rescan options dialog opens for ebook libraries too (sources only).

## Phases

| Phase | Deliverable | Ships alone? |
| --- | --- | --- |
| 1 Engine + model | `matchLayouts`, optional sections, `{year}`/`{publisher}`, name normalisation; `layouts_json` + migration 63; ebook scanner and API on layouts; rule list counts; folders endpoint counts and owners. Current modal keeps working via `pattern`. | Yes, invisible to users except E1/E2 now possible in the text field. |
| 2 Audiobooks | Walk partition, boundary gathering, ingest and reconcile per owner, single-book rescan, audiobook preview, rule-scoped scan job for both types. Wand shown for audiobooks; "ebook only" notice removed. | Yes. |
| 3 Interface | Layout panel, three-step wizard, builder, preview; docs update in `docs/users/library-ebooks.md` and `library-audiobooks.md` (the wand is a "Layout" now); `docs/scanner.md` §5 and §10 rewritten. | Yes; replaces `ScanRulesModal`. |
| 4 Policy | Default layout in the library wizard, toggles hidden for new libraries, ebook rescan dialog, cleanup of the `pattern` mirror column. | Yes. |

Each phase ends with `npm run typecheck`, `npm run check:ui`, `npm test`, and a
release note in `status.ts` `versionUpdates`.

## Risks

- **Boundary changes destroy attached data** (A3 today is two books). The
  preview's `merges:<n>` classification and the tile are the guard; the panel's
  "Save and scan" runs a rule-scoped scan so the blast radius is the rule's
  folders.
- **Audiobook walk concurrency.** `walkAudiobookFiles` walks with
  `Promise.all`; owner resolution per file is a synchronous SQLite read. Load
  the rule paths once per scan and resolve in memory (a small helper beside
  `resolveOwner` that takes the preloaded rows) rather than querying per file.
- **Folder renames orphan rule paths.** Surfaced as "folder not found" on the
  row and in the Folders step; no automatic repair.
- **Name normalisation false positives.** Only `Last, First` with exactly one
  comma is rewritten; multi-author strings with commas are left to the
  existing splitter.
