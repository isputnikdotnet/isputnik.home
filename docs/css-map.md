# CSS Map — iSputnik.home

All styles are imported by [`apps/web/src/styles.css`](../apps/web/src/styles.css), in this order:

```
tokens → base → auth → layout → components → home → player →
library-browse → library-collections → book-detail → category-images →
book-media → ebook-reader → metadata-modal → admin → about →
share → filter → install → offline → theme-picker → responsive
```

### Stylesheet inventory

| Stylesheet | Purpose |
|---|---|
| `tokens.css` | Design tokens — colors and theming (`dark`/`light` via `data-theme`) |
| `base.css` | Global resets and typography |
| `auth.css` | Login / register split-screen (pre-auth) |
| `layout.css` | App shell — header, sidebar rail, page grid, Control Center panel |
| `components.css` | Shared UI — fields, buttons, message boxes, modals, datagrid, badges |
| `home.css` | Home dashboard — Continue / Recently added feeds |
| `player.css` | Audio player widget |
| `library-browse.css` | Main audiobook catalog / landing + shared browse toolbar (split from `library.css`) |
| `library-collections.css` | Category, series & people pages (split from `library.css`) |
| `book-detail.css` | Audiobook book detail + tags (split from `library.css`) |
| `category-images.css` | Category icon/image for admin + browse cards (split from `library.css`) |
| `book-media.css` | Book files, companion documents, in-app reader (split from `library.css`) |
| `ebook-reader.css` | Immersive EPUB reader (foliate-js) — full-screen, own light/sepia/dark theme |
| `metadata-modal.css` | Metadata lookup modal + cover-picker tab (split from `library.css`) |
| `admin.css` | Control Center — all admin/management pages |
| `about.css` | About page and version timeline |
| `share.css` | Public guest share page (no app shell) |
| `filter.css` | Filter button + popup + active-filter chips for the audiobook grid |
| `install.css` | PWA install page / prompt |
| `offline.css` | Offline / downloaded-books UI |
| `theme-picker.css` | Theme picker page (theme selection grid) |
| `responsive.css` | Media-query overrides (no new classes) |

> **Coverage:** the detailed per-class sections below were written for the original
> foundational stylesheets (`tokens`, `base`, `auth`, `layout`, `components`,
> `player`, `admin`, `about`, `responsive`). The feature stylesheets added since —
> `home`, the files split out of the old `library.css`, `ebook-reader`, `share`,
> `filter`, `install`, `offline`, `theme-picker` — are inventoried above but not yet
> enumerated class-by-class.

---

## tokens.css
**Design tokens — colors and theming**

CSS custom properties used everywhere else. Two themes: `dark` (default) and `light`, toggled via `data-theme` on `:root`.

| Token | Role |
|---|---|
| `--canvas` / `--surface` / `--surface-raised` / `--field` | Background layers (page → card → raised card → input) |
| `--ink` / `--muted` | Text colors (full → subdued) |
| `--line` | Borders and dividers |
| `--hover` / `--active` | Interactive state fills |
| `--mint` | Primary accent — active states, badges, player controls |
| `--gold` | Primary button, avatar background, highlights |
| `--amber` / `--rose` / `--blue` | Semantic accents (warning, danger/error, info) |
| `--success` | Success variant of `--mint` |
| `--shadow` | Box shadows |

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
- `.truncate` — single-line ellipsis utility

---

## auth.css
**Login / register page**

The full-screen split layout shown before the user is authenticated.

| Class | What it styles |
|---|---|
| `.app-shell` | Two-column full-viewport page grid (hero left, panel right). Has the space-gradient background. |
| `.auth-scene` | Absolute container behind everything for decorative SVG elements |
| `.auth-hero` | Left column — big display heading (`SPUTNIK`) |
| `.auth-orbit` / `.auth-orbit-b/c` | Decorative elliptical orbit rings (CSS borders, rotated) |
| `.auth-node-a/b/c` | Glowing dots drifting along the orbits (animated) |
| `@keyframes auth-drift` | Subtle float animation on the orbit nodes |
| `.auth-panel` | Right column — frosted-glass login/register card |
| `.brand-row` | Logo + app name inside the panel |
| `.stack` | Vertical form field stack inside the panel |
| `.eyebrow` | Small mint uppercase label above headings |

Light-theme overrides are inlined with `:root[data-theme="light"]` selectors.

Responsive collapses to single-column (hero hidden) at ≤740 px — see `responsive.css`.

---

## layout.css
**Main app shell — header, sidebar, page structure**

Applies once the user is logged in.

### Top-level grid
| Class | What it styles |
|---|---|
| `.dashboard` | Two-row grid: 68 px header + remaining content |
| `.dashboard-body` | Two-column grid: 72 px sidebar rail + main area |
| `.dashboard-body.control-body` | Overrides to single column (Control Center has its own left nav) |

