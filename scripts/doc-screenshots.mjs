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
// and are skipped unless named explicitly.
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
  // been testing with. Empty it, delete one demo item, then capture.
  { name: "62-recycle-bin", url: "control/maintenance/recycle-bin", state: "only demo content in the bin" },
  { name: "63-backup", url: "control/maintenance/backup" },
  { name: "64-security-overview", url: "control/security" },
  { name: "65-members", url: "control/members" },
  { name: "66-groups", url: "control/members/groups", state: "at least one group" },
  { name: "67-invites", url: "control/members/invites", state: "an unused invite" },

  // Quotes. Both need a pack imported — an empty Quotes page is an empty box, and
  // the manage page has nothing to list until an import has actually been run.
  { name: "80-quotes", url: "quotes", state: "a quote pack imported" },
  { name: "81-quotes-import", url: "control/utilities/quotes", state: "a quote pack imported" },

  // Stories. A story's address contains its id, which differs on every install,
  // so these open the index and click through by title rather than deep-linking
  // — otherwise the shots would only reproduce on the machine they were taken on.
  { name: "90-stories", url: "stories", state: "some published stories" },
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
    "--disable-gpu",
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
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
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
