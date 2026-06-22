# Custom Scan Rules Proposal

Status: design proposal; not implemented.

This document proposes path-scoped scanning rules for library folders whose
layout differs from the rest of the library. For the scanner's current behavior,
see [`scanner.md`](scanner.md).

The feature applies to both audiobook and ebook libraries. A rule inherits its
media type from its library; users do not select or mix media types within a
rule. Rule ownership, folder resolution, enable/disable behavior, preview, and
job handling are shared, while discovery and grouping remain type-specific.

## Goal

Every library continues to use its current scanner settings as the conceptual
default rule. A library may additionally own custom rules for exceptional
folders or collections of folders:

- A custom rule belongs to exactly one library.
- It may own one or multiple folders, but every assigned folder must be contained
  within that same library's `source_path`. A rule cannot reference folders from
  another library or paths outside its library source.
- The default scanner ignores the rule-owned folders.
- The custom rule is solely responsible for scanning and reconciling its owned
  folders.
- A rule can be enabled or disabled. When disabled, its folder assignments stay
  saved for later use, but the default scanner takes responsibility for those
  folders.
- Rule scopes may be nested. When more than one rule path contains the same
  content, only the rule with the most-specific matching path applies.
- Two rules cannot be assigned to the exact same folder. This keeps resolution
  deterministic without a user-managed numeric priority.

The proposal overlays the current scanner. It does not replace library-wide
scan extensions, metadata sources, tag encoding, metadata extraction, ingest,
or job processing.

## Management location and user flow

Rules are managed from a dedicated **Scan rules** tab on the individual library
page. There is no separate global rules management page in the initial design.
The tab lists only rules belonging to the open library and provides create,
edit, enable/disable, preview, scan, and delete actions.

Creating a rule follows this flow:

1. Select **Add rule** and give the rule a name.
2. Select one or more folders inside the library source.
3. Choose a built-in layout preset or enter a custom layout pattern.
4. Preview the rule against the selected folders.
5. Save the rule and scan only its assigned folders.

Because the tab belongs to one library, that library is fixed context rather
than a user-selectable field. The API and stored rule still carry `library_id`,
and the server must verify that every submitted folder belongs to that library.
The folder selector supports assigning multiple folders to the same rule and
must only browse beneath the current library's source path.

Creating or changing a rule re-derives metadata within its assigned scope while
preserving catalog identity. Items are keyed by their book key (the folder/group
path), so a rule that only changes derived fields (series, author, position)
keeps the same `library_items` rows — and with them reading progress, bookmarks,
shares, favourites, collections, and manual edits. New rows are created only when
a rule changes the book *boundary* (which files make up a book); that is the only
case that drops attached data, and the preview flags it so `ConfirmDialog` can
warn before it happens. Source files are never changed.

### Rule resolution

Multiple rules may be applicable because their assigned paths are nested. The
scanner resolves one effective owner for every path:

1. Find all rule-folder assignments that contain the path.
2. Select the assignment with the longest, most-specific relative path.
3. If that rule is enabled, it owns and scans the path.
4. If that rule is disabled, the default scanner owns the path. A broader custom
   rule does not take over through the disabled boundary.
5. If no assignment matches, the default scanner owns the path.

For example:

```text
Rule A: Collections/            (enabled)
Rule B: Collections/Box Sets/   (enabled)
```

Rule A scans the rest of `Collections/`, while Rule B scans `Box Sets/`. If Rule
B is disabled, the default scanner—not Rule A—scans `Box Sets/`.

There is no manual priority number. Path specificity is the priority, and the
same-folder uniqueness constraint prevents ties. A rule scan must also exclude
any nested partition won by a more-specific assignment.

### Enable and disable behavior

An enabled rule participates in full-library scans, owns the portions of its
assigned folders where it is the most-specific winner, and can be scanned by
itself. A disabled rule remains stored so its configuration and folder
assignments can be enabled again, but the default scanner owns the scope where
that disabled rule is the most-specific match:

