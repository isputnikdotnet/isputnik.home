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
- **Media:** a button that reads as the library you are in, opening onto big picture
  cards with counts. The cards also appear on Home on screens of at least 1400 × 820;
  smaller screens reach them through Media, so the rows are not pushed down.
- **Tabs:** each section's existing `sideNav` component, flattened by CSS into one row
  under the bar. A long row scrolls, keeping the current page in view.
- **Home:** Continue (the most recent book or video) and On this day, what is waiting on
  you, your library, in progress, recently added, new on video, new photos and the
  quote, then the family feed.
- **Stays as it was:** the control panel and story editor keep the sidebar (the editor's
  chapters are reorderable); phones keep the four-tab bar and feed.
- **Logo:** the official app icon (`Assets/brand/isputnik-app-icon.svg`: house, orbit,
  satellite) everywhere the app shows one, in place of the Earth mark and sidebar star.

## Layout and theme are separate

The layout wears any theme. **Orbit** is a seventh theme, not the layout: navy and teal,
with Earth at full strength at the top of Home and dimmed on other pages. The plain themes
have no picture; the iSputnik themes keep their scenes, dimmed. The default theme did not
change, so existing accounts keep what they chose.

Games has no Orbit of its own yet, so the gateway tells it `plain-dark` for now.

## Classic

Per browser, on Profile › Appearance, because it is temporary: no column to migrate away.
Remove it, `HomePage`'s old desktop branch and the sidebar branch of `DashboardShell` one
or two releases after the top layout ships, if nobody needs it. The control panel still
needs the sidebar itself.

## Left to do

- Regenerate the guide screenshots and re-record the tutorial videos, videos last.
- Replace the library card pictures, cut from the mock-up, with the originals.
- The engine's continue list has no posters, so Home asks for up to eight one at a time;
  put `poster` on `/continue` in `isputnik.video` and drop those requests.
- Global search in the bar (the shell has none; pages keep their own boxes).
- Decide whether "Gallery" becomes "Photos" everywhere; the bar says Photos, its page
  title and the phone sheet still say Gallery.
- Give games an Orbit theme and drop the gateway's mapping.
