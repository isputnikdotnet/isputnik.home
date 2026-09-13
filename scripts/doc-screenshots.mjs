// Regenerates the screenshots in docs/users/images by driving a real browser.
//
// The dev server has to be running (`npm run dev`). The script finds Chrome or
// Edge, talks to it over the DevTools protocol using Node's built-in WebSocket
// (no extra dependencies), mints a temporary admin session straight into the dev
// database so authenticated pages render, and writes one PNG per entry in SHOTS.
// The session is deleted again on the way out.
//
//   node scripts/doc-screenshots.mjs              # every shot
//   node scripts/doc-screenshots.mjs 31 storage   # only names containing these
//   BASE=http://localhost:4000 node scripts/doc-screenshots.mjs
//
// A shot may carry `setup`: JavaScript evaluated in the page before the capture,
// for screens you can only reach by opening a dialog or switching a tab. Shots
// marked `state` need the app in a particular condition (an empty install, say)
// and are skipped unless named explicitly. A shot may ask for its own viewport
// `height` when the default would cut a tall dialog short.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs", "users", "images");
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, "data", "db", "isputnik.sqlite");
const BASE = (process.env.BASE ?? "http://localhost:5173").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT ?? 9333);
const WIDTH = Number(process.env.SHOT_W ?? 1440);
const HEIGHT = Number(process.env.SHOT_H ?? 900);

// Opening a dialog from the page: helpers the `setup` snippets share.
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const topModal = () => [...document.querySelectorAll(".modal-backdrop")].pop();
  const button = (root, text) => [...root.querySelectorAll("button")]
    .find((b) => b.textContent.trim().startsWith(text));
  const setInput = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