- full-library scans allow the default scanner to enter and scan that scope;
- targeted scans for the rule are unavailable until it is enabled;
- enabling it again returns its effective scope to the custom rule and excludes
  that scope from the default walk.

Changing the enabled state changes which scanner owns the affected catalog
entries, but ownership transfer is an update, not a rebuild: the items keep their
identity (matched by book key) and only their `scan_rule_id` and derived metadata
change.

- disabling a rule hands its scope back to the default scanner, which re-derives
  the items in place;
- enabling a rule takes its scope over from the default scanner, re-deriving in
  place.

Because identity is preserved, progress, shares, and manual edits carry across a
toggle; a `ConfirmDialog` is only needed when the preview shows items whose book
boundary will actually change. Source files are never modified.

## Layout patterns and presets

A pattern describes a type-specific **book key** relative to each selected rule
folder:

| Library type | Book key matched by the pattern |
| --- | --- |
| Audiobook | Path to the directory that represents one book. Supported audio beneath that directory becomes the book's tracks. |
| Ebook | Path to a primary ebook file with its extension removed. Files with the same resulting path and different supported extensions remain one multi-format book. |

For example:

```text
Pattern: {author}/{series}/{position}. {title}
Book key: Isaac Asimov/Foundation/01. Foundation
Result:  author=Isaac Asimov, series=Foundation,
         position=1, title=Foundation
```

The example can match either an audiobook directory or ebook files such as
`01. Foundation.epub` and `01. Foundation.pdf`. For ebooks, the extension is
used as the document format but is not part of `{title}` or the grouping key.

Initial book-key tokens may include:

- `{author}`
- `{title}`
- `{series}`
- `{position}`
- `{narrator}` (audiobook only)
- `{ignore}`

Audiobook disc and track discovery can continue using the existing logic below
the matched book directory. Ebook format grouping can continue using the
existing same-stem logic after the custom pattern establishes the book key. The
grammar must be declarative and validated; it must not execute user JavaScript
or arbitrary server code.

Built-in presets should compile through the same pattern engine as custom
patterns. Initial presets could include:

- `{author}/{title}`
- `{author}/{series}/{position}. {title}`
- `{author} - {title} [{narrator}]`

Parsed layout values become a new rule-only `path_pattern` metadata candidate
for both library types. The rule editor places it in priority relative to the
library's applicable metadata sources. It is distinct from today's audiobook
`folder_structure` source, which has fixed parsing and also changes global
grouping. Grouping remains a separate rule decision: enabling or prioritizing a
metadata source must not implicitly change a custom rule's grouping boundary.

## Pattern grammar

A pattern is matched against a **book key** relative to each of the rule's
selected folders (the folder is the anchor; the pattern never reaches above it).
The grammar is declarative and validated at save time — no regular expressions or
user code.

### Structure

- A pattern is `/`-separated **segments**. Leading segments are folders; the
  final **leaf** segment is the book directory (audiobook) or the file basename
  with its extension removed (ebook).
- A path matches only when its depth below the anchor equals the pattern's
  segment count and every segment matches. Other paths are **unmatched** and
  reported in preview (the rule owns the folder but catalogs nothing there). For
  variable depth, anchor a deeper folder or add a second rule; an any-depth
  wildcard (`**`) is a deliberate future extension, not v1.
- Within a segment, text is a sequence of **literals** and **tokens** `{name}`.
  A token is non-greedy and bounded by the literal that follows it (or the
  segment edge); a token with no surrounding literal captures the whole segment.

### Tokens

| Token | Maps to | Notes |
| --- | --- | --- |
| `{author}` | author | alias-resolved like the scanners do |
| `{title}` | title | |
| `{series}` | series name | |
| `{position}` | series index | must parse as a number; `01` → 1, `2.5` allowed; non-numeric ⇒ warning, field dropped |
| `{narrator}` | narrator | audiobook only; rejected in ebook patterns at validation |
| `{ignore}` | (discarded) | consumes one segment or one literal-bounded run; use for "universe"/grouping folders |

