# The top layout

Why the sidebar gave way to a top bar, what it is now, and what is left. Accepted
2026-11-01 from the owner's mock-up, after a prototype on real data.

## Why

- Opening a section replaced the sidebar's main menu with the section's own, so moving
  from Audiobooks to Photos meant going through Home.
- Nine sidebar rows and a 268px column cost the width that catalogs and Home need.
- The TV app has a top menu, navy and teal; the web should read as the same product.

## What it is

- **Bar:** logo, Home, Media, Family; Control panel and the person's menu on the right.
  Tags and About/Help moved to that menu.
- **Media:** a button that reads as the library you are in, opening a short menu of
  plain links (icon, name, count) hanging from the button — since 4.55, at the owner's
  request; it used to open onto the big picture cards. The picture cards stay on Home,
  on screens of at least 1400 × 820, so the rows below are not pushed down.
- **Covers:** the picture alone, no box, frame or blurred fill (4.56, from the owner's
  mock-up): every cover in a row is as tall as its slot and as wide as its shape, set on
  the slot's floor at its left edge, so the titles line up. The slot is square on
  Audiobooks and a fifth taller for books and films. Pages sit at four fifths of the
  window (`--browse-page-width`, at least 1100px).
- **Tabs:** each section's existing `sideNav` component, flattened by CSS into one row
  under the bar. A long row scrolls, keeping the current page in view.
- **Home:** Continue (the most recent book or video) and On this day, what is waiting on
  you, your library, new photos and the quote, in progress, recently added (books and
  video together), then the family feed. Every tile is the same square.
- **Stays as it was:** the control panel and story editor keep the sidebar (the editor's
  chapters are reorderable); phones keep the four-tab bar and feed.
- **Logo:** the official app icon (`Assets/brand/isputnik-app-icon.svg`: house, orbit,
  satellite) everywhere the app shows one, in place of the Earth mark and sidebar star.

## Video

Video follows the TV app (`docs/tv-app-plan.md`, *T2 as built*) and sits centred like Home:
an overview at `/videos` (banner, Continue watching, what is newest in each kind) beside
Shows and Movies, each with the banner, then its sets and every poster. A title has its
backdrop behind the words, and one season at a time as tabs over picture cards. The
banner picks what the TV picks: what is in progress here, else the newest. Not `/video`:
that address belongs to the engine.

## Layout and theme are separate

The layout wears any theme. **Orbit** is a seventh theme, not the layout: navy and teal,
with Earth at full strength at the top of Home and dimmed on other pages. The plain themes
have no picture; the iSputnik themes keep their scenes, dimmed. The default theme did not
change, so existing accounts keep what they chose.

**Thanksgiving** is an eighth: warm browns, an amber accent, serif headings and an autumn
lake at sunset, on the same terms as Earth.

## Games

The games (isputnik.games, behind `/games`) wear this bar too, as their own copy of it
(`shared/TopBar.tsx` there): Home · **Games ▾** · Family, the control panel, a sound
switch and the person's menu, with no row of tabs (the owner dropped a tab per game). It
asks home's `/api/setup/status`, `/api/video/status` and `/api/home/libraries` for the
Media list. A change to this bar wants the same change there. Games carries the Orbit
and Thanksgiving palettes (not their pictures), so the gateway sends every theme by its
own name; release a games version with them before a home that sends them.

## Classic

Per browser, on Profile › Appearance, because it is temporary: no column to migrate away.
Remove it, `HomePage`'s old desktop branch and the sidebar branch of `DashboardShell` one
or two releases after the top layout ships, if nobody needs it. The control panel still
needs the sidebar itself.

## Left to do

- Regenerate the guide screenshots and re-record the tutorial videos, videos last.
- The engine's continue list has no posters, so Home asks for up to eight one at a time;
  put `poster` on `/continue` in `isputnik.video` and drop those requests.
- Recently added takes books and video turn about, because the engine's titles carry
  no date; give them one and sort by it. Its **View all** page still lists books only.
- Global search in the bar (the shell has none; pages keep their own boxes).
- Decide whether "Gallery" becomes "Photos" everywhere; the bar says Photos, its page
  title and the phone sheet still say Gallery.
