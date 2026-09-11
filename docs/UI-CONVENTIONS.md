# UI Conventions

This document defines how user-facing messages, buttons, modals, and confirmations
are built in the web app. The goal: every dialog, button, and error in the app looks
and behaves the same, and new code (human- or AI-written) has exactly one obvious way
to build each of them.

The standard rests on three layers:

1. **Shared primitives** in `apps/web/src/shared/` — the only way to render these elements.
2. **Written rules** (this file, summarized in `CLAUDE.md`) — so AI assistants follow them automatically.
3. **Mechanical enforcement** — `npm run check:ui` fails the build when code bypasses the primitives.

---

## Components

### Button — `shared/Button.tsx`

All buttons render through `<Button>` — outside `shared/` there is no raw
`<button>` left, and `check:ui` keeps it that way (see Enforcement). It defaults
to `type="button"`, so a click inside a form never submits it unless it says
`type="submit"`.

Two kinds of variant. The first five, plus `toolbar`, **own a look** — each maps
to one class, and visual changes go in the stylesheet, not the component:

| Variant | Class | Use for |
|---|---|---|
| `primary` | `primary-button` | The one affirmative action: Add, Save, Create, Done |
| `secondary` | `secondary-button` | Cancel, Close, Back, neutral actions |
| `danger` | `danger-button` | Filled destructive confirm (Delete) — mostly via ConfirmDialog |
| `text` | `text-button` | Low-emphasis inline action |
| `icon` | `icon-button` | Square icon-only button — must have `aria-label` or `title` |
| `toolbar` | `library-toolbar-button` | A browse toolbar control (Select, Upload, a page action). `className="primary"` for the toolbar's one primary action, `danger` for a destructive one |

The rest **name what the button is and carry no class of their own** — the look
is the `className` you pass (or the row that styles its buttons), untouched.
There is no one tile or chip class in the app; every surface drew its own, and
these keep them exactly as they were:

| Variant | Adds | Use for |
|---|---|---|
| `tab` | `role="tab"`, `aria-selected` and the `active` class from `selected`; Left/Right/Home/End walk the row | One tab of a `role="tablist"` row. In a dialog: `<div className="modal-tabs" role="tablist">` of `<Button variant="tab" className="modal-tab" selected={…}>`. A row that styles its own buttons (`.book-detail-tabs`) needs no class. A row that marks the chosen tab with a class of its own (`is-active`) passes that class and `aria-selected` instead of `selected` |
| `tile` | — | A card, cover or photo that is itself the click target (`gallery-tile`, `audiobook-card`, `cover-candidate`) |
| `chip` | — | A small pill: a filter, a tag, a suggestion (`review-chip`, `quote-filter`, `device-type-chip`) |
| `bare` | — | Custom chrome with nothing in common to share: the player's transport, the reader's toolbar, the lightbox's own buttons, a menu row its container styles |

Modifiers: `danger` (rose tint for destructive icon/text/secondary/toolbar
buttons; on the class-less variants it adds the plain `danger` class their rows
style), `compact` (42px height for toolbars/rows). Never hand-apply a variant's
class (`className="icon-button"`, `"compact-button"`) — use the prop; `check:ui`
fails on it.

A tab row is a real tablist: `role="tablist"` on the row, the `tab` variant on
each button. Marking the open tab only by its underline leaves a screen reader
with a row of identical buttons.

Icon-only control borders/backgrounds are centralized in
`apps/web/src/styles/tokens.css` as `--icon-control-*`. If a custom icon-only
surface is unavoidable (for example player or book-detail controls), reuse those
tokens instead of hard-coding a border.

```tsx
<Button variant="primary" type="submit" disabled={saving}>
  {saving ? "Saving…" : "Save changes"}
</Button>
<Button variant="icon" danger title="Delete backup" onClick={...}><Trash2 size={15} /></Button>
```

### PhotoPicker — `features/gallery/PhotoPicker.tsx`

