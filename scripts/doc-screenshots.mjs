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
      const folder = [...topModal().querySelectorAll("button")].find((b) => b.textContent.trim() === "Audio");
      if (!folder) return "no Audio folder";
      folder.click(); await sleep(900);
      button(topModal(), "Use this folder").click(); await sleep(700);
      button(topModal(), "Next").click(); await sleep(900);
      "review";`
  },
  { name: "21-libraries-list", url: "control/libraries" },

  { name: "30-audiobooks", url: "audiobooks" },
  { name: "31-ebooks", url: "ebooks" },
  { name: "32-gallery", url: "gallery" },
  { name: "40-family-tree", url: "family" }
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