`;

const SHOTS = [
  // Only reachable before the first account exists, so it can't be regenerated
  // on a configured install — capture it while the database is still empty.
  { name: "00-first-run", url: "install", auth: false, state: "no accounts yet" },
  // Needs an account to exist: with an empty database /login redirects to the
  // first-run form, so capturing it then would silently overwrite this with
  // 00-first-run's screen. Don't run the two together on a fresh install.
  { name: "01-login", url: "login", auth: false, state: "signed out, at least one account" },
  { name: "02-home", url: "" },

  { name: "10-storage-empty", url: "control/storage", state: "before storage is configured" },
  { name: "11-storage-configured", url: "control/storage" },
  {
    name: "12-storage-add-container",
    url: "control/storage",
    setup: `button(document, "Add container").click(); await sleep(500); "opened";`
  },

  {
    name: "20-library-wizard-type",
    url: "control/libraries",
    setup: `button(document, "Add library").click(); await sleep(700); "opened";`
  },
  {
    name: "22-library-wizard-folder",
    url: "control/libraries",
    setup: `
      button(document, "Add library").click(); await sleep(700);
      button(topModal(), "Audiobooks").click(); await sleep(300);
      button(topModal(), "Next").click(); await sleep(700);
      button(topModal(), "Browse").click(); await sleep(1200);
      "folder browser";`
  },
  {
    name: "23-library-wizard-review",
    url: "control/libraries",
    // Walks the wizard to the last step without submitting it.
    setup: `
      button(document, "Add library").click(); await sleep(700);
      button(topModal(), "Audiobooks").click(); await sleep(300);
      button(topModal(), "Next").click(); await sleep(700);
      setInput(topModal().querySelector("input"), "Audiobooks"); await sleep(200);
      button(topModal(), "Browse").click(); await sleep(1200);
      const folder = [...topModal().querySelectorAll("button")].find((b) => b.textContent.trim() === "Audiobooks");
      if (!folder) return "no Audiobooks folder in the container";
      folder.click(); await sleep(900);
      button(topModal(), "Use this folder").click(); await sleep(700);
      button(topModal(), "Next").click(); await sleep(900);
      "review";`
  },
  { name: "21-libraries-list", url: "control/libraries" },

  { name: "30-audiobooks", url: "audiobooks" },
  { name: "31-ebooks", url: "ebooks" },
  { name: "32-gallery", url: "gallery" },
  // The gallery views that only mean anything once the library has been through
  // a face scan and has photos carrying GPS.
  { name: "33-gallery-people", url: "gallery/people", state: "faces scanned and named" },
  { name: "34-gallery-map", url: "gallery/map", wait: 5000, state: "photos with GPS" },
  { name: "35-gallery-albums", url: "gallery/albums", state: "at least one album" },
  { name: "36-gallery-slideshows", url: "gallery/slideshows", state: "at least one slideshow" },
  {
    // The viewer with its Details panel open: the photo's date and place, people,
    // tags, description, recordings and notes down the right.
    name: "37-gallery-lightbox",
    url: "gallery",
    setup: `
      const tile = [...document.querySelectorAll('button[aria-label^="Open "]')]
        .find((b) => /\.(jpe?g|png|webp|heic)$/i.test(b.getAttribute("aria-label")));
      if (!tile) return "no photo tile on the Gallery page";
      tile.click(); await sleep(1800);
      "viewer open";`
  },
  {
    // Recording a voice memory: the dialog before the first press.
    name: "38-gallery-recording",
    url: "gallery",
    state: "a photo you can edit",
    setup: `
      const tile = [...document.querySelectorAll('button[aria-label^="Open "]')]
        .find((b) => /\.(jpe?g|png|webp|heic)$/i.test(b.getAttribute("aria-label")));
      if (!tile) return "no photo tile on the Gallery page";
      tile.click(); await sleep(1800);
      const record = document.querySelector(".voice-notes-head button");
      if (!record) return "no Record button — no edit right, or not a secure context";
      record.click(); await sleep(700);
      "recording dialog";`
  },
  {
    // A book's address carries its id, so walk in from the shelf. Needs the
    // editions to have been grouped by hand first — the switcher only appears on
    // a book that belongs to a work.
    name: "37-book-editions",
    url: "ebooks",
    state: "a book grouped into an edition set",
    setup: `
      const card = [...document.querySelectorAll("article.audiobook-catalog-card")]
        .find((el) => el.textContent.includes("Alice"));
      if (!card) return "no Alice card on the shelf";
      card.querySelector(".audiobook-catalog-cover")?.click();
      await sleep(2200);
      const heading = [...document.querySelectorAll("h2, h3")]
        .find((el) => el.textContent.trim().startsWith("Editions"));
      if (!heading) return "this book is not part of an edition set";
      let node = heading.parentElement;
      let scroller = null;
      while (node) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) { scroller = node; break; }
        node = node.parentElement;
      }
      const target = scroller ?? document.scrollingElement;
      target.scrollTop += heading.getBoundingClientRect().top
        - (scroller ? scroller.getBoundingClientRect().top : 0) - 220;
      await sleep(900);
      "editions in view";`
  },
  {
    // The link half of sharing, which works on a server with one account — the
    // People half needs somebody to send to. Deliberately captured BEFORE a link
    // is created: the panel says a link is shown once and never again, and a
    // screenshot is a poor place to put a working token, even a revocable one
    // for a book everybody can read anyway.
    // The people half of the same dialog. Needs somebody else on the server: with
    // one account it says "There is nobody else on this server yet", which
    // documents the empty case rather than the feature.
    name: "43-share-people",
    url: "ebooks",
    state: "a second account",
    setup: `
      const card = [...document.querySelectorAll("article.audiobook-catalog-card")]
        .find((el) => el.textContent.includes("Dracula"));
      if (!card) return "no Dracula on the shelf";
      card.querySelector(".audiobook-catalog-cover")?.click();
      await sleep(2200);
      button(document, "Send to")?.click();
      await sleep(1500);
      const people = button(topModal(), "People");
      if (!people) return "no People choice";
      people.click();
      await sleep(1600);
      "people picker";`
  },
  {
    name: "42-share-link",
    url: "ebooks",
    setup: `
      const card = [...document.querySelectorAll("article.audiobook-catalog-card")]
        .find((el) => el.textContent.includes("Dracula"));
      if (!card) return "no Dracula on the shelf";
      card.querySelector(".audiobook-catalog-cover")?.click();
      await sleep(2200);
      const send = button(document, "Send to");
      if (!send) return "no Send to button";
      send.click();
      await sleep(1500);
      const link = button(topModal(), "Share link");
      if (!link) return "no Share link choice";
      link.click();
      await sleep(1800);
      "share link panel";`
  },
  { name: "40-family-tree", url: "family" },
  {
    // A profile's address carries the person's id, so pick them off the People
    // list by name. Margaret has parents, a husband and three children, so the
    // Relationships tab the guide describes is not a row of empty headings.
    name: "41-family-person",
    url: "family/people",
    state: "a family tree with relationships",
    setup: `
      const link = [...document.querySelectorAll("a")].find((el) =>
        /\\/family\\/people\\/[^/]+$/.test(el.getAttribute("href") ?? "")
        && el.textContent.includes("Margaret Ellis"));
      if (!link) return "no profile link for Margaret Ellis";
      link.click();
      await sleep(2200);
      "profile open";`
  },

  // Every control-panel tab is a real route (features/control/nav.ts), so this is a
  // plain navigation — it used to click an "Email" tab inside /control/config, which
  // stopped existing when those tabs became routes. Captured on an install where
  // SMTP is filled in: an empty form documents nothing.
  {
    name: "50-email",
    url: "control/settings/email",
    state: "email settings filled in"
  },

  // The control panel and the user's own pages. These need a library with some
  // history behind it — an install with nothing in it photographs as empty boxes.
  { name: "60-dashboard", url: "control", state: "libraries scanned" },
  { name: "61-duplicate-cleanup", url: "control/utilities/duplicate-cleanup", state: "a cleanup job in review" },
  {
    // The header shot above says what the scan found; this one shows a result
    // card, which is the thing the guide spends most of its length explaining —
    // what was matched, which copy is kept and why, and the three buttons.
    name: "68-duplicate-result",
    url: "control/utilities/duplicate-cleanup",
    state: "a cleanup job in review",
    wait: 4000,
    setup: `
      const heading = [...document.querySelectorAll("h2, h3")]
        .find((el) => /identical|near|same/i.test(el.textContent));
      if (!heading) return "no results section";
      let node = heading.parentElement;
      let scroller = null;
      while (node) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) { scroller = node; break; }
        node = node.parentElement;
      }
      const target = scroller ?? document.scrollingElement;
      target.scrollTop += heading.getBoundingClientRect().top
        - (scroller ? scroller.getBoundingClientRect().top : 0) - 60;
      await sleep(1400);
      \`at \${heading.textContent.trim()}\`;`
  },
  // The bin shows whatever was last deleted, which is not necessarily something
  // fit to publish — the first attempt caught a copyrighted audiobook somebody had
  // been testing with. Empty it, delete one demo item, then capture. Delete a copy
  // out of Photos/Re-saved: those exist only to be duplicates, so the library
  // loses nothing, and removing one is the flow duplicate-cleanup.md describes.
  { name: "62-recycle-bin", url: "control/maintenance/recycle-bin", state: "only demo content in the bin" },
  // Taller than the default: each schedule row carries its retention under the
  // time now, and the count for database copies sits under both.
  { name: "63-backup", url: "control/maintenance/backup", height: 1260 },
  { name: "64-security-overview", url: "control/security" },
  { name: "65-members", url: "control/members" },
  { name: "66-groups", url: "control/members/groups", state: "at least one group" },
  { name: "67-invites", url: "control/members/invites", state: "an unused invite" },

  // Quotes. Both need a pack imported — an empty Quotes page is an empty box, and
  // the manage page has nothing to list until an import has actually been run.
  { name: "80-quotes", url: "quotes", state: "a quote pack imported" },
  { name: "81-quotes-import", url: "control/utilities/quotes", state: "a quote pack imported" },

  // The Photo Inbox (docs/users/photo-inbox.md). Needs an Inbox library with a
  // delivery or two, its copy check run, and a drop link out — the demo data the
  // guide describes.
  { name: "82-photo-inbox", url: "gallery/inbox", state: "an Inbox with deliveries and a finished check" },
  {
    name: "83-photo-inbox-keep",
    url: "gallery/inbox",
    state: "an Inbox with photos",
    setup: `
      const start = button(document, "Select");
      if (!start) return "no Select button — page not ready, or too narrow for the toolbar";
      start.click(); await sleep(500);
      // Each tile is its own button in selection mode; the class it used to be
      // found by is long gone, and a stale selector selects nothing silently.
      const tiles = [...document.querySelectorAll('button[aria-label^="Select "]')];
      tiles[0]?.click(); tiles[1]?.click(); await sleep(400);
      const keep = button(document, "Keep");
      if (!keep) return "nothing selected — no Keep button";
      keep.click(); await sleep(900);
      "keep dialog";`
  },
  {
    // The other half of the same dialog: the folders the destination already has.
    name: "89-inbox-keep-existing",
    url: "gallery/inbox",
    state: "an Inbox with photos, and a library with folders",
    setup: `
      const start = button(document, "Select");
      if (!start) return "no Select button — page not ready, or too narrow for the toolbar";
      start.click(); await sleep(500);
      const tiles = [...document.querySelectorAll('button[aria-label^="Select "]')];
      tiles[0]?.click(); await sleep(400);
      const keep = button(document, "Keep");
      if (!keep) return "nothing selected — no Keep button";
      keep.click(); await sleep(900);
      const tab = [...topModal().querySelectorAll("button")]
        .find((b) => b.textContent.trim().startsWith("Use existing"));
      if (!tab) return "no existing-folder tab";
      tab.click(); await sleep(1200);
      "existing folders";`
  },
  {
    name: "84-inbox-check-results",
    url: "control/utilities/duplicate-cleanup",
    state: "an Inbox check in review",
    height: 1000
  },
  {
    // Scrolled to the near-identical section: a set where the incoming scan is a
    // different file from the library's, with Replace on offer.
    name: "88-inbox-check-near",
    url: "control/utilities/duplicate-cleanup",
    state: "an Inbox check in review with a near-identical set",
    setup: `
      const heading = [...document.querySelectorAll("h2, h3")]
        .find((el) => el.textContent.trim().startsWith("Near-identical"));
      if (!heading) return "no near-identical section";
      heading.scrollIntoView({ block: "start" }); await sleep(600);
      "near section";`
  },
  {
    name: "85-inbox-drop-links",
    url: "gallery/inbox",
    state: "an Inbox with a drop link out",
    setup: `button(document, "Drop link").click(); await sleep(900); "drop links";`
  },
  {
    name: "86-drop-page",
    url: process.env.DROP_TOKEN ? `drop/${process.env.DROP_TOKEN}` : "drop/none",
    auth: false,
    state: "a live drop link (DROP_TOKEN)",
    height: 560
  },
  {
    // The edit dialog opens on its Access tab, where the Photo Inbox switch lives.
    name: "87-library-inbox-switch",
    url: "control/libraries",
    state: "a gallery library named Photo Inbox",
    setup: `
      const edit = [...document.querySelectorAll("button[aria-label]")]
        .find((b) => b.getAttribute("aria-label") === "Edit Photo Inbox");
      if (!edit) return "no Photo Inbox row";
      edit.click(); await sleep(900);
      // The switch is the last row of the Access tab; scroll the dialog to it.
      const pane = [...topModal().querySelectorAll("*")]
        .find((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== "visible");
      if (pane) { pane.scrollTop = pane.scrollHeight; await sleep(400); }
      "edit dialog";`,
    height: 1000
  },

  // Stories. A story's address contains its id, which differs on every install,
  // so these open the index and click through by title rather than deep-linking
  // — otherwise the shots would only reproduce on the machine they were taken on.
  { name: "90-stories", url: "stories", state: "some published stories" },
  // The New story dialog with a recipe chosen: the five kinds, the front page
  // being named, and the recipe card underneath (serves, time, From a link).
  // Filled in by hand rather than read from a link, so the shot needs no
  // internet and shows the fields rather than a fetched result.
  {
    name: "95-story-new",
    url: "stories",
    height: 960,
    setup: `
      const open = button(document, "New story");
      if (!open) return "no New story button";
      open.click();
      await sleep(900);
      const modal = topModal();
      const recipe = [...modal.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Recipe"));
      if (!recipe) return "no Recipe kind";
      recipe.click();
      await sleep(400);
      setInput(modal.querySelector(".story-new-story-title"), "Draniki");
      setInput(modal.querySelector(".story-new-story-subtitle"), "Grandma Zina’s potato pancakes, the Sunday ones");
      const fields = [...modal.querySelectorAll("label.field")];
      const byLabel = (text) => fields.find((l) => l.textContent.trim().startsWith(text))?.querySelector("input");
      setInput(byLabel("Date"), "1978");
      setInput(byLabel("Place"), "Vitebsk");
      setInput(byLabel("Serves"), "4–6");
      setInput(byLabel("Total time"), "45");
      await sleep(400);
      "new story open";`
  },
  {
    name: "91-story",
    url: "stories",
    state: "a story called \"Alps in summer\"",
    // A story card is an <a href="/stories/:id">, but its text begins with the
    // status badge — so match the href shape and look for the title anywhere
    // inside, rather than at the start.
    setup: `
      const link = [...document.querySelectorAll("a")].find((el) =>
        /^\\/stories\\/[^/]+$/.test(el.getAttribute("href") ?? "")
        && el.textContent.includes("Alps in summer"));
      if (!link) return "no story card for Alps in summer";
      link.click();
      await sleep(2000);
      "opened";`
  },
  // The editor's two dialogs. Both walk in from the index for the same reason the
  // shots above do — every address inside a story carries its id. The story's id
  // is read off its card at run time and used to find the matching Edit link,
  // rather than being written into the URL here.
  {
    name: "93-story-add-block",
    url: "stories",
    state: "a story with chapters",
    setup: `
      const card = [...document.querySelectorAll("a")].find((el) =>
        /^\\/stories\\/[^/]+$/.test(el.getAttribute("href") ?? "")
        && el.textContent.includes("Alps in summer"));
      if (!card) return "no story card for Alps in summer";
      const id = card.getAttribute("href").split("/").pop();
      document.querySelector(\`a[href="/stories/\${id}/edit"]\`)?.click();
      await sleep(2200);
      const chapter = [...document.querySelectorAll("a")]
        .find((el) => /\\/edit\\/chapters\\//.test(el.getAttribute("href") ?? ""));
      if (!chapter) return "no chapter link";
      chapter.click();
      await sleep(2000);
      const add = button(document, "Add block");
      if (!add) return "no Add block button";
      add.click();
      await sleep(1200);
      "add block open";`
  },
  {
    name: "94-story-map-block",
    url: "stories",
    state: "a story with chapters",
    setup: `
      const card = [...document.querySelectorAll("a")].find((el) =>
        /^\\/stories\\/[^/]+$/.test(el.getAttribute("href") ?? "")
        && el.textContent.includes("Alps in summer"));
      if (!card) return "no story card for Alps in summer";
      const id = card.getAttribute("href").split("/").pop();
      document.querySelector(\`a[href="/stories/\${id}/edit"]\`)?.click();
      await sleep(2200);
      [...document.querySelectorAll("a")]
        .find((el) => /\\/edit\\/chapters\\//.test(el.getAttribute("href") ?? ""))?.click();
      await sleep(2000);
      button(document, "Add block")?.click();
      await sleep(1200);
      const map = button(topModal(), "Map");
      if (!map) return "no Map choice in the Add block dialog";
      map.click();
      // The picker mounts a Leaflet map and fetches its tiles; give them time to
      // paint or the shot is a grey square where the map should be.
      await sleep(3500);

      // Drop two stops so the picker shows what it is for — with none, it is an
      // empty world map and the route it draws between stops never appears.
      // Clicking the map adds a stop, which needs no network; searching for a
      // place would call OpenStreetMap and make the shot depend on the internet.
      const canvas = document.querySelector(".leaflet-container");
      if (!canvas) return "no map canvas";
      const box = canvas.getBoundingClientRect();
      const tap = (fx, fy) => {
        const clientX = box.left + box.width * fx;
        const clientY = box.top + box.height * fy;
        for (const type of ["mousedown", "mouseup", "click"]) {
          canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY, view: window }));
        }
      };
      tap(0.52, 0.34);
      await sleep(1200);
      tap(0.58, 0.42);
      await sleep(1600);
      \`\${topModal().textContent.match(/\\d+ stops?/)?.[0] ?? "no stop count"}\`;`
  },
  {
    name: "92-story-collection",
    url: "stories",
    state: "a story collection called \"Reviews\"",
    setup: `
      const link = [...document.querySelectorAll("a")]
        .find((el) => el.textContent.trim().startsWith("Reviews"));
      if (!link) return "no collection called Reviews";
      link.click();
      await sleep(1800);
      "opened";`
  },

  { name: "70-profile", url: "profile" },
  { name: "71-profile-security", url: "profile/security" },
  { name: "72-profile-appearance", url: "profile/appearance" },
  { name: "73-profile-devices", url: "profile/devices" },
  {
    // The two-factor card sits below the fold on Security. Scroll to it rather
    // than photographing the enrolment step — that screen shows a live TOTP
    // secret and its QR code, which is not something to publish in a guide even
    // from a throwaway install.
    name: "74-two-factor",
    url: "profile/security",
    setup: `
      const heading = [...document.querySelectorAll("h2, h3")]
        .find((el) => el.textContent.trim().startsWith("Two-factor"));
      if (!heading) return "no two-factor heading";
      // The app scrolls an inner element, not the window, so window.scrollBy does
      // almost nothing here — walk up to whichever ancestor actually scrolls.
      let node = heading.parentElement;
      let scroller = null;
      while (node) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
          scroller = node;
          break;
        }
        node = node.parentElement;
      }
      const target = scroller ?? document.scrollingElement;
      const offset = heading.getBoundingClientRect().top
        - (scroller ? scroller.getBoundingClientRect().top : 0);
      target.scrollTop += offset - 70;
      await sleep(800);
      \`scrolled \${Math.round(target.scrollTop)}px in \${scroller ? "a panel" : "the window"}\`;`
  },
  // Photo review (docs/photo-review-plan.md) and For you (docs/for-you-plan.md).
  // Review mode is reached from the Inbox page's "One at a time"; the shot
  // wants an Inbox with a delivery, the same demo data as 82-89.
  {
    name: "96-review-mode",
    url: "gallery/inbox",
    state: "an Inbox with photos",
    setup: `
      const go = button(document, "One at a time");
      if (!go) return "no One at a time button — no Inbox, or no edit right";
      go.click(); await sleep(1800);
      "review mode";`
  },
  { name: "97-for-you", url: "for-you", state: "something waiting: a delivery or a sent card" },
  {
    // "Ask someone" over a selection on the Timeline: the dialog that names the album.
    name: "99-ask-someone",
    url: "gallery",
    state: "a gallery with photos",
    setup: `
      const start = button(document, "Select");
      if (!start) return "no Select button — page not ready, or too narrow for the toolbar";
      start.click(); await sleep(500);
      const tiles = [...document.querySelectorAll('button[aria-label^="Select "]')];
      tiles[0]?.click(); tiles[1]?.click(); tiles[2]?.click(); await sleep(400);
      const ask = button(document, "Ask someone");
      if (!ask) return "nothing selected — no Ask someone button";
      ask.click(); await sleep(900);
      "ask someone dialog";`
  },
  {
    // Send to on an album, at the compose step, with the question ticked.
    name: "100-send-ask-notes",
    url: "gallery/albums",
    state: "an album you made, and another member to send to",
    setup: `
      const tile = document.querySelector(".gallery-folder-tile");
      if (!tile) return "no album tile";
      tile.click(); await sleep(1200);
      // The album header's Send to is icon-only: found by its title, not its text.
      const send = [...document.querySelectorAll("button")]
        .find((b) => (b.title || b.getAttribute("aria-label") || "").startsWith("Send to"));
      if (!send) return "no Send to button";
      send.click(); await sleep(1000);
      const person = topModal().querySelector(".send-to-person");
      if (!person) return "nobody to send to";
      person.click(); await sleep(300);
      const next = [...topModal().querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Send to 1"));
      if (!next) return "no Send to 1 person button";
      next.click(); await sleep(700);
      const ask = topModal().querySelector(".send-to-ask input");
      if (!ask) return "no Ask what they remember box — not the album's creator?";
      ask.click(); await sleep(300);
      "compose with the question";`
  },

  // App storage (docs/app-storage-plan.md): a room's chooser, and the box that
  // confirms a change with the exact folder before anything happens.
  {
    name: "101-storage-room-chooser",
    url: "control/libraries/storage",
    state: "App storage chosen",
    setup: `
      const row = [...document.querySelectorAll(".app-storage-rooms tr")].find((tr) => tr.textContent.includes("Renders"));
      const change = row && button(row, "Change");
      if (!change) return "no Renders row";
      change.click(); await sleep(500);
      "chooser open";`
  },
  {
    name: "102-storage-room-confirm",
    url: "control/libraries/storage",
    state: "App storage chosen, the Recycle Bin not yet in it",
    setup: `
      const row = [...document.querySelectorAll(".app-storage-rooms tr")].find((tr) => tr.textContent.includes("Recycle Bin"));
      const change = row && button(row, "Change");
      if (!change) return "no Recycle Bin row";
      change.click(); await sleep(500);
      // Whatever the bin uses now, pick the other of App storage / own .trash so
      // Continue has something to confirm.
      const modal = topModal();
      const radios = [...modal.querySelectorAll('input[type="radio"]')];
      const target = radios.find((r) => r.value === "app" && !r.checked && !r.disabled) ?? radios.find((r) => r.value === "off" && !r.checked);
      if (!target) return "no other option to pick";
      target.click(); await sleep(200);
      button(modal, "Continue").click(); await sleep(500);
      "confirmation open";`
  },
  {
    // A library room's "A library of my own": the chooser with the library list.
    name: "105-storage-own-library",
    url: "control/libraries/storage",
    state: "at least two gallery libraries",
    setup: `
      const row = [...document.querySelectorAll(".app-storage-rooms tr")].find((tr) => tr.textContent.includes("App files"));
      const change = row && button(row, "Change");
      if (!change) return "no App files row";
      change.click(); await sleep(500);
      const own = [...topModal().querySelectorAll('input[type="radio"]')].find((r) => r.value === "own");
      if (!own) return "no own option";
      own.click(); await sleep(400);
      "library picker";`
  },
  {
    // Changing the App storage folder while rooms use it: the confirmation with
    // a tick per room (carry it along, or leave it where it is).
    name: "106-storage-folder-change",
    url: "control/libraries/storage",
    state: "App storage chosen, at least one room using it, a second container with a plain folder",
    setup: `
      button(document.querySelector(".app-storage-buttons"), "Change").click(); await sleep(800);
      const picker = topModal();
      const select = picker.querySelector("select");
      const other = [...select.options].find((o) => o.value !== select.value);
      if (!other) return "no second container";
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, other.value);
      select.dispatchEvent(new Event("change", { bubbles: true })); await sleep(1000);
      const folder = [...picker.querySelectorAll("button")].find((b) => b.textContent.trim() === "test");
      if (!folder) return "no test folder in the other container";
      folder.click(); await sleep(1000);
      button(picker, "Use this folder").click(); await sleep(600);
      "confirmation open";`
  },
  {
    // The Contents page beside Storage: rooms with sizes, App files by folder.
    name: "107-storage-contents",
    url: "control/libraries/storage/contents",
    state: "App storage chosen, an App files library with something in it",
    height: 1100
  },
  // Maps (docs/users/control-panel.md → Maps, library-gallery.md, first-run.md).
  { name: "108-maps-setup", url: "control/maps", wait: 3500, height: 1500 },
  { name: "111-gallery-places", url: "gallery/places", wait: 4000, state: "named places built, photos with GPS" },
  {
    // The viewer's Map tab: the pin, and the town the photo was taken in.
    name: "112-lightbox-named-place",
    url: "gallery/places",
    wait: 4000,
    state: "named places built, photos with GPS",
    setup: `
      const place = document.querySelector(".gallery-places-country .gallery-folder-tile");
      if (!place) return "no place on the Places view";
      place.click(); await sleep(2500);
      const tile = [...document.querySelectorAll('button[aria-label^="Open "]')]
        .find((b) => /\\.(jpe?g|png|webp|heic)$/i.test(b.getAttribute("aria-label")));
      if (!tile) return "no photo tile for that place";
      tile.click(); await sleep(1800);
      const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.trim() === "Map");
      if (!tab) return "no Map tab";
      tab.click(); await sleep(3500);
      "map tab open";`
  },
  {
    name: "113-welcome-maps",
    url: "welcome",
    height: 1500,
    setup: `
      const step = [...document.querySelectorAll(".welcome-step")].find((b) => b.textContent.includes("Maps"));
      if (!step) return "no Maps step";
      step.click(); await sleep(1200);
      "maps step";`
  },
  // The setup guide's storage and App files steps (docs/users/first-run.md).
  { name: "103-welcome-storage", url: "welcome", height: 1000 },
  {
    name: "104-welcome-gallery",
    url: "welcome",
    setup: `
      const step = [...document.querySelectorAll(".welcome-step")].find((b) => b.textContent.includes("App files"));
      if (!step) return "no App files step";
      step.click(); await sleep(400);
      "gallery step";`
  }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sharp ships with the server workspace; if it can't be loaded the raw capture