All tokens are **optional**: the pattern's structure defines grouping, and any
field it omits falls through to the library's other metadata sources by the
existing per-field precedence. So `{title}` may be absent when `file_metadata`
supplies it.

### Matching rules

- Literal whitespace matches one or more whitespace characters; other literal
  characters match verbatim. There is no implicit ordinal stripping — `{title}`
  against `01. Foundation` yields `01. Foundation`; use `{position}. {title}` to
  split it.
- Captured values are trimmed and inner whitespace collapsed.
- A token bounded by a literal stops at the first occurrence of that literal.

### Validation (at save, before any scan)

Reject: unbalanced braces, unknown tokens, a duplicated token, `{narrator}` in an
ebook pattern, or any path traversal (`..`). Warn (save still allowed):
`{position}` without `{series}`, or a pattern that yields no title where no
higher-priority source supplies one (surfaced in preview).

### Examples

```text
{author}/{series}/{position}. {title}
  Isaac Asimov/Foundation/01. Foundation
  → author=Isaac Asimov, series=Foundation, position=1, title=Foundation

{ignore}/{series}/{position}. {title}        (skip a "universe" grouping folder)
  ВСЕЛЕННАЯ «ЗЕМЛИ ЛИШНИХ»/1. Земля лишних/1. Исход
  → series=Земля лишних, position=1, title=Исход

{series}/{position}. {title}                 (rule anchored at the author folder)
  Ар-Деко/2. Своя игра
  → series=Ар-Деко, position=2, title=Своя игра

{title}                                      (loose books at the anchor root)
  Вне закона
  → title=Вне закона   (standalone, no series)
```

### Test matrix (minimum)

- exact-depth match vs wrong-depth → unmatched;
- token bounded by a literal vs a whole-segment token;
- `{position}` integer, zero-padded, decimal, and non-numeric (warning);
- `{ignore}` skipping a single grouping level;
- ebook leaf with several extensions → one multi-format book; `{narrator}`
  rejected at validation;
- per-field precedence: pattern series fills a gap while an embedded title wins.

## Preview

Preview is a read-only dry run over actual paths. It must use the same discovery,
pattern compiler, and grouping functions as the saved scan so preview results
cannot drift from real scans.

At minimum, preview shows:

- the source path and resulting book boundary;
- extracted author, title, series, position, and narrator;
- audio files that will become tracks or ebook files that will become formats;
- unmatched or ignored paths;
- warnings for missing required values, duplicate books, and duplicate series
  positions.

Preview writes no catalog rows, thumbnails, or source files.

## Persistence and ownership

Rules should be first-class managed objects rather than opaque additions to
`libraries.settings_json`. They need folder assignments, validation, preview,
independent scan state, and targeted rescans. The proposed model is:

- `library_scan_rules`: library, name, enabled state, pattern or preset, and
  effective scan options;
- `library_scan_rule_paths`: normalized relative folders assigned to a rule,
  with exact-folder uniqueness enforced within a library;
- `library_items.scan_rule_id`: nullable ownership (`NULL` means the default
  scanner).

Exact columns remain an implementation decision. All paths are relative to the
library source and must pass the current containment and symlink safety checks.

Item ownership is required for safe reconciliation. Pruning custom folders from
the default filesystem walk is not sufficient by itself: the current
library-wide reconciliation would otherwise treat their catalog items as
vanished and soft-delete them.

## Scan execution

The scan coordinator builds a plan before walking files:

1. Load library defaults and all custom rules.
2. Validate every rule path and build non-overlapping ownership partitions using
   the most-specific-path resolution above.
3. Run the default scanner in partitions whose effective owner is the default,
   including disabled-rule partitions nested inside enabled rules.
4. Run each requested enabled custom rule in only the partitions it wins,
   excluding any more-specific nested assignments.
5. Ingest through the existing media-type pipeline using the rule's effective
   grouping and metadata configuration.