### Header
| Class | What it styles |
|---|---|
| `.app-header` | Sticky top bar (68 px), frosted glass, z-index 5 |
| `.app-brand` | Logo + app name link on the left |
| `.header-actions` | Right side of the header (buttons, user button) |
| `.header-button` | Square icon button in header (44×44 px) |
| `.user-button` | User name + avatar pill button |
| `.avatar` / `.avatar.large` | Circular avatar with gold background |

### Sidebar rail
| Class | What it styles |
|---|---|
| `.sidebar` | Sticky left nav rail (72 px wide, full height below header) |
| `.side-nav` | Stacked icon buttons for main navigation |
| `.side-nav button` / `.logout-button` | 48×48 px icon buttons; active state uses `--mint` |
| `.rail-foot` | Bottom of the rail — theme switcher + version number |
| `.version` | Tiny version label at the very bottom of the rail |

### Content areas
| Class | What it styles |
|---|---|
| `.dashboard-main` | Scroll area to the right of the sidebar |
| `.work-area` | Padded content wrapper, max-width 1040 px |
| `.scene-page` | Page wrapper that supports a background scene image |
| `.scene-page::before` | Full-bleed background image (space illustrations) |
| `.scene-page::after` | Gradient overlay that fades the image into the canvas color |
| `.rocket-scene` / `.sputnik-scene` / `.cosmonaut-scene` / `.control-center-scene` / `.audiobook-scene` / `.audiobook-book-scene` | Each sets a different background image for its page |

### Control Center panel (admin sub-navigation)
| Class | What it styles |
|---|---|
| `.control-panel` | Two-column grid: 208 px left nav + content |
| `.control-nav` | Left nav container |
| `.control-links` | Stacked link list |
| `.control-group` | Named group of links with an uppercase label |
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
| `.icon-button` | Square icon button with label support (`.with-label`) |
| `.compact-button` / `.pager-button` | Height variants: 42 px / 38 px |

All buttons share `border: 0; cursor: pointer` via a shared rule. Disabled states use `cursor: wait` or `cursor: not-allowed`.

### Message boxes
`.message-box` with variants `.info`, `.warning`, `.error`, `.success` — icon + text alert banners used for feedback throughout the app.

### Modals
| Class | What it styles |
|---|---|
| `.modal-backdrop` | Fixed full-screen dimmed overlay (z-index 20) |
| `.confirm-modal` | Small centered confirmation dialog (max 420 px) |
| `.create-invite-modal` / `.create-library-modal` / `.create-storage-modal` / `.edit-thumbnail-modal` | Wider task-specific modals |
| `.modal-header` / `.modal-close` | Modal title bar and ✕ button |
| `.modal-tabs` / `.modal-tab` / `.modal-tab-content` | Tabbed content inside modals (e.g. metadata editor) |
| `.modal-actions` | Right-aligned button row at the bottom of a modal |

### Layout helpers
- `.section-head` — flex row: heading left, action button right
- `.empty-state` — centered dashed-border placeholder (image + message)

### Search field
`.search-field` — icon-prefixed input, max 520 px wide.

### Invite components
`.invite-box` — input + copy-button row. `.created-invite` — bordered card showing a newly created invite link.

### Datagrid (table)
`.datagrid-wrap` / `.datagrid` — styled `<table>` with rounded border, uppercase small headers, hover rows. `.datagrid-primary` / `.datagrid-secondary` / `.datagrid-muted` — cell content helpers.

### Status & count badges
| Class | What it styles |
|---|---|
| `.status-badge` | Pill badge with a colored dot; variants: `.idle` (mint), `.scanning` (gold), `.error` (rose) |
| `.count-badge` / `.book-files-count` | Small round number badge (mint on active bg) |
| `.invite-status` | Invite state pill; variants: `.active`, `.expired`, `.used` |

---

## player.css
**Audio player widget**

Used on the Audiobook detail / playback page.

