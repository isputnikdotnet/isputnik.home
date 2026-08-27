# UI language support (Russian) — implementation plan

Status (2026-08-27): Phases 0–1 complete and verified in-browser. Phase 2
in progress — namespace infrastructure built, ~2,540 keys authored and
translated across 6 of 12 namespaces; `common`, `controlAdmin`, `book`,
`user`, and `controlDash` (5 of 6 translated namespaces) are now FULLY
wired, including `sections/duplicates/` (the `dupes.*` keys, the whole
duplicate-cleanup wizard) — that batch finished after this doc's last
save, which briefly left it noted as pending; `reader` partially wired.
Phase 3 (server error codes) started. Phase 4 not started. Full detail below.

Phase 0 — i18next + typed keys, `users.language` (migration 48), Language picker
on Profile → Appearance, localStorage mirror, `check:ui` key-parity rule (which
normalizes CLDR plural suffixes, since ru legitimately has _few/_many keys en
lacks). Phase 1 — shared components (ConfirmDialog, Modal, Pager, AlphabetBar,
SortMenu, PageSizeMenu, ThemePicker, Field, FacetFilter, DateRangePicker,
RefreshButton, FileUpload, AccountForm, LibraryPageHeader, SectionNav), the app
shell + sidebar/mobile nav (DashboardShell, Shell, UserAreaNav), sign-in + MFA
(LoginPage, incl. the network-block notice), and the home feed (HomePage +
batchDayLabel, which now uses Intl.RelativeTimeFormat for 2–6-day-old batches
instead of weekday names — weekdays need case declension in Russian).

## Phase 2 — current state (2026-08-27)

**Infrastructure**: locales restructured from one `common.json` pair into 12
namespace pairs, loaded via `locales/{en,ru}/index.ts` barrels and
`i18n.ts`'s `BUNDLE_LOADERS` (whole-language chunk, not per-namespace).
**Namespace-key typing pitfalls** (cost real debugging time — write these down):
1. `t("ns:key")` colon-prefixed keys only type-check when `useTranslation()` is
   called with an explicit namespace array, e.g. `useTranslation(["common", "reader"])`.
   `useTranslation()` with no args only types the default namespace (`common`).
   Every file added to a new namespace needs this.
2. `<Trans i18nKey="key" ns="namespace" .../>` takes an UNPREFIXED key plus a
   separate `ns` prop — unlike `t()`'s colon syntax. Mixing the two patterns
   (colon-prefixed key on `<Trans>`) fails to type-check.
3. Module-level, non-component functions (helpers, `gradePolicies()`-style data
   builders) can't call a hook, so they import `i18n` directly from `../../i18n`
   and call `i18n.t(...)`. Values assigned into a plain object literal that's
   NOT immediately rendered (e.g. built once, read later inside JSX) still
   type-check fine this way.
4. A **template-literal key** (`` `ns:group.${variable}` ``) only type-checks
   when `variable`'s type is a literal string union, not plain `string` — build
   a `Record<Enum, "literalKeySuffix">` lookup map (not `Record<Enum, string>`)
   and interpolate that. When the literal-union approach still confuses the
   overload resolver (seen once, cause unclear — possibly ternary/ conditional
   context bleeding into overload selection), fall back to an explicit
   `switch` statement spelling out each full literal key per branch — always
   works, just more verbose. Get the exact key name right; a genuinely wrong
   key produces the same confusing `never`-typed error as the above, so when a
   template-literal key fails, check the JSON for a typo before restructuring.
5. Reused namespace files can drift: this session had `trashRoot.locationLockedTitle`
   confused with `recycleBin.locationLockedTitle` (both plausible names, only
   one exists) — grep the JSON for the exact key before assuming it's there.

**Namespaces — fully translated AND wired**:
- `common` (218 keys) — Phase 0–1 surface
- `controlAdmin` (797 keys) — ALL 14 files wired and browser-verified
  2026-08-27: StatusMetric, TrashRootEditor, NotificationsSection, MailSection,
  OpdsAccessSection, MissingPhotosSection, TagsSection, StorageSection,
  ScheduledJobsSection, SecurityProtection, ScanRulesModal, UsersSection,
  RecycleBinSection, SecuritySection (1568 lines, the largest — all 4 tabs
  confirmed rendering correctly in-browser: Overview/Policies/Trusted
  networks/Blocked IPs, including live seeded data and `<Trans>`-rendered
  `TRUST_PROXY` code snippets)