// is written unchanged rather than failing the run.
async function compress(buffer) {
  try {
    const require = createRequire(import.meta.url);
    const sharp = require("sharp");
    const out = await sharp(buffer).png({ palette: true, quality: 82, effort: 9 }).toBuffer();
    return out.length < buffer.length ? out : buffer;
  } catch {
    return buffer;
  }
}

function findBrowser() {
  const candidates = process.platform === "win32"
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  const found = [process.env.CHROME_PATH, ...candidates].find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found — set CHROME_PATH to the executable.");
  return found;
}

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); resolve(true); });
  socket.on("error", () => resolve(false));
});

async function launch() {
  if (await portOpen(PORT)) return null;
  const child = spawn(findBrowser(), [
    `--remote-debugging-port=${PORT}`,
    "--headless=new",
    // Maps draw with WebGL (MapLibre). Headless has no GPU, and Chrome no longer
    // falls back to software rendering unless told to — without these two every
    // map in a screenshot is a blank box.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${path.join(process.env.TEMP ?? "/tmp", "isputnik-doc-shots")}`,
    "about:blank"
  ], { stdio: "ignore" });
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await portOpen(PORT)) return child;
  }
  throw new Error("the browser never opened its debugging port");
}

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
  });
}

// A short-lived session for an existing admin. Nothing is created but the row,
// and it is removed in the finally block below.
function mintSession() {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database at ${DB_PATH}`);
  const db = new Database(DB_PATH);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1").get();
  if (!admin) throw new Error("No admin account — complete first-run setup before capturing screenshots.");
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, device_name)
    VALUES (?, ?, ?, ?, 'doc-screenshots')
  `).run(
    `doc-shots-${Date.now()}`,
    crypto.createHash("sha256").update(token).digest("hex"),
    admin.id,
    new Date(Date.now() + 3600_000).toISOString()
  );
  return {
    token,
    release: () => {
      db.prepare("DELETE FROM sessions WHERE device_name = 'doc-screenshots'").run();
      db.close();
    }
  };
}