| Class | What it styles |
|---|---|
| `.audio-player` | Card container — grid, surface bg, rounded corners |
| `.player-chapter` | Current chapter row — chapter badge + truncated title |
| `.player-chapter-index` | Mint pill with chapter number |
| `.player-controls` | Centered row of transport buttons |
| `.player-btn` | Circular transport button (42 px); `.player-btn-primary` is larger (52 px) in gold |
| `.player-btn-skip` | Pill-shaped skip-forward/back button with seconds label |
| `.player-seek` | Time code left + range slider center + time code right |
| `.player-seekbar` | Range input styled with `--mint` accent and custom thumb |
| `.player-aux` | Bottom row — volume control + speed selector |
| `.player-vol` / `.player-vol-icon` / `.player-vol-slider` | Volume knob area |
| `.player-speed` / `.player-speed-btn` / `.player-speed-menu` / `.player-speed-option` | Playback speed dropdown (popover above button, z-index 10) |
| `.player-book-progress` / `.player-book-bar` / `.player-book-bar-fill` | Thin overall-book progress bar |
| `.player-chapter-list` / `.player-chapter-item` | Scrollable chapter list (max 260 px); active/complete states |
| `.player-chapter-item-num` / `.player-chapter-item-title` / `.player-chapter-item-dur` | Chapter row sub-elements |
| `.player-chapter-progress` | Per-chapter mini progress bar |

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
| `.book-detail-meta` | Key-value metadata table (language, narrator, duration …) |
| `.book-description` | Longer description paragraph |
| `.book-detail-actions` | Flex row of action buttons (Play, Download …) |
| `.book-files-section` | Collapsible file list accordion |
| `.book-files-toggle` | Accordion toggle button |
| `.book-file-list` / `.book-file-row` | Individual chapter/file rows |

### Metadata modal
Large tabbed modal for editing book metadata and searching external sources.

| Class | What it styles |
|---|---|
| `.metadata-modal` | Fixed-size modal (max 840×680 px) with header/tabs/content rows |
| `.metadata-lookup-panel` | Search-source selector + query input area |
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
**Control Center — all admin/management pages**

### User management (`/control/users`)
`.user-list` / `.user-row` — card-based user list with name, email, role selector, and action button. `.role-select` — inline role dropdown. `.protected-badge` / `.current-badge` — small mint chips.

### Invite management (`/control/invites`)
`.invite-list` / `.invite-row` — four-column row: invite summary, status badge, dates, delete button. `.invite-link` — read-only token field + copy button visible when invite is active.

### Library management (`/control/libraries`)
| Class | What it styles |
|---|---|
| `.library-layout` | Two-column: library list left + detail panel right |
| `.library-list` / `.library-row` | Clickable library cards (name, path, book count) |
| `.library-detail` / `.library-detail-head` | Selected library detail card |
| `.book-list` / `.book-row` | Books inside the selected library |
| `.book-cover-placeholder` | Small 52×52 cover thumbnail |
| `.book-status` | Status pill on each book row |
| `.folder-browser` / `.folder-list` / `.folder-row` | Path picker widget used when assigning a storage path |
| `.library-settings-panel` | Three-column settings row: name, path summary, save actions |
| `.setting-status` | Inline "ready" / "needs attention" indicator |

### Storage management (`/control/storage`)
`.storage-section` / `.storage-section-head` / `.storage-path-cell` / `.storage-path-summary` — scan-root / storage path management UI.

### Session management (`/control/sessions`)
`.session-list` / `.session-row` — three-column rows: user info, session metadata (IP, UA, last seen), revoke button.

### Logs (`/control/logs`)
| Class | What it styles |
|---|---|
| `.log-controls` | Filter bar above the table |
| `.log-search` | Search input + clear button |
| `.log-page-size` | Page size selector |
| `.log-retention` | Retention-days input |
| `.log-table` / `.log-table-wrap` | Horizontally scrollable log table |
| `.log-event-cell` / `.event-category` | Event category chip; colors per category (`.cat-auth`, `.cat-invite`, `.cat-library` …) |
| `.event-action` | Action name text in log rows |
| `.log-pager` | Prev / page info / next pagination row |

### Status / health (`/control/status`)
`.health-line` / `.health-dot` — live service health indicator. `.status-grid` — 3-column metrics grid. `.status-metric` — individual metric card (label + large value).

### Profile & theme (shared with about page)
| Class | What it styles |
|---|---|
| `.profile-area` / `.profile-form` | Profile editing card (name, email, password) |
| `.profile-heading` | Avatar + name/email row at the top of the form |
| `.theme-switcher` | 3-button toggle: Dark / Light / System |

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

---

## responsive.css
**Media query overrides**

No new classes — only overrides for existing ones.

| Breakpoint | What changes |
|---|---|
| `≤ 740 px` (mobile) | Auth page collapses to single column (hero hidden). Standard app sidebar moves to a fixed bottom tab bar for Home, Media, Downloads, Collections, and Profile. Personal/library secondary navigation becomes an icon-only horizontal strip. Control Center nav stacks vertically. Audiobook grid switches to 3 fluid columns. Multi-column admin rows (users, invites, sessions) reflow to 1–2 columns. Status grid drops to 2 columns. Library layout stacks. |
| `741–1040 px` (tablet) | Auth page adjusts column proportions and reduces hero font size. |
| `741 px+ and viewport height ≤ 780 px` (short landscape) | Auth page scrolls vertically instead of fitting viewport. |
| `≤ 430 px` (small mobile) | Auth panel padding tightens. Theme switcher buttons stack vertically. Single-column for user rows, invite rows, session rows, and status grid. Log controls stack vertically. About stack collapses to 1 column. |
