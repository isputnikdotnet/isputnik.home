# What to do next

Status: written 2026-09-12, after 4.2.0. The Beta readiness review's own lists — the
16 Must, 16 Should and 12 Later items in `beta-readiness-proposal.md` — are all done
and released across 4.0.0, 4.1.0 and 4.2.0. Nothing here is a commitment; it is what
was noticed while doing that work, ordered by what a person using the app would feel
first. Each item says what it is, why it matters, and roughly how big it is.

## Verified on 2026-09-12 (so it is not on the list below)

The guest-facing pages were checked in a browser against 4.2.0, because they are the
only pages someone outside the household reaches and they changed a lot in 4.1.0
(the player moved onto the shared playback layer; their CSS moved into page chunks):

- **A shared audiobook link** — renders with cover, author, narrators, chapter and
  description; the page's own styles load; 1.5× speed survives a chapter change (both
  `playbackRate` and `defaultPlaybackRate`, the 4.1.0 fix); no console errors.
- **A shared story link** — chapter rail, hero image, day-by-day chapters, byline.
- **A revoked link** — the guest gets "Share unavailable", the API answers 404.
- **The Russian interface** — Gallery, Quotes and the shells read Russian throughout.

Both test links were revoked and the dev account's language was set back to English.
**Drop links were not verified**: the dev database has no Photo Inbox library, and
making one is a bigger change than a verification should make. They have 26 unit tests
(`apps/server/test/drop-link-upload.test.ts`), but nobody has opened `/drop/:token` in
a browser. Worth doing on the next install that has an Inbox.

## Worth doing

### 1. Dates stay English in the Russian interface
**What:** with the interface in Russian, the Gallery timeline still prints
"September 7, 2026" rather than "7 сентября 2026". Other date-like strings are
translated, so this reads as a bug rather than a choice.
**Why it matters:** it is on the first screen a Russian-speaking member of the family
opens, and the i18n sweep is otherwise complete.
**Size:** small, but find every formatter first — the fix is passing the active
language to `toLocaleDateString`-style calls, and there are several.

### 2. Finish the keyboard and screen-reader pass
**What:** three loose ends from 4.2.0.
- The ebook reader's "scrolled layout" button has an icon and **no accessible name**
  at all; it needs a new English and Russian string.
- Six hand-built menus still lack keyboard support: `DashboardShell`,
  `BookDetailPage`, the catalog menus, `PlayerPage`, `FeedListItem`,
  `GalleryLightbox`, voice notes, the family chart. `shared/useMenuKeyboard.ts` and
  the pattern exist; this is adoption, not design.
- Reader and player toggles now announce their state; the same is not true of every
  toggle elsewhere in the app.
**Why it matters:** the app is now mostly navigable by keyboard, and a half-done pass
is worse than a stated boundary — someone relying on it hits the gaps.
**Size:** a few hours.

### 3. Library pages on a phone
**What:** Home was rebuilt for phones in 1.2.1, but the library browse pages were not,
and some navigation destinations are still stranded under Profile (the note in project
memory from the PWA redesign).
**Why it matters:** this is the one item on the list a family member would notice
without being told. The installed app opens on a phone-shaped Home and then hands
them a desktop-shaped library.
**Size:** a day or more, and it needs design decisions, not just code.

### 4. One shared server probe in the web app
**What:** `useOnlineStatus` / `useConnectionStatus` creates its **own** 6-second
`/api/setup/status` poll per consumer. With Home and the PWA banners mounted that is
two identical requests every six seconds per open tab (four in dev, where React mounts
effects twice).
**Why it matters:** harmless on a LAN, but it is the same shape of waste the server's
job poller just fixed (12 queries a second at idle → 0.5), and a wall display leaves a
tab open for weeks.
**Size:** small — one module-level probe behind `useSyncExternalStore`, which is how
`useInboxSummary` already shares its state.

### 5. Drop links in a browser
See the verification note above. **Size:** an hour, once an install has an Inbox.

## Deliberately not doing

- **`react-hooks/set-state-in-effect`.** 115 of its findings are this codebase's
  ordinary "clear, fetch, set" data loading; adopting the rule would need about 90
  suppressions, and a rule that is mostly suppressed stops being read. The genuinely
  dangerous subset — editors re-seeding a draft from props — was fixed in 4.2.0
  without the rule.
- **The 13 remaining lint warnings.** Six `any`s in the tasks view and the web API
  helper, where the value really is unknown, and seven regex escapes kept for
  legibility. Documented in `eslint.config.mjs`.
- **Splitting `player.css` and `gallery.css` out of the start-up bundle** (~75 KB).
  The start-up CSS is already down from 97 KB to 76 KB gzipped; the remaining two are
  offline-critical pages, so the saving is smaller than the regression risk.
- **A multi-architecture image.** amd64-only is a stated decision (README →
  Requirements); an arm64 image would be built under emulation and never run.

## Smaller things noticed in passing

- `users.theme` defaults to `'dark'` on databases upgraded from before 3.30.0 and
  `'minimalist'` on fresh ones. Harmless — every INSERT sets the theme — and recorded
  as the single `KNOWN_DRIFT` entry in `apps/server/test/migration-walk.test.ts`.
- `docs/sharing.md` still describes `ShareModal.tsx` and `SharedWithMePage.tsx`, which
  no longer exist. The passage needs rewriting, not just new links.
- Two untracked review documents sit in `docs/` — `beta-readiness-proposal.md` and
  `control-panel-navigation-review.md` — deliberately left out of every release commit.
  Commit them as history or delete them.
- The family chart leaves its first row empty when the data contains a loop (someone
  recorded as their own grandparent) and the focus is on the second partner. Only bad
  data reaches it; the layout stays sound.