async function main() {
  const filters = process.argv.slice(2);
  const wanted = SHOTS.filter((shot) => (
    filters.length > 0 ? filters.some((f) => shot.name.includes(f)) : !shot.state
  ));
  if (wanted.length === 0) {
    console.error(`Nothing matched. Available:\n  ${SHOTS.map((s) => s.name).join("\n  ")}`);
    process.exit(1);
  }

  const health = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!health) throw new Error(`${BASE} is not responding — is \`npm run dev\` running?`);

  // Only needed for authenticated pages — the first-run and sign-in shots are
  // captured against an install that has no accounts to sign in as.
  const session = wanted.some((shot) => shot.auth !== false) ? mintSession() : null;
  const browser = await launch();
  let ws;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page")
      ?? (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json());

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

    await send(ws, "Page.enable");
    await send(ws, "Network.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
    });

    // The guides in docs/users/ are English, so the screenshots have to be too —
    // on any machine. Two things decide the language and both are pinned here:
    //
    //   * the app boots in localStorage's `isputnik-language`, falling back to the
    //     browser's own on a first visit, so a Russian-locale machine would
    //     otherwise capture a Russian UI. Seed the preference in a script that runs
    //     before any page script, on every document.
    //   * dates and numbers come from Intl, which reads the browser locale rather
    //     than the app's setting — so override that too, or a screenshot shows an
    //     English UI with dates formatted for somewhere else.
    await send(ws, "Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => {});
    await send(ws, "Page.addScriptToEvaluateOnNewDocument", {
      source: 'try { localStorage.setItem("isputnik-language", "en"); } catch { /* private mode */ }'
    });

    fs.mkdirSync(OUT, { recursive: true });
    for (const shot of wanted) {
      const { hostname } = new URL(BASE);
      await send(ws, "Network.deleteCookies", { name: "isputnik_sid", domain: hostname, path: "/" }).catch(() => {});
      if (shot.auth !== false) {
        await send(ws, "Network.setCookie", {
          name: "isputnik_sid", value: session.token, domain: hostname, path: "/", httpOnly: true
        });
      }

      await send(ws, "Emulation.setDeviceMetricsOverride", {
        width: WIDTH, height: shot.height ?? HEIGHT, deviceScaleFactor: 1, mobile: false
      });
      await send(ws, "Page.navigate", { url: `${BASE}/${shot.url}` });
      await sleep(shot.wait ?? 3000);

      if (shot.setup) {
        const result = await send(ws, "Runtime.evaluate", {
          expression: `(async () => {${HELPERS}${shot.setup}})()`,
          awaitPromise: true,
          returnByValue: true
        });
        if (result.exceptionDetails) console.warn(`  ${shot.name}: setup failed — ${result.exceptionDetails.text}`);
        await sleep(1200);
      }

      const { data } = await send(ws, "Page.captureScreenshot", { format: "png" });
      const file = path.join(OUT, `${shot.name}.png`);
      const raw = Buffer.from(data, "base64");
      // Screenshots are flat UI colour, so a quantised palette is visually
      // identical at roughly a fifth of the size — worth it for files that live
      // in git history forever.
      const png = await compress(raw);
      fs.writeFileSync(file, png);
      console.log(`${shot.name}  ${Math.round(png.length / 1024)} KB`
        + (png.length < raw.length ? ` (from ${Math.round(raw.length / 1024)} KB)` : ""));
    }

    console.log(`\n${wanted.length} screenshot(s) written to docs/users/images.`);
  } finally {
    ws?.close();
    session?.release();
    browser?.kill();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
