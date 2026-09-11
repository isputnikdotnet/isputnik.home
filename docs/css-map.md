# CSS Map — iSputnik.home

All styles are imported by [`apps/web/src/styles.css`](../apps/web/src/styles.css), in this order:

```
tokens → base → auth → layout → components → home → player → audio →
library-browse → gallery → review → family-tree → library-collections →
stories → book-detail → category-images → book-media → ebook-reader →
metadata-modal → person-edit → admin → scan-layout → welcome → duplicates →
about → share → social → filter → install → offline → theme-picker → responsive
```

The one exception is Leaflet: `leaflet.css` and the marker-cluster stylesheets are
imported by the map components that use them (`GalleryMap`, `StoryMap`, the
dashboard's `LocationsMap`, …), not here.

### Stylesheet inventory

| Stylesheet | Purpose |
|---|---|
| `tokens.css` | Design tokens — colours for the five themes (`dark`, `light`, `plain-dark`, `plain-light`, `minimalist`) via `data-theme` |
| `base.css` | Global resets and typography |
| `auth.css` | Sign-in / invite split-screen (pre-auth), device-link screens, and the `--auth-*` token set per theme |
| `layout.css` | Main column, avatar, work area, scene backgrounds, control-panel grid and tab row |
| `components.css` | Shared UI — fields, buttons, message boxes, modals, datagrid, badges. A barrel over `components/` (see below) |
| `home.css` | Home — resume hero + the ranked card feed — and the app shell every signed-in page wears: left sidebar, menus, mobile tab bar (`home-*`) |
| `player.css` | Audio player widget and its popup/chapter sheet |
| `audio.css` | The shared recorder and wave player (photo voice notes, story narration — [`lightbox-panel.md`](lightbox-panel.md)) |
| `library-browse.css` | Main audiobook catalog / landing + shared browse toolbar (split from `library.css`) |
| `gallery.css` | Photo/video timeline + folder grid and the full-screen lightbox |
| `review.css` | Review mode — one photo, its questions, full screen ([`photo-review-plan.md`](photo-review-plan.md)) |
| `family-tree.css` | People grid, person profile, pickers, and the SVG chart |
| `library-collections.css` | Category, series & people pages (split from `library.css`) |
| `stories.css` | Stories — index, reading view, editor, and the block surfaces they share (the largest stylesheet) |
| `book-detail.css` | Audiobook book detail + tags (split from `library.css`) |
| `category-images.css` | Category icon/image for admin + browse cards (split from `library.css`) |
| `book-media.css` | Book files, companion documents, in-app reader (split from `library.css`) |
| `ebook-reader.css` | Immersive EPUB reader (foliate-js) — full-screen, own light/sepia/dark theme |
| `metadata-modal.css` | Metadata lookup modal + cover-picker tab (split from `library.css`) |
| `person-edit.css` | Person edit dialog and its photo box (`PersonProfileModal`) |
| `admin.css` | Control panel pages — Dashboard, Logs, Security, Storage, Backup, Scheduled jobs, Recycle Bin, … — except the duplicate ones |
| `scan-layout.css` | Scan layouts — the Layout panel and the scan-rule wizard ([`scan-layout-plan.md`](scan-layout-plan.md)) |
| `welcome.css` | The first-run setup guide (`/welcome`) |
| `duplicates.css` | Duplicate cleanup (split from `admin.css`). A barrel over `duplicates/` (see below) |
| `about.css` | About page and version timeline; Profile's tabs (password, email, appearance, shared links, passkeys, two-factor); Help & guides |
| `share.css` | Public guest share page (no app shell), the in-app share modal, and the Photo Inbox drop page |
| `social.css` | Family sharing — the Send to sheet, the For you rows, the unseen dot |
| `filter.css` | Filter button + popup + active-filter chips for the browse pages |
| `install.css` | PWA install page / prompt |
| `offline.css` | Offline / downloaded-books UI |
| `theme-picker.css` | Theme picker page (theme selection grid), plus the Email and Notifications settings forms |
| `responsive.css` | Breakpoint overrides for the older shared pages (see the last section) |

### The two barrels

`components.css` and `duplicates.css` were the largest files here (3,708 and 2,791
lines). Each is now a list of `@import`s over a folder of topic files. The
filename and its position in the order above are unchanged, nothing moved between
parts, and the parts are imported in their original order — so the concatenated
cascade is exactly what it was. That matters because order decides the winner
between two rules of equal specificity, and `responsive.css` has to stay last.

**Add a rule to the part it belongs to. A new part goes at the END of its barrel**
unless it genuinely has to out-rank something above it.

| `components/` | Contents |
|---|---|
| `primitives.css` | Form field, progress ring, buttons, toggle, select menu, choice group, message box, modals |
| `layout.css` | Section/layout helpers, row-action groups, search field, invite box |
| `admin-pages.css` | Unified Libraries page, the Members tables (`.user-table`, `.invite-table`, `.group-table`), profile page header, shared admin-page chrome |
| `library-wizard.css` | Create-library wizard — step rail, per-step panels, footer |
| `member-access.css` | Public/private banner, grant-access row, members-with-access list |
| `upload.css` | Upload size cards, `shared/FileUpload` dropzone, library scan/upload editors |
| `data-display.css` | Datagrid, status & count badges, people combobox, suggest input, media-kind badge, control-panel search palette |
| `shared-rules.css` | Declaration blocks many features wrote out identically, now written once with every selector that wore them: a cover-fill `img`, one-line truncation, a wrapping control row, and the Logs / Recycle bin / Duplicate photos toolbar and pager. Add a selector only when its whole block matches — and moving a rule here moves it earlier in the cascade |

`duplicates/` mirrors `features/control/sections/duplicates/`, where the markup
already lives in nine files:

| `duplicates/` | Component |
|---|---|
| `photos.css` | The Duplicate photos page |
| `cleanup-panel.css` | `DuplicateCleanupSection` |
| `job-card.css` | `CleanupJobCard` |
| `folder-compare.css` | `FolderCompare` |
| `certainty.css` | `CertaintyBadge` |
| `result-card.css` | `CleanupResultCard` |
| `wizard.css` | `CleanupWizard` |
| `viewer.css` | Filters box + `DuplicateViewer` |

### Selectors declared in more than one file

Ten top-level selectors are declared in two files, so which one wins depends on the
import order above:

| Selector | Files (the later one wins a tie) |
|---|---|
| `.audio-player` | `player.css`, then `audio.css` — the book player's card look depends on the shared-audio file |
| `.icon-button` | `components/primitives.css`, then `components/layout.css` |
| `.home-user-icon` | `home.css`, then `social.css` (adds `position: relative` for the unseen dot) |
| `:root` and `:root[data-theme="…"]` ×5 | `tokens.css`, then `auth.css` (its own `--auth-*` variables, per theme) |
| `:root:is([data-theme="dark"], [data-theme="light"])` | `home.css`, `player.css` — the Sputnik-look overrides for those two themes |

> **Coverage:** the detailed per-class sections below were written for the original
> foundational stylesheets (`tokens`, `base`, `auth`, `layout`, `components`,
> `player`, `admin`, `about`, `responsive`) and pruned to the classes that still
> exist. The feature stylesheets added since — `home`, `audio`, the files split out
> of the old `library.css`, `gallery`, `review`, `family-tree`, `stories`,
> `person-edit`, `scan-layout`, `welcome`, `duplicates`, `ebook-reader`, `share`,
> `social`, `filter`, `install`, `offline`, `theme-picker` — are inventoried above
> but not enumerated class-by-class.

---

## tokens.css
**Design tokens — colours and theming**

CSS custom properties used everywhere else. Five themes — `dark`, `light`,
`plain-dark`, `plain-light` and `minimalist` — each a `:root[data-theme="…"]`
block; `:root` with no attribute gets the dark palette. The app stamps the chosen
theme on `<html>` (a new install defaults to `minimalist`), and a user's **System**
choice is resolved to light or dark in JavaScript — there is no
`prefers-color-scheme` in the CSS. The `plain-*` and `minimalist` themes also hide
the scene background images (`layout.css`).

| Token | Role |
|---|---|
| `--canvas` / `--surface` / `--surface-raised` / `--field` | Background layers (page → card → raised card → input) |
| `--ink` / `--muted` | Text colors (full → subdued) |
| `--line` | Borders and dividers |
| `--hover` / `--active` | Interactive state fills |
| `--mint` | Primary accent — active states, badges, player controls (the name is historical: it is red-orange in `dark`, near-black in `minimalist`) |
| `--gold` | Primary button, avatar background, highlights |
| `--amber` / `--rose` / `--blue` | Semantic accents (warning, danger/error, info) |
| `--success` / `--warning` / `--danger` | Status colours |
| `--icon-control-border` / `-border-hover` / `-focus-ring` / `-bg` / `-bg-hover` | Icon-button chrome |
| `--shadow` | Box shadows |

Derived once on `:root` for all five themes, from the palette above (so a scope
that restates `--ink`, like the lightbox's dialogs, restates `--surface-2` too):

| Token | Role |
|---|---|
| `--surface-2` | A quiet fill a shade off its surface — placeholder thumbnails, tracks, inset panels, a row's hover (`--ink` at 6%) |
| `--accent` | `--mint` — focus outlines, the selected item |
| `--error` | `--danger` |

### Stacking (`--z-*`)

`#root` is `isolation: isolate` (`components/primitives.css`), so the whole page is
one layer and anything portalled into `<body>` — dialogs, menus, toasts, viewers —
paints over all page chrome whatever its z-index. The scale orders page chrome
against itself inside `#root`, and the `<body>` layers against each other:

| Token | Value | For |
|---|---|---|
| `--z-dropdown` | 12 | A menu or popover opening inside a component |
| `--z-sticky` | 20 | Sticky / pinned page chrome (selection toolbar, story site bar) |
| `--z-popover` | 30 | Floating panels over page content (combobox lists, hint panels, emoji picker) |
| `--z-nav` | 60 | The mobile tab bar; its sheets sit just under it (`calc(var(--z-nav) - 1)`) |
| `--z-modal` | 100 | `shared/Modal`'s backdrop |
| `--z-viewer` | 1000 | Lightbox, ebook reader, document and share viewers |
| `--z-menu` | 1050 | Menus portalled to `<body>` (ActionMenu, LibraryMenu, SortMenu) — over the dialog or viewer they open from |
| `--z-toast` | 1100 | Toasts and banners — over an open photo or book too |
| `--z-tooltip` | 1200 | Tooltips |

A dialog opened from inside a viewer renders inside it, so it needs no rank above
it. Values below 10 order siblings inside one component and stay literal.

---

## base.css
**Global resets and typography**

Applies to every page.

- `*` — `box-sizing: border-box`
- `body` — font stack (Inter), base color/background from tokens, `line-height: 1.45`
- `button`, `input`, `select` — font inheritance
- `h1` / `h2` — fluid sizing and spacing
- `.sr-only` — visually hidden (screen-reader only)
- `.muted` — muted text color utility

---

## auth.css
**Sign-in / invite page**

The full-screen split layout shown before the user is authenticated.

| Class | What it styles |
|---|---|
| `.app-shell` | Two-column full-viewport page grid (hero left, panel right). Has the space-gradient background. |
| `.auth-scene` | Absolute container behind everything for decorative SVG elements |
| `.auth-hero` | Left column — big display heading (`SPUTNIK`) |
| `.auth-orbit` / `.auth-orbit-b/c` | Decorative elliptical orbit rings (CSS borders, rotated) |
| `.auth-node-a/b/c` | Glowing dots drifting along the orbits (animated) |
| `@keyframes auth-drift` | Subtle float animation on the orbit nodes |
| `.auth-panel` | Right column — frosted-glass sign-in card |
| `.brand-row` | Logo + app name inside the panel |
| `.stack` | Vertical form field stack inside the panel |
| `.eyebrow` | Small mint uppercase label above headings |

Light-theme overrides are inlined with `:root[data-theme="light"]` selectors.

Responsive collapses to single-column (hero hidden) at ≤740 px — see `responsive.css`.

---

## layout.css
**The main column and page structure**

Applies once the user is signed in. The shell around it — the left sidebar, the
user and About menus, the mobile tab bar — is drawn by `home.css` (`.home-sidebar`,
`.home-primary-nav`, `.home-user-menu`, `.home-mobile-nav`, …), since it grew out of
the Home redesign.

### Content areas
| Class | What it styles |
|---|---|
| `.dashboard-main` | The scroll area beside the sidebar |
| `.work-area` | Padded content wrapper, max-width 1040 px |
| `.avatar` / `.avatar.large` | Circular avatar with gold background |
| `.scene-page` | Page wrapper that supports a background scene image |
| `.scene-page::before` | Full-bleed background image (space illustrations) |
| `.scene-page::after` | Gradient overlay that fades the image into the canvas color |
| `.sputnik-scene` / `.control-scene` | Each sets a different background image for its page |

### Control panel
| Class | What it styles |
|---|---|
| `.control-panel` | Two-column grid: 208 px left nav + content |
| `.control-tabs` | The page's one row of tabs (links or buttons; active tab underlined in `--mint`) |
| `.control-work` | Content area to the right, max-width 1040 px |

---

## components.css
**Shared UI components used across all pages**

### Form fields
`.field` — label + input/select/textarea wrapper with 7 px gap and muted label. Focus ring uses `--mint`.

### Buttons
| Class | Appearance |
|---|---|
| `.primary-button` | Gold fill, dark text, 48 px tall — main calls-to-action |
| `.secondary-button` | Transparent with border — secondary actions |
| `.danger-button` | Red fill — destructive actions |
| `.text-button` | No background — inline/link-style, rose color for danger variant |
| `.icon-button` | Square icon button |
| `.compact-button` | Shorter height variant (42 px) |

All buttons share `border: 0; cursor: pointer` via a shared rule. Disabled states use `cursor: wait` or `cursor: not-allowed`.

### Message boxes
`.message-box` with variants `.info`, `.warning`, `.error`, `.success` — icon + text alert banners used for feedback throughout the app.

### Modals
| Class | What it styles |
|---|---|
| `.modal-backdrop` | Fixed full-screen dimmed overlay (`--z-modal`) |
| `.confirm-modal` | Small centered confirmation dialog (max 420 px) |
| `.create-invite-modal` / `.create-library-modal` / `.create-storage-modal` / `.edit-thumbnail-modal` | Wider task-specific modals |
| `.modal-header` / `.modal-close` | Modal title bar and ✕ button |
| `.modal-tabs` / `.modal-tab` / `.modal-tab-content` | Tabbed content inside modals (e.g. metadata editor) |
| `.modal-actions` | Right-aligned button row at the bottom of a modal |

These style `shared/Modal` and `shared/ConfirmDialog`; never write the markup by hand
([`UI-CONVENTIONS.md`](UI-CONVENTIONS.md)).

### Layout helpers
- `.section-head` — flex row: heading left, action button right
- `.empty-state` — centered dashed-border placeholder (image + message)

### Search field
`.search-field` — icon-prefixed input, max 520 px wide.

### Invite components
`.invite-box` — input + copy-button row. `.created-invite` — bordered card showing a newly created invite link.

### Datagrid (table)
`.datagrid-wrap` / `.datagrid` — styled `<table>` with rounded border, uppercase small headers, hover rows. `.datagrid-primary` / `.datagrid-muted` — cell content helpers.

### Status & count badges
| Class | What it styles |
|---|---|
| `.status-badge` | Pill badge with a colored dot; variants: `.idle` (mint), `.scanning` (gold), `.error` (rose) |
| `.count-badge` | Small round number badge (mint on active bg) |

---

## player.css
**Audio player widget**

Used on the Audiobook detail / playback page.

| Class | What it styles |
|---|---|
| `.audio-player` | Card container — grid, surface bg, rounded corners (`audio.css` also declares it; see above) |
| `.player-chapter` | Current chapter row — chapter badge + truncated title |
| `.player-chapter-index` | Mint pill with chapter number |
| `.player-controls` | Centered row of transport buttons |
| `.player-btn` | Circular transport button (42 px); `.player-btn-primary` is larger (52 px) in gold |
| `.player-btn-skip` | Pill-shaped skip-forward/back button with seconds label |
| `.player-seek` | Time code left + range slider center + time code right |
| `.player-seekbar` | Range input styled with `--mint` accent and custom thumb |
| `.player-aux` | Bottom row — volume control + speed selector |
| `.player-vol` / `.player-vol-icon` / `.player-vol-slider` | Volume knob area |
| `.player-speed` / `.player-speed-btn` / `.player-speed-menu` / `.player-speed-option` | Playback speed dropdown (popover above button, `--z-dropdown`) |
| `.player-book-progress` / `.player-book-bar` / `.player-book-bar-fill` | Thin overall-book progress bar |
| `.player-chapter-list` / `.player-chapter-item` | Scrollable chapter list (max 260 px); active/complete states |
| `.player-chapter-item-num` / `.player-chapter-item-title` / `.player-chapter-item-dur` | Chapter row sub-elements |

---

## library-browse.css / book-detail.css / book-media.css / metadata-modal.css
**Audiobook library, book detail, metadata editor, and cover picker**

> The original `library.css` was split into the files above (plus `library-collections.css` and `category-images.css`). The class groups below still apply, now spread across those files.

### Library browser / audiobook grid
| Class | What it styles |
|---|---|
| `.audiobook-toolbar` | Filter + count row above the grid |
| `.library-filter` | Genre/filter dropdown select |
| `.audiobook-grid` | `auto-fill` 164 px column grid of book cards |
| `.audiobook-card` | Individual book card (cover + text) |
| `.audiobook-cover` | Square cover image/placeholder with gradient fallback |
| `.audiobook-card-body` | Title, author, duration text below the cover |

### Book detail page
| Class | What it styles |
|---|---|
| `.book-detail-head` | Two-column (200 px cover + info) header area |
| `.book-detail-cover` | 2:3 portrait cover image placeholder |
| `.book-detail-info` | Title, author, metadata table, action buttons |
| `.book-description` | Longer description paragraph |
| `.book-detail-actions` | Flex row of action buttons (Play, Download …) |
| `.book-files-section` | File list section |
| `.book-file-list` / `.book-file-row` | Individual chapter/file rows |

### Metadata modal
Large tabbed modal for editing book metadata and searching external sources.

| Class | What it styles |
|---|---|
| `.metadata-modal` | Fixed-size modal (max 840×680 px) with header/tabs/content rows |
| `.metadata-search-row` | Three-column row: source selector + search input + button |
| `.metadata-edit-grid` | 4-column field grid for editing metadata fields |
| `.metadata-field-half` / `.metadata-field-wide` | Span helpers for the edit grid |
| `.metadata-results` / `.metadata-result-card` | Search result rows (thumbnail + title/author + apply button) |
| `.metadata-result-cover` | 2:3 thumbnail in result cards |
| `.metadata-apply-controls` | "Apply to all" checkbox area |
| `.metadata-actions` | Footer button row |

### Cover picker tab (inside metadata modal)
| Class | What it styles |
|---|---|
| `.cover-tab-layout` | Two-column: current cover preview + candidate grid |
| `.cover-current-preview` | Displays the current cover image |
| `.cover-candidate-grid` / `.cover-candidate` | Auto-fill grid of cover candidates from search results |
| `.cover-upload-panel` | "Upload from file" button that hides a real `<input type="file">` |

---

## admin.css
**Control panel pages**

Most of this file is page-prefixed and reads for itself — `.kpi-card`,
`.range-picker`, `.signins-scope-*` and `.locations-map` (Dashboard), `.blocked-table`,
`.trusted-table` and `.protection-*` (Security), `.app-storage-*` and
`.storage-contents-*` (Storage), `.backup-*` (Backup), `.scheduled-job-*`, `.quote-import-*`.
The groups below are the older ones.

### Library settings
| Class | What it styles |
|---|---|
| `.library-settings-panel` | Settings row: name, path summary, save actions |
| `.setting-status` | Inline "ready" / "needs attention" indicator |

### Storage management (`/control/libraries/storage`)
`.storage-section` / `.storage-section-head` / `.storage-path-cell` / `.storage-path-summary` — scan-root / storage path management UI.

### Logs (`/control/overview/logs`)
| Class | What it styles |
|---|---|
| `.log-toolbar` / `.log-toolbar-controls` | Filter bar above the table |
| `.log-search` | Search input + clear button |
| `.log-retention-field` | The "delete entries older than" days input |
| `.log-table` / `.log-table-wrap` | Horizontally scrollable log table |
| `.log-event-cell` / `.event-category` | Event category chip; colors per category (`.cat-auth`, `.cat-invite`, `.cat-library` …) |
| `.event-action` | Action name text in log rows |
| `.log-pager-row` | Pagination row under the table |

### Recycle Bin (`/control/maintenance/recycle-bin`)
| Class | What it styles |
|---|---|
| `.trash-status` | What the bin holds — items, space, files |
| `.trash-bins` | Where the files are on disk, one folder per library |
| `.trash-retention` / `.trash-retention-row` | The two retention windows: the bin's own, and duplicate cleanup's |
| `.trash-toolbar` / `.trash-toolbar-controls` | Library + source filters left, sort and page size right |
| `.trash-grid` / `.trash-tile` | Tile per deleted item |
| `.trash-thumb` | The cover kept when the item was deleted (4:3, icon fallback) |
| `.trash-tile-name` / `.trash-tile-line` / `.trash-tile-actions` | Tile contents: name, detail lines, restore + delete |

### Missing photos (`/control/utilities/missing-photos`)
`.missing-retention-row` — auto-purge window input. `.missing-thumb` — last-known thumbnail. `.missing-path` — wrapping relative path.

### Profile (shared with the about page)
| Class | What it styles |
|---|---|
| `.profile-area` / `.profile-form` | Profile editing card (name, email, password) |
| `.profile-heading` | Avatar + name/email row at the top of the form |

---

## about.css
**About page and version history**

| Class | What it styles |
|---|---|
| `.about-panel` | Content width container (max 680 px) |
| `.about-heading` | App icon + name/codename row |
| `.about-icon-wrap` | Rounded square icon placeholder |
| `.about-code-name` | Gold release codename below the app name |
| `.about-version-badge` | Mint pill showing current version number |
| `.about-description` | Muted description paragraph |
| `.about-stack` | 2-column grid of tech stack items |
| `.about-stack-item` / `.about-stack-label` / `.about-stack-value` | Individual stack card (e.g. "Runtime → Node 22") |
| `.version-updates` / `.version-timeline` | Changelog section — vertical timeline |
| `.version-update` / `.version-update-dot` | Single release entry with a dot on the timeline line |
| `.version-update-current` | Highlights the current version (mint dot + ink text) |
| `.version-update-head` | Version number + release label row |
| `.version-update-list` | Bullet list of changes for a release |

The rest of the file is Profile's tabs (`.profile-tab`, `.device-row`, `.security-*`,
`.shared-link*`, `.opds-*`) and Help & guides (`.help-*`, `.guide-body`).

---

## responsive.css
**Breakpoint overrides for the older shared pages**

Most mobile rules no longer live here. The desktop browser is the baseline, and each
feature file carries its own `@media (max-width: 740px)` block for its own classes —
43 such blocks across 18 files, only one of them in this file. 740 px is the one
mobile breakpoint — its complement is `min-width: 741px`, never a smaller
`min-width` that would switch desktop rules on inside the mobile band. What `responsive.css`
still holds is the older shared pages' overrides, and it stays last so they win:

| Breakpoint | What changes |
|---|---|
| `≤ 1240 px` | The Members users table drops its Created column |
| `741–1040 px` (tablet) | The users table drops Sessions too and hides the row avatar; the auth page adjusts column proportions and hero size |
| `≤ 740 px` (mobile) | Auth page collapses to a single column (hero hidden); the Members, Libraries and Logs tables and toolbars reflow; book detail, collection and category pages stack |
| `741 px+ and viewport height ≤ 780 px` (short landscape) | Auth page scrolls vertically instead of fitting the viewport |
| `≤ 430 px` (small mobile) | Auth panel padding tightens; the libraries, users, invites and groups tables each drop another column; the log search and pager take full lines; About stack collapses to 1 column |