6. Reconcile only items owned by that scanner: default scans operate on
   `scan_rule_id IS NULL`; custom scans operate on their rule id.

A rule scan can therefore rebuild selected folders without walking the rest of
the library. A full library scan may run the default partition and every custom
partition as one coordinated job or as child jobs, but ownership and
reconciliation semantics remain the same.

## Relationship to the current scanner

The proposal preserves current behavior for unassigned paths:

- `settings_json.scan_sources` remains the library-wide default.
- Existing one-shot library and single-book rescan options remain available.
- Audiobook `folder_hierarchy` and `top_level_folder` grouping can be reused by
  presets where appropriate.
- Today, `folder_structure` controls both metadata parsing and whole-library
  grouping. That coupling can remain for the default scanner while custom rules
  use explicit grouping boundaries.
- Existing ingest, manual-metadata protection, cover handling, and file upserts
  remain downstream of discovery and grouping.

A rule that changes book boundaries must participate during discovery and
grouping, before `prepareBookScan` or `ingestEbookGroup` runs. Only metadata
derived from an already-established group belongs in the ingest pipeline.

Both audiobook and ebook rules are part of the initial feature. They share rule
management and path resolution but call their existing type-specific ingest
pipelines. Audiobooks group audio beneath a matched book directory; ebooks group
supported files that resolve to the same extension-free book key. Ebook rule
ingest must additionally persist author, series, and position extracted by
`path_pattern`; the current ebook scanner has no scan-derived series support,
so this is part of the ebook rule implementation rather than existing behavior.

## Open questions and review notes

Decisions to settle before implementation (recommended default in italics):

1. **Auto vs explicit.** This design is explicit-only — a tidy library gets no
   ebook series until a rule exists. *Leave room for an "Auto" inference default
   rule (folder/metadata heuristics) so common layouts need no setup, with custom
   rules as the exception; ship explicit rules first.*
2. **User data on rule change.** A rebuild discards ids, progress, shares, and
   manual metadata in scope, and a toggle is destructive — which also breaks the
   system-wide guarantee that `source='manual'` survives rescans. *Re-associate
   by book key when the book boundary is unchanged (most edits), preserve
   progress/shares across enable/disable, and keep honoring `source='manual'`
   inside rule scopes; full rebuild only on boundary changes.*
3. **Walk-time exclusion.** `walk*Files` have no concept of excluded subtrees
   today. The default walk must skip enabled-rule partitions yet descend into
   disabled-rule partitions nested inside them. This — not reconcile, which
   `scan_rule_id` already handles — is the main new engineering cost.
4. **Upload path.** `scanSingleEbookFile` must resolve rule ownership for the
   uploaded file's folder, apply that rule's pattern, and set `scan_rule_id`, or
   an upload into a rule scope becomes a default-owned item the next rule scan
   duplicates or reconciles away.
5. **Folder renames.** Rule paths are relative strings; reorganizing on disk
   orphans assignments. *Detect and surface "matches 0 folders" in the tab and
   preview.*
6. **`path_pattern` precedence.** *Apply per field (today's "index 0 wins per
   field") so a pattern's series can fill a gap while an embedded title still
   wins — this is what keeps mixed libraries correct.*
7. **Ownership transitions.** Adding a more-specific rule shrinks an existing
   rule's effective scope; that boundary change needs the same scoped rebuild as
   enable/disable.
8. **Full-scan job shape.** One coordinated job vs. a default job plus per-rule
   child jobs, given the single-claim worker. *Coordinated single job for v1.*

Suggested MVP slice to de-risk: `scan_rule_id` + the pattern engine + preview +
rule-scoped scan/reconcile for **single-folder, non-nested** rules, **without**
enable/disable rebuild. Add nesting and toggle-rebuild — the partition math and
data-loss exposure — once the core proves out.

## Initial non-goals

- Executing user-authored code or unrestricted regular expressions.
- Assigning two rules to the exact same folder or supporting manual numeric
  priorities.
- Mixing audiobook and ebook content within one rule.