Choosing gallery photos or videos from anywhere in the app goes through
`<PhotoPicker>` — one panel modal with Folders / People / Tags / All photos
tabs (plus Upload when a destination allows it), per-tab search, a
library-scope dropdown, and one selection that persists across all of them,
gathered in a removable-thumbnail tray. Multi mode posts `{ itemIds }` to the
`endpoint` you pass (albums, slideshows) or hands the selection to your
`onAttach` (the family tree); `pick="video"` / `pick="any"` are the
single-choice modes (slideshow clips, portraits). `facePerson` opens on People
with the linked person selected; `uploadTo` names the upload destination.
Never build a new photo-browsing dialog; extend this one.

### SelectMenu — `shared/SelectMenu.tsx`

Use `<SelectMenu>` for dropdown option sets that should look like app controls
rather than native browser selects. It owns the trigger, popover, selected check
mark, Escape/outside-click dismissal, ARIA roles, and option icon layout. Do not
hand-roll one-off dropdown buttons for filters or mode pickers.
Menu items are borderless rows with shared hover/active states, matching the
audiobook library selector.

```tsx
<SelectMenu
  value={typeFilter}
  label="Filter by library type"
  onChange={setTypeFilter}
  options={[
    { value: "all", label: "All", icon: <LayoutGrid size={18} /> },
    { value: "audiobook", label: "Audiobooks", icon: <Headphones size={18} /> },
    { value: "ebook", label: "Ebooks", icon: <BookOpen size={18} /> }
  ]}
/>
```

For **sorting**, use `shared/SortMenu` instead — see below. SelectMenu's popover
is anchored inside the page, which a browse toolbar clips.

### SelectField — `shared/SelectField.tsx`

The dropdown a **form** asks a question with: in a dialog or a settings page, in
the same column as the text fields around it. SelectMenu is the TOOLBAR control;
this is the field. Every dropdown inside a dialog goes through it, so they all
carry the same label, chrome, focus ring and disabled state.

It stays a native `<select>` on purpose — the platform's list is the one that
knows about touch, typeahead, a hundred options and the phone's picker wheel, and
every theme declares its own `color-scheme`, so that list already comes up in the
right one. What it adds is the part a bare select cannot have: a leading `icon`
saying what the field is FOR, since the text can only say what is chosen.

```tsx
<SelectField
  label="Library"
  icon={<Images size={17} />}
  value={libraryId}
  onChange={setLibraryId}
  options={libraries.map((library) => ({ value: library.id, label: library.name }))}
/>
```

Give it an icon when the field names a **kind of thing** the reader recognises by
its glyph — a library, a span of time, a person. Skip it for a plain list of
values; a decorative icon on every field is noise, and the icon never changes
with the selection.

Pass `compact` for a dropdown in a ROW of controls rather than a column of
fields — a unit beside a number, a sort next to a search box, a scope over a
grid — usually with `hideLabel`, since a row has no room for one. It sizes to its
own content at 38px tall. Every such row used to write its own height and
padding, and no two agreed.

The wrapper draws the border, background and focus ring; the select inside goes
bare, keeping a TRANSPARENT border. Neither is decoration. Padding on the select
cannot survive the cascade — panel dialogs set their own denser padding on
`.field select` at the same specificity, and where they won the icon landed on
top of the first letter. And a select with no border at all measures two pixels
short of the plain dropdown beside it wherever the height comes from content
rather than the min-height.

### SortMenu — `shared/SortMenu.tsx`

The one sort control across browse pages (Audiobooks, Ebooks, Authors, Narrators,
Series, Categories). Pass `compact` inside a toolbar and it renders as one 44px
icon square, with the chosen value in the title and accessible name
(`"Sort and index by: Last name"`).

Its menu is portalled to `<body>` and fixed-positioned, and hangs from the
trigger's right edge when a left-anchored menu would run off-screen. That is not
decoration: a toolbar scrolls sideways and clips its overflow, so a menu anchored
inside it gets cut off.