- `reader` (144 keys) — AudioPlayer.tsx fully wired; playerPage/ebook/offline
  sub-keys authored but PlayerPage.tsx / EbookReader.tsx / offline/*.ts NOT
  yet wired

**Namespaces — fully translated AND wired** (continued):
- `book` (283 keys) — ALL 4 files wired: PersonPhotoModal.tsx, PersonProfileModal.tsx,
  EditMetadataModal.tsx (incl. the standalone `ResultCompare` sub-component, which
  needed its own `useTranslation` call), BookDetailPage.tsx (incl. the in-file
  `EditionsSwitcher` sub-component) — typecheck + check:ui verified 2026-08-27
- `user` (333 keys) — ALL target files wired across 3 batches 2026-08-27:
  LikesPage/BookmarksPage/QuotesPage/SharedWithMePage/CollectionsPage/
  CollectionDetailPage/AddToCollectionModal/NewCollectionModal; ActivityList
  (no changes needed)/EmojiPicker/InboxRow/NotesSection/SendToSheet/phrasing.ts/
  library/feed.ts; ShareModal/ShareSetModal/SharePage.tsx/DownloadsPage/
  FeedListItem/FeedTile/LibraryFeedPage/InstallCard/PwaNotifications —
  typecheck + check:ui + full web test suite (178 tests) verified. One test
  (NotesSection.test.tsx) updated: the translated `removeMineAria` ("Remove
  your note") intentionally diverges from the old English concatenation
  ("Remove note by you") because "Remove note by {{name}}" with name="Вы"
  is broken Russian grammar (wrong case) — the distinct key is correct,
  the test assertion was stale.

- `controlDash` (765 keys) — ALL files wired 2026-08-27, in two parallel
  batches. Dashboard batch: DashboardSection.tsx + everything under
  `sections/dashboard/` (~16 files: ActivityView, activityEvents.ts,
  countryCentroids.ts (no changes needed — pure data), DashboardChart,
  GeoipDatabaseModal, HomeLocationModal, LibrariesView, LocationsMap,
  LocationsView, LoginsTable, LoginsView, SignInsFilterModal,
  SignInsSection, SystemView, TasksView, useRecentActivity.ts). One key
  added beyond the authored set: `map.osmAttribution` (the Leaflet/
  OpenStreetMap tile credit, en+ru). Duplicates batch: all 9 files under
  `sections/duplicates/` (CertaintyBadge, cleanup-types.ts — held word/
  formatting lookups despite the name, not pure types, DuplicateCleanup
  Section, CleanupWizard, CleanupJobCard, CleanupResultCard,
  DuplicateViewer, FolderCompare, shared.tsx). Module-level lookup consts
  (`STATUS_WORDS`, `SECTION_HEADINGS`, `TOP_LEVEL`, etc.) were converted to
  functions calling `i18n.t()` so they stay reactive to a language switch
  instead of freezing English at import time. Both batches: typecheck +
  check:ui + full web test suite (178 tests) + full server suite (1549
  tests) all verified together.

**Namespaces — still empty `{}` (nothing done)**: `control` (nav.ts +
ControlPanelPage + ~9 core sections), `family` (all 26 familytree files),
`gallery` (11 page files), `galleryModals` (13 modal files), `library`
(UserAreaNav done in Phase 1; LikesPage/BookmarksPage/etc. not — overlaps
with `user`, reconcile ownership before resuming), `misc` (About/Help/Guide
pages, profile sub-sections: MFA/passkeys/email/password/shares/devices).

**Server (Phase 3, started)**: `code` field added to auth-routes.ts,
mfa-routes.ts, and modules/users/profile.ts error replies (stable
machine-readable identifiers like `auth.invalid_credentials`,
`mfa.challenge_expired`) — client-side code→locale mapping NOT yet built in
api.ts, so these codes aren't consumed anywhere yet. Every other server
module (uploads, gallery, family tree, collections, control-panel routes)
untouched.

**Why progress is uneven**: 11 parallel Task agents were launched to sweep all
remaining areas at once; all 11 hit a session-wide usage cap mid-task and
died before writing most source-file edits — several had fully authored their
namespace JSON (reading + translating first) but not yet applied it back to
components when they were killed. AudioPlayer.tsx was mid-edit and needed
manual completion (missing keys, wrong `useTranslation()` call — see the
namespace-key typing pitfall above). Restarting many parallel heavy agents at
once is what caused the failure; resuming this work should go one namespace
(or a few small ones) at a time, verifying typecheck + check:ui + tests after
each, not as one giant fan-out.

**Verified as of this checkpoint**: full `npm run typecheck` (both
workspaces), `node scripts/check-ui-conventions.mjs`, and `npm test` (1549
server + 178 web) all pass. The repo is in a clean, shippable state — nothing
is broken, translation is just incomplete.

Phase 4 (control panel core sections — LibrariesSection, BackupSection,
GroupsSection, InvitesSection, CategoriesSection, AboutSection, AppearanceSection,
LibraryMembersModal, nav.ts, search-index.ts) not started; namespace `control`
reserved for it. Scope: the web app's UI chrome in Russian. Content
(titles, authors, folder names) is already whatever language the files are in, and
the Cyrillic A–Z strip already exists (`shared/alphabets.ts` + the server's
alphabet detection) — none of that is part of this work.

## Decisions

- **Library: i18next + react-i18next.** Mature, tiny (~15–20 KB gzipped), handles
  Russian's three plural forms (1 файл / 2 файла / 5 файлов) natively via the CLDR
  plural rules, and locale files lazy-load so English users never download Russian.
- **English is the source of truth.** Keys live in
  `apps/web/src/locales/en/*.json`; `ru` mirrors it and falls back to English for
  any missing key, so a half-translated feature degrades gracefully instead of
  breaking.
- **Language is a per-user preference, like theme.** New `language TEXT NOT NULL
  DEFAULT 'en'` column on `users` (existing-table column ⇒ needs a `migrations[]`
  entry, unlike new tables). Mirrored to `localStorage` so the sign-in screen and
  the offline PWA can be in Russian before a session exists; browser
  `navigator.language` is the first-run default for the sign-in page only.
- **Server error messages are NOT translated server-side.** New/touched routes gain
  a stable `code` field alongside the existing `error` sentence; the client maps
  codes to localized strings and falls back to the English sentence for codes it
  doesn't know. This avoids threading Accept-Language through ~780 message sites
  and keeps the server language-free.
- **Dates and numbers** go through the active locale. The ~144 existing
  `toLocale*` / `Intl.*` calls get centralized into shared `formatDate` /
  `formatNumber` helpers that read the current i18next language.
- **Out of scope for v1:** `docs/users` guides and the Help page (stay English;
  the `check:ui` docs↔Help coupling is untouched), `docs:shots` screenshots,
  admin alert emails, OPDS feed labels.

## Phase 0 — Harness (~1 day)

1. Add `i18next` + `react-i18next` to `apps/web`.
2. `apps/web/src/i18n.ts`: init with `en` bundled, `ru` behind a dynamic import;
   update `<html lang>` on switch.
3. **Typed keys:** declare the i18next `resources` type from the `en` JSON so
   `t("nonexistent.key")` fails `npm run typecheck`.
4. `users.language` column + migration + profile PATCH; a Language `SelectMenu`
   on Profile → Appearance (native names: English / Русский); `localStorage`
   mirror applied before React mounts to avoid a flash of English.
5. **`check:ui` extension:** a key-parity rule — every key in `en/*` must exist in
   `ru/*` and vice versa, so the languages cannot drift. (A "no hardcoded JSX
   strings" rule is deferred; it's noisy until the sweep is done, then can be
   enabled per-directory.)
6. Test setup: `apps/web/test` initializes i18n with `en` synchronously, so
   Testing Library text queries keep working unchanged.

## Phase 1 — Shared components + chrome (~2–3 days)

The multiplier: everything in `apps/web/src/shared/` (Button labels,
ConfirmDialog, Modal, MessageBox titles, Pager, SortMenu, FileUpload,
AlphabetBar's "#" tooltip, etc.), the app shell and navigation, the sign-in +
MFA screens (first thing a Russian-speaking family member sees, and pre-session —
exercises the localStorage path), and the home feed.

## Phase 2 — Everyday user surface (the bulk; incremental sweeps)

Feature by feature, shippable at any cut point because of the English fallback:
library browse pages and their toolbar/filter/sort labels, detail pages, the
players and readers, gallery (timeline/folders/people/map), collections,
favorites, quotes, bookmarks, family tree, search, profile.

Rules for the sweep:
- Every count goes through `t(key, { count })` — no hand-built plurals.
- Busy labels ("Saving…") and Confirm verbs are translated at the call site, not
  inside the shared component.
- Keys are namespaced per feature (`library.json`, `gallery.json`, …), named by
  meaning not by English text.

## Phase 3 — Server error codes (incremental, ongoing)

Start with the errors users actually see: auth/sign-in, MFA, uploads, form
validation (`fieldErrors` get per-field codes). Each becomes
`{ error: "English sentence", code: "auth.locked_out" }`; the client's MessageBox
layer resolves `code` first. No flag-day — untouched routes keep working via the
English fallback.

## Phase 4 — Control panel (decide later)

Admin-facing; stays English through v1. If translated later it's just more of
Phase 2 (`control.json`), plus `features/control/search-index.ts` needs its
search terms in both languages.

## Release strategy

Phases 0–1 can merge to main invisibly (picker hidden or the ru option marked
"partial"). Expose the Language picker in the release that completes Phase 2's
core surface, as a minor version with a changelog entry in `status.ts`
`versionUpdates`. Translation authoring is native-speaker work — machine-draft
then hand-review is fine.

## Size reality check

~241 web source files, roughly 2,500–4,000 user-visible strings. Runtime cost:
~15–20 KB gzipped library + ~40–60 KB gzipped per locale file (lazy). No Docker
image or DB impact worth mentioning.
