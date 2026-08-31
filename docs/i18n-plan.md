# UI language support (Russian) — implementation plan

Status (2026-08-27): ALL 12 NAMESPACES FULLY WIRED, and — importantly — this
has now been verified at FILE granularity, not just namespace granularity.
The first "complete" declaration this same day was wrong: `book`'s earlier
pass wired the detail/edit-modal layer but never the actual library-browsing
pages, so Audiobooks/Ebooks still showed English end-to-end. A user report
caught it. The fix was a full audit — `grep -L "useTranslation\|i18n" over
every apps/web/src/**/*.{ts,tsx}` outside tests/locales/vendor, cross-checked
file by file for whether an "unwired" hit was a real gap (has JSX text /
literal strings) or a false one (pure types, comments, decorative-only,
deferred `relativeTime()`/native-language-name style content) — see "Doing a
completeness audit" below for the reusable method. Found and closed 4 more
real gaps beyond `book`: the audiobooks/ebooks catalog+browse layer (+352
`book.json` keys), the library-creation wizard under `control/libraries/`
(+90 `control.json` keys), 5 pages/ files — device link, PWA install,
invites, welcome (+130 `common.json` keys), and 2 shared components used
app-wide (`MediaKindBadge.tsx`, `LibraryPageToolbar.tsx`'s selection count).
Also closed this same day: `reader`'s remaining files (PlayerPage.tsx,
EbookReader.tsx, offline/*.ts); `AboutDetails.tsx`/`AboutCredits.tsx` (UI
chrome + credit group names translated, license/changelog content
intentionally English, same treatment as docs/Help); Phase 3 server error
codes now consumed client-side via `apps/web/src/api.ts`'s
`localizedErrorMessage()` (`common:errors.codes.<code>` with an English
`defaultValue` fallback) — verified in-browser (wrong-password sign-in
shows "Неверный email или пароль"). ~5,750 keys total. Full detail below.

## Doing a completeness audit (do this before declaring "done" again)

Namespace-level bookkeeping ("is `book.json` wired?") is not the same
question as file-level bookkeeping ("is every file that NEEDS `book.json`
actually using it?") — the first "complete" claim conflated them. To check
file-level coverage directly:

```bash
ALL=$(find apps/web/src -name "*.tsx" -o -name "*.ts" | grep -v "/test/\|\.test\.\|/locales/\|/vendor/")
comm -23 <(echo "$ALL" | sort) <(grep -l "useTranslation\|from [\"'].*i18n[\"']" $ALL 2>/dev/null | sort)
```

Every hit needs a judgment call, not a rubber stamp: read it and check for
real hardcoded UI strings (JSX text, `title=`/`aria-label=`/`placeholder=`,
button labels) vs. a legitimate non-gap — pure TS types, comments-only
matches, decorative `alt=""`/`aria-hidden` markup, a deferred item already
on record (`shared/utils.ts`'s `relativeTime()` — the "Dates and numbers"
phase, not started), or intentionally-invariant content (`shared/alphabets.ts`'s
script names, which show their OWN native name regardless of UI language,
same as a language picker's own-language labels). A file showing up unwired
is a lead to investigate, not automatically a bug.

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
- `reader` (144 keys) — ALL files wired 2026-08-27, completing a Phase 1 gap.
  AudioPlayer.tsx was already done; PlayerPage.tsx (18 strings, reused
  `common.close` rather than duplicating a Close key), EbookReader.tsx (~75
  strings — TOC/Bookmarks/Search/Settings/Text panels, selection toolbar,
  highlight popover; two variables that shadowed the `t` function were
  renamed, a latent footgun even pre-i18n; a `colorName()` switch-statement
  helper handles `HIGHLIGHT_COLORS`' `Record<string, string>` typing per
  pitfall #4), and offline/*.ts (downloads.ts via module-level `i18n.t()`;
  useDownload.ts/useEbookDownload.ts via `useTranslation()` since they're
  hooks; bookmarks.ts/progress.ts/quotes.ts needed no changes — pure
  IndexedDB/API plumbing) are now wired too. Ran as two parallel agents
  (PlayerPage.tsx vs EbookReader.tsx+offline/*.ts, no shared-file conflict).

**Namespaces — fully translated AND wired** (continued):
- `book` (635 keys) — the detail/edit-modal layer (PersonPhotoModal.tsx,
  PersonProfileModal.tsx, EditMetadataModal.tsx incl. the standalone
  `ResultCompare` sub-component, BookDetailPage.tsx incl. the in-file
  `EditionsSwitcher` sub-component) was wired 2026-08-27, but the actual
  library-browsing layer — AudiobooksPage.tsx/EbooksPage.tsx and everything
  they link to — was never touched in that pass, so Audiobooks/Ebooks still
  showed English. Closed 2026-08-27 (+352 keys): AudiobooksPage.tsx (~1500
  lines, incl. CatalogAdminMenu/CatalogBookCard/CatalogTail/BulkEditModal/
  AddToSeriesModal/GroupAsEditionsModal/UploadBookModal, all shared with
  EbooksPage.tsx), EbooksPage.tsx (EbookCatalogCard/EbookUploadModal),
  BookFilter.tsx, CatalogRowMobile.tsx, useAudiobookCatalog.ts,
  sectionNavItems.ts, AuthorListPage.tsx, NarratorListPage.tsx,
  SeriesListPage.tsx/SeriesDetailPage.tsx, CategoryListPage.tsx/
  CategoryDetailPage.tsx, TagListPage.tsx/TagDetailPage.tsx (reuses
  `family:common.nee` for the "née …" fragment on a tagged family member),
  PeopleCombobox.tsx, PersonPage.tsx (incl. the in-file `PersonTitleRow`
  sub-component — the full cross-type person page, not `PersonProfileModal`).
  `types.ts`/`covers.ts`/`categoryIcons.tsx` needed no changes: `types.ts`'s
  only label-bearing exports (`LIBRARY_ROLE_OPTIONS`/`PUBLIC_ROLE_OPTIONS`)
  belong to the control-panel library-members flow, out of this batch's scope
  (same call the `control` namespace bullet already made). Per pitfall #4/#3,
  several module-level option lists that were previously frozen `const`s
  became functions called fresh at render/call time so labels stay reactive
  to a language switch: `BookFilter.tsx`'s `SORT_OPTIONS`/`EBOOK_SORT_OPTIONS`/
  facet titles/status+duration labels (now `getSortOptions()` etc.),
  `useAudiobookCatalog.ts`'s `DENSITY_OPTIONS` (now `getDensityOptions()`),
  `sectionNavItems.ts`'s `AUDIOBOOK_NAV_ITEMS`/`EBOOK_NAV_ITEMS` (now
  `audiobookNavItems()`/`ebookNavItems()`), and `TagListPage.tsx`'s
  `TAG_SCOPES` (now `getTagScopes()`). Verified: typecheck + check:ui + full
  web test suite (178 tests, incl. `AuthorListPage.test.tsx`'s filter/sort/
  A–Z-strip assertions which pin several exact English strings) all pass, plus
  an in-browser pass signed in on the Russian-language dev account over
  Audiobooks, Ebooks, Authors, Narrators, Series (list + detail), Categories
  (list + detail), Tags (list + detail), and a Person page — all rendering
  correctly, including pluralized counts. One pre-existing gap found and
  flagged separately (out of this batch's scope, `shared/` is not part of
  it): `shared/LibraryPageToolbar.tsx`'s multi-select "{count} selected"
  label was never wired in any namespace and still shows raw English.
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

- `control` (534 keys) — ALL files wired 2026-08-27: ControlPanelPage.tsx,
  ControlSearch.tsx, nav.ts, search-index.ts, and the 9 core sections
  (AboutSection, AppearanceSection, BackupSection, CategoriesSection,
  GroupsSection, InvitesSection, LibrariesSection, LibraryMembersModal,
  LogsSection). ControlSectionHead.tsx and types.ts needed no changes (the
  former already takes translated strings as props; the latter is pure
  TypeScript types). `nav.ts` was restructured rather than just translated:
  `ControlGroupDef`/`ControlTabDef` dropped their literal `label` fields in
  favor of `groupLabel()`/`tabLabel()`/`contextLabel()` functions keyed off
  the already-literal-union `GroupKey`/`ControlSection`/new `ContextKey`
  types, so `i18n.t()` template-literal calls type-check per pitfall #4 and
  stay reactive to a language switch. `search-index.ts`'s
  `CONTROL_SEARCH_ENTRIES` (frozen at import time, so it would have cached
  whatever language was active on first load) became `getControlSearchEntries()`,
  called fresh by `ControlSearch.tsx`. Its `keywords` corpus is intentionally
  NOT translation keys — each entry carries hardcoded English AND Russian
  match terms concatenated together, so typing either language finds a
  setting regardless of the active UI language (verified in-browser: typing
  "дубли" while signed in as the Russian-language dev account surfaces
  "Duplicate cleanup"). `LibraryMembersModal.tsx`'s role dropdown now sources
  its own `roleName()`/`roleTagline()` lookups instead of the shared
  (English, out-of-batch-scope) `LIBRARY_ROLE_OPTIONS.label`. Verified:
  typecheck + check:ui + full web test suite (178 tests), plus an in-browser
  pass over Libraries/Groups/Invites/Categories/Backup/Logs/About/Appearance,
  the search palette, and the library-members modal, all signed in on the
  Russian-language dev account.

- `family` (475 keys) — ALL 23 edited files wired 2026-08-27 (genealogy
  module): AddChildModal/AddParentModal/AddRelativeModal/AddSiblingModal/
  AddUnionModal, CitationEditModal, EventEditModal, FamilyFamiliesPage/
  FamilyPeoplePage/FamilyPersonPage (~1400 lines, incl. the RelationCard
  sub-component)/FamilyPersonPhotosPage, FamilyTagAccessModal,
  FamilyTreeChart, FamilyTreePage, FamilyTreeSettingsModal,
  GalleryPersonLinkModal, GedcomImportModal, PartialDateField,
  PersonEditModal, PersonPickerModal, UnionEditModal, sectionNavItems.ts,
  types.ts. PersonAvatar.tsx/chart-layout.ts/useFamilyUploadTarget.ts
  needed no changes (decorative-only, pure geometry, silent-catch hook).
  A relative-name matrix (plain/step/adopted/foster × gender) replaces
  English string concatenation with real Russian words (пасынок/падчерица,
  etc.); names in confirm-dialog titles use guillemets («»)  to sidestep
  Russian case declension on arbitrary person names — same technique as
  `book.json`.
- `gallery` (550 keys) + `galleryModals` (~230 keys) — ALL files wired
  2026-08-27, as two parallel agents on non-overlapping files in the same
  `features/gallery/` directory (gallery.json vs galleryModals.json, no
  write race since each JSON file had exactly one writer). `gallery`:
  AssetTile, GalleryFilter, GalleryLightbox, GalleryLocationPicker,
  GalleryMap, GalleryMiniMap, GalleryPage (~2790 lines), GalleryPlaceSearch,
  GallerySlideshowEditor, MusicPicker, PhotoPicker, gallery-view.ts,
  useGalleryAlbums/People/Slideshows.ts hooks (types.ts needed no changes).
  `galleryModals`: AddToAlbumModal, AddToSlideshowModal, GalleryDateModal,
  GalleryFaceSettingsModal (incl. ClusterHealthPanel/HealthAvatar
  sub-components), GalleryLocationModal, GalleryUploadModal, ShareAlbumModal,
  SlideshowTitleCardModal.
- `misc` (196 keys, updated) — the last originally-scoped namespace,
  authored from scratch and wired 2026-08-27, all 7 in-scope files:
  AboutPage.tsx (the thin page shell), ChangeEmailSection,
  ChangePasswordSection, LinkedDevicesSection (incl. the module-level
  `whenSeen()` helper, converted to `i18n.t()` since it can't call a hook),
  MfaSection (incl. its 3 in-file setup/regenerate/disable modal
  sub-components — the densest file in the batch: QR setup, backup codes,
  TOTP vs. email method choice), PasskeysSection, SharedLinksSection (incl.
  its module-level `expiryText()`/`describe()` helpers, same `i18n.t()`
  treatment). Terminology matched `controlAdmin.security`'s admin-side MFA/
  passkey vocabulary for consistency: "ключ доступа" (passkey), "резервный
  код" (backup code), "двухфакторная аутентификация"/"двухфакторная
  проверка" (two-factor). Verified: typecheck + check:ui + full web test
  suite (178 tests) + an in-browser pass over all 4 touched profile tabs and
  /about, signed in as the Russian-language dev account.
- `apps/web/src/shared/AboutDetails.tsx` + `AboutCredits.tsx` (24 keys added
  to `misc:about`) — wired 2026-08-27, closing the gap the `misc` batch had
  deliberately left. UI chrome (tabs, stack labels, license sentence via
  `<Trans>` with `agpl`/`source` link components, "What's new", the
  pluralized "Show earlier versions (N)" button) and AboutCredits' 7 group
  names (Reading/Face recognition/.../App) are translated; each credit
  item's `use` description and `license` identifier (MIT, CC BY 4.0, Apache-
  2.0, etc.) stays English on purpose — third-party attribution and license
  strings are canonical-form technical/legal text, not UI copy, same
  treatment as HelpPage/GuidePage's docs content. The version-update
  `label`/`changes` changelog entries also stay English for the same reason
  (hand-written release notes, not retroactively translated). Verified
  in-browser: tab labels, group names, and the interpolated earlier-versions
  count ("Показать более ранние версии (258)") all render correctly.

**`library` namespace — reconciled as done, needs no work**: every file
under `features/library/` (BookmarksPage, DownloadsPage, FeedListItem,
FeedTile, LibraryFeedPage, LikesPage, QuotesPage, SharedWithMePage, feed.ts,
UserAreaNav) is already fully wired — UserAreaNav via `common` in Phase 1,
everything else via `user` in that namespace's wiring batch (they logically
belong there: bookmarks/likes/quotes/shares/downloads are all "your library"
features). `library.json` stays `{}` and registered in the barrel (harmless,
required for `check:ui`'s en/ru folder-parity check) — there was never a
distinct `library` concern to translate.

**Namespaces — still empty `{}` (nothing done)**: none. `misc` was the last
one and is now fully wired (see the bullet above).

**Server (Phase 3): `code` fields now consumed client-side (2026-08-27)**.
`code` was added earlier to auth-routes.ts, mfa-routes.ts, and
modules/users/profile.ts error replies (stable machine-readable identifiers
like `auth.invalid_credentials`, `mfa.challenge_expired`). `apps/web/src/api.ts`
now maps them: `localizedErrorMessage()` builds the key
`` `common:errors.codes.${payload.code}` `` and calls
`i18n.t(key as any, { defaultValue: payload.error })` — the `as any` is
deliberate (documented inline) since `code` is a runtime value from the
server with no literal-union type to check against, unlike every other
`t()` call in this project. `defaultValue` is what makes the plan's
"falls back to the English sentence for codes it doesn't know" promise
real: an unmapped code degrades to the server's English `error` string
instead of ever showing a raw key. 20 codes translated under
`common:errors.codes.{auth,mfa,profile}.*` in both languages (`mfa.
resend_cooldown`'s "60 seconds" is hardcoded on both sides, matching the
fixed `EMAIL_CODE_RESEND_SECONDS` server constant — no value is sent
separately to interpolate). Verified in-browser: an invalid-password sign-in
now shows "Неверный email или пароль", not English. Every other server
module (uploads, gallery, family tree, collections, control-panel routes)
still has plain English-only `error` strings with no `code` — extending
Phase 3 to them is future work, not required for the UI sweep to be
complete (routes without a `code` simply show `error` as-is, same as always).

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
workspaces), `node scripts/check-ui-conventions.mjs`, and `npm test`
(1549 server + 178 web = 1727 tests) all pass. The repo is in a clean,
shippable state — all 12 namespaces are wired, the `reader` gap is closed,
`AboutDetails.tsx`/`AboutCredits.tsx` are wired, and Phase 3's `code`
mapping is live in `api.ts`. No tracked gaps remain in the UI sweep;
extending Phase 3's `code` field to more server routes is optional
future work (see the Phase 3 section above), not a blocker.

Phase 4 (control panel core sections — LibrariesSection, BackupSection,
GroupsSection, InvitesSection, CategoriesSection, AboutSection, AppearanceSection,
LibraryMembersModal, nav.ts, search-index.ts), namespace `control`, DONE
2026-08-27 (see the namespace bullet above). Scope: the web app's UI chrome
in Russian. Content (titles, authors, folder names) is already whatever
language the files are in, and the Cyrillic A–Z strip already exists
(`shared/alphabets.ts` + the server's
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

## Phase 4 — Control panel (DONE 2026-08-27)

Admin-facing, translated into Russian as part of Phase 2's sweep rather than
deferred to a later release: `control.json` (534 keys) covers nav.ts,
ControlPanelPage/ControlSearch, and the 9 core sections, and
`features/control/search-index.ts`'s search terms are in both languages (as
a hardcoded bilingual keyword corpus, not translation keys — see the
`control` namespace bullet in Phase 2's status above for why).

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