Each choice is a `menuitemradio` with `aria-checked` — a sort is one value out of
several, not a command. The keyboard follows the WAI-ARIA menu button: opening
moves focus to the current choice, Up/Down (wrapping) and Home/End walk the
items, Enter chooses, and Escape, Tab or a choice put focus back on the trigger.
That behaviour is `shared/useMenuKeyboard`, written for any menu whose open state
lives elsewhere (`useAnchoredMenu`'s); a new portalled menu should use it rather
than grow its own key handling.

### ChoiceGroup — `shared/ChoiceGroup.tsx`

Use `<ChoiceGroup>` when the user picks between **approaches**, not values — each
option needs a sentence of explanation, so it renders as a radio card with the
description inside the click target. (Picking a value from a list is SelectMenu's
job; a single on/off is ToggleSwitch's.) Options may be `disabled` with a `note`
saying why, which is how an unavailable choice stays visible instead of vanishing.

```tsx
<ChoiceGroup
  legend="How you'll get your codes"
  value={method}
  onChange={setMethod}
  options={[
    { value: "totp", label: "Authenticator app", description: "A rolling code from your phone. Works offline." },
    {
      value: "email",
      label: "Email",
      description: "A one-time code sent to you at each sign-in.",
      disabled: !emailAvailable,
      note: "Unavailable — this server can't send email."
    }
  ]}
/>
```

An option may also carry `icon` (drawn in the card's own icon column) and
`detail` — a control the option needs once it is picked, shown under its card
while it is selected and hidden when it is not. The Keep dialog's folder name is
one: it belongs to "Into a folder" and has no meaning under "By date taken". The
detail sits outside the card's `<label>`, so typing in it is not a click on the
radio.

**Verb vocabulary** (keep it consistent):

- **Add** — put an existing thing somewhere (add to collection, add member).
- **Create** — make a new thing (create tag, create invite link).
- **Remove** — detach without destroying data (remove from group, remove download).
- **Delete** — destroy data; always `danger` + confirmed via ConfirmDialog.
- Never "OK" / "Yes" alone as a confirm label — repeat the verb ("Delete library").

### Modal — `shared/Modal.tsx`

The only way to render a modal. It owns the backdrop, dismissal (backdrop click +
Escape, both blocked while `busy`), and ARIA wiring. Never hand-roll a
`modal-backdrop` div or call `window.confirm` / `alert`.

Two variants:

- **`card`** (default) — compact centered card (`confirm-modal`): title, body,
  `modal-actions` row. Use for confirmations and small one-shot forms.
- **`panel`** — large surface (`metadata-modal`): standard header (optional icon,
  title, close button); children render below (tabs, scrollable content).

Key props: `title` (required — renders as the heading and labels the dialog),
`busy` (blocks all dismissal while an async action runs), `onSubmit` (renders the
dialog as a `<form>`), `icon` (optional title icon), `className` (appended), `surfaceClassName`
(replaces the surface class for bespoke layout CSS — rare; see `BookFilter`),
`headerClassName`, `headerAction` (optional header-level action such as Cancel),
`alert` (alertdialog role — set automatically by ConfirmDialog).

Behaviour it owns, so call sites must not re-implement it (no `keydown` listener for
Escape, no focus juggling of your own):

- It portals into `<body>`, out of the page's stacking contexts. A modal rendered
  inside something already outside the app root — another modal, the lightbox, the
  reader — stays in that layer, so its CSS (e.g. `.gallery-lightbox .modal-backdrop`)
  still applies.
- Open modals form a stack: only the **topmost** answers Escape and its backdrop. A
  ConfirmDialog opened from an editor cancels alone; the editor and its form stay.
  An Escape a control inside has already handled (`preventDefault`) is left alone.
- Tab / Shift+Tab wrap inside the topmost modal. On open, focus goes to an
  `autoFocus` / `data-autofocus` control, else the first control in the body (not the
  panel's ✕), else the dialog itself — on a touch screen straight to the dialog, so
  no keyboard pops up unasked. On close it returns to whatever opened the modal.
- While any modal is open the app root (`#root`) is `inert`.

```tsx
<Modal title="New tag" busy={creating} onClose={close} onSubmit={submit}>
  …fields…
  <div className="modal-actions">
    <Button variant="secondary" onClick={close} disabled={creating}>Cancel</Button>
    <Button variant="primary" type="submit" disabled={creating}>Create tag</Button>
  </div>
</Modal>
```

**Every form/dialog ends in a `modal-actions` row** — that's the single place the
action buttons live, and it carries its own top spacing (`margin-top:
var(--space-6)`, 24px, in `components/primitives.css`), so the buttons are always
separated from the fields above. Do
not add ad-hoc spacing before the actions, and do not place buttons outside this
row.

Inside a `card` modal the body sets the width — give long, unbreakable strings
(URLs, tokens, IDs) `min-width: 0` plus `word-break`/`overflow` so they wrap or
scroll **within** the card. A grid/flex child at its default `min-width: auto`
will otherwise stretch the whole dialog past its edge.

### ConfirmDialog — `shared/ConfirmDialog.tsx`

The only way to ask "are you sure?". Built on Modal.

- `title` is a question naming the object: `Delete "${name}"?`
- Body (children) states the consequence, and what is *not* affected
  ("Files on disk are never touched.").
- `confirmLabel` is a verb phrase; `busyLabel` the in-flight text ("Deleting…").
- `danger` for destructive actions → filled danger button + `alertdialog` role.
- `rich` when the body has its own `<p>` markup; `error` to surface a failed attempt;
  `confirmIcon` for an icon in the confirm button.
- `challenge={{ value, label }}` makes the reader type `value` back before the confirm
  button enables. **Rare.** It is for actions that destroy a lot at once with nothing
  to restore from — emptying the whole Recycle Bin is the one that has it. The value
  must be something the dialog already states (a count, a name), so answering means
  having read it. On an ordinary destructive action it is noise, and noise is what
  teaches people to click through warnings.

```tsx
{pendingDelete && (
  <ConfirmDialog
    title={`Delete "${pendingDelete.name}"?`}
    confirmLabel="Delete tag"
    busyLabel="Deleting…"
    danger
    busy={deleting}
    onConfirm={deleteTag}
    onCancel={() => setPendingDelete(null)}
  >
    This removes the tag from {n} books. Books and files are not affected.
  </ConfirmDialog>
)}
```

### MessageBox — `shared/MessageBox.tsx`

The only way to show an inline message. Tones: `info`, `warning`, `error`,
`success`. Errors get `role="alert"` automatically.

```tsx
{error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
```

Error message copy: say what failed and keep the server message when it's useful —
`"Unable to create collection"`, not `"Something went wrong"`.

---

## Browse pages

Every library browse page — Audiobooks, Ebooks, Gallery and the lists they link
to (Authors, Narrators, Series, Albums…) — is built from the same two pieces, in
this order:

1. **`shared/LibraryPageHeader`** — title + count, the search box, and the page's
   one primary action. Nothing that filters by facet belongs here.
2. **`shared/LibraryPageToolbar`** — the card below it, with four slots:

   | Slot | What goes in it |
   |---|---|
   | `scope` | What the page is scoped by, where that isn't a filter: the media-kind toggle on Authors, an album's breadcrumb. Audiobooks leaves it empty — choosing libraries is a filter facet there, not a picker |
   | `tools` | Filter · Sort · View, then `.library-toolbar-divider`, then the acting controls — page-specific actions, Select, and the page's one primary action |
   | `selection` | `{ count, actions }` while multi-selecting |
   | `strip` | A second row inside the same card; the A–Z index today |

- **Controls are labelled, and the label carries state where state is invisible.**
  Sort prints the order it is in (`Recently added`), Filter prints a count badge,
  View prints its name because the layout is already on screen. Every control is
  a `.library-toolbar-button` (or the filter/sort equivalents), 44px tall, icon +
  `.toolbar-label` + optional chevron; chevrons mean "opens a menu", so Select and
  the primary action don't have one.
- **The divider separates narrowing from acting.** Everything left of it changes
  what you're looking at; everything right of it acts on the library or the
  selection.
- **Below 1100px the labels drop, nothing else moves** (one media query on
  `.toolbar-label`). The icons, order and divider stay put. A selection row with
  nine or more actions — the gallery's — drops them at 1400px instead, keyed on
  the count with `:has(> :nth-child(9))` rather than on the page.
- **At most two promoted page actions**; anything more goes in a menu named for
  the object (`Album ▾`), not behind a bare three-dot glyph.
- **Libraries are a facet, not a picker** — every browse page, including Gallery
  (`BookFilters.libraries` / `GalleryFilters.libraries`, ids in, names shown).
  The section hides itself below two libraries, and picking exactly one still
  resolves the view to that library, so a view with a single-library-only action
  (Gallery Folders' rescan) gates on the filter narrowing to one instead of
  keeping its own picker. The choice reads back as a chip under the toolbar.

- **Edit mode replaces the tools, it doesn't add a bar.** Passing `selection`
  swaps the right-hand slot for "N selected" + the bulk icon buttons and pins the
  toolbar. A separate selection bar below the toolbar pushed the whole grid down
  the moment anything was selected.
- **Menu contents change per page, the look doesn't.** A page picks which slots
  it fills; it does not arrange its own row. New shared control? Add it to the
  toolbar's CSS block in `styles/library-browse.css`, not to one page.
- **The A–Z strip is `shared/AlphabetBar`**, fed by the server's `letters` facet.
  Which bucket a title or name falls in is decided once, on the server
  (`modules/library/shared/alphabet.ts` — SQLite's `UPPER()` is ASCII-only, so
  Cyrillic can't be bucketed in SQL); the web only knows which letters each
  alphabet shows. The chosen letter lives in `?letter=` via `replaceQuery`, so it
  survives a reload without turning Back into a walk through every letter.

---

## Control panel structure

The control panel's shape lives in one file: `features/control/nav.ts`. It defines
six nav groups, each holding a row of tabs. Adding an admin page means adding one
tab entry there — nothing else keeps a parallel list.

- **Six groups is the budget.** A seventh almost always means the new page belongs
  as a tab inside an existing group. A long left nav is what this structure exists
  to prevent.
- **Every tab is a route.** Canonical paths live in `CONTROL_PATHS` in `router.ts`;
  link through `controlHref(section)`, never a string literal. In-page `useState`
  tab rows are not allowed in the control panel — a setting with no URL can't be
  bookmarked, linked from a guide, or reached by search.

  Profile follows the same rule (`PROFILE_PATHS` / `profileHref(tab)`). The test
  is whether a tab is a *destination* someone would return to or link to. About's
  two panels are one page's worth of reading, so they stay local state; a
  two-factor setup or a device address is somewhere you go back to, so it gets an
  address.
- **Pages open with `ControlSectionHead`.** It reads the eyebrow (group) and `<h1>`
  (tab) from `nav.ts`, so a page can't disagree with the nav about where it lives.
  Pass `description` for the one-line summary and `children` for header actions.
- **New settings get search keywords.** Add the terms someone would actually type
  to `TAB_KEYWORDS` in `features/control/search-index.ts`, and a `SETTING_ENTRIES`
  row for anything notable buried inside a page.

---

## Styles

Where a rule goes and what it is written with. The file-by-file map, the cascade
order and the full token tables are in [`css-map.md`](css-map.md).

- **Tokens before literals.** Colours, stacking, type and spacing are custom
  properties in `styles/tokens.css`. A new rule sets type with `--text-*`,
  `--leading-*` and `--weight-*`, and padding, margins and gaps with `--space-*`
  (a 4px grid: `--space-N` is N × 4px). An old literal is swapped for a token only
  when the values are identical — tokenizing is never a restyle — and a value
  between two steps stays a literal until someone decides the design should move.
  The shared components (`components/primitives.css`, `components/shared-rules.css`)
  already use them.
- **Global or page stylesheet.** A rule for something the app shell, a shared
  component or more than one route renders belongs in a global stylesheet (the
  list in `styles.css`). A stylesheet that only one lazily loaded page uses is
  imported by that page's module instead, so the sign-in screen doesn't download
  the control panel's CSS. It then loads after all of the global CSS, which can
  flip an equal-specificity tie — read css-map.md's "Page stylesheets" before
  moving a rule either way.
- **Theme re-skins live in `styles/themes/`.** The five themes are token sets. A
  look that changes components, not just colours, for particular themes — today the
  iSputnik Night / Light re-skin — goes in `styles/themes/`, imported straight
  after the base file it overrides, so the base file reads as one design.
- **Mobile is gated.** The desktop browser is the baseline; phone rules go inside
  `@media (max-width: 740px)` in the file that owns the classes.

---

## Microcopy rules

- Sentence case everywhere ("Create invite link", not "Create Invite Link").
- Confirmation titles are questions naming the object: `Delete "Fantasy"?`
- Destructive bodies say what is destroyed **and** what survives.
- Busy states repeat the verb with an ellipsis: "Saving…", "Deleting…".
- Cancel is always `secondary` and sits left of the confirm button in `modal-actions`.

---

## Enforcement

`npm run check:ui` (also part of `npm run typecheck`-level CI hygiene) scans
`apps/web/src` and fails when:

- `window.confirm` / `window.alert` / bare `confirm(` / `alert(` appear;
- `modal-backdrop` is used outside `shared/Modal.tsx`;
- `confirm-modal` / `metadata-modal` surface classes are instantiated outside `shared/`;
- a raw `<button>` appears outside `shared/` beyond what `scripts/raw-buttons-baseline.json`
  allows for that file;
- a `<Button>` hand-applies a variant's class (`className="icon-button"`,
  `"compact-button"`…) instead of `variant` / `compact`.

**The raw-button baseline is a ratchet.** It lists, per file under `apps/web/src`
outside `shared/`, how many raw `<button>` elements may remain — today none; the
file's `files` map is empty, so any raw button fails. A file over its count, or
any raw button in an unlisted file, fails. A file *under* its count fails too,
until the baseline is lowered with `npm run check:ui -- --update-button-baseline`,
so a converted button can't quietly be replaced by a new raw one. That flag only
ever lowers counts; allowing one more means editing the JSON by hand, where review
sees it. There is almost never a reason to: `variant="bare"` takes any custom
chrome as-is. (`shared/` is exempt — it is where the primitives are built.)

It also checks the **Help page against `docs/users/`**, both directions: a guide
that nothing on `HelpPage.tsx` links to, and a `guide("…")` link pointing at a file
that no longer exists. The Help page is the only way into the guides from inside
the app, so a missing entry means a doc nobody can reach — and it fails silently,
which is exactly what happened three commits running before this check existed.

It **warns**, without failing, about every `var(--x)` that nothing defines — no
`--x:` in any stylesheet, no `"--x"` set from a component's inline style. Such a
reference silently falls back (or resolves to nothing); that is how `--accent` spent
months as a colour two files guessed differently. Define the property in
`tokens.css` or use one that exists.

If the checker blocks something legitimately new, extend the shared component
(new prop or variant) rather than bypassing it — that is the entire point.

## Why this matters for AI-generated code

AI assistants imitate the surrounding code. Because every modal, button, and message
in the codebase goes through these primitives, generated code will follow the same
path; `CLAUDE.md` states the rules up front, and `check:ui` catches anything that
slips through. When adding a new UI pattern, add it to `shared/` first, then use it —
never inline a one-off.
