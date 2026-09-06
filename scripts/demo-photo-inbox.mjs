// Demo data for the Photo Inbox guide screenshots (docs/users/photo-inbox.md,
// shots 82-88 in doc-screenshots.mjs). Paths are the demo install's: a gallery
// library at D:/Demo/media/Photos with the 2023 Lake District walk, and an Inbox
// folder it creates at D:/Demo/media/Photo Inbox. Needs `npm run dev` running.
//
//   node scripts/demo-photo-inbox.mjs
//
// Prints the Inbox id and the drop-link token; pass the token as DROP_TOKEN to
// doc-screenshots.mjs for shot 86. Revoke the link afterwards.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const ROOT = "D:/MyProjects/Web/isputnik.home";
const DB_PATH = path.join(ROOT, "data/db/isputnik.sqlite");
const API = "http://127.0.0.1:4000";
const LIB_ROOT = "D:/Demo/media/Photos";
const INBOX_ROOT = "D:/Demo/media/Photo Inbox";
const WALK = path.join(LIB_ROOT, "2023/2023-05 Lake District walk");

const require = createRequire(path.join(ROOT, "apps/server/package.json"));
const sharp = require("sharp");
const Database = require("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Files ───────────────────────────────────────────────────────────────────
const box = path.join(INBOX_ROOT, "Grandma's box");
const scanner = path.join(INBOX_ROOT, "Scanner");
fs.mkdirSync(box, { recursive: true });
fs.mkdirSync(scanner, { recursive: true });
const src = (n) => path.join(WALK, `${n}.jpg`);

// Identical copies: the check finds them as certain.
fs.copyFileSync(src("01"), path.join(box, "scan 001.jpg"));
fs.copyFileSync(src("02"), path.join(box, "scan 002.jpg"));
// A smaller re-scan: near-identical, worse than the library's — Discard.
await sharp(src("04")).resize({ width: 900 }).jpeg({ quality: 82 }).toFile(path.join(box, "scan 004.jpg"));
// A larger re-scan: near-identical, better than the library's — Replace.
await sharp(src("05")).resize({ width: 2700 }).jpeg({ quality: 90 }).toFile(path.join(box, "scan 005.jpg"));
// Fed in sideways: only the rotated fingerprints find it.
await sharp(src("06")).rotate(90).resize({ width: 1200 }).jpeg({ quality: 85 }).toFile(path.join(box, "scan 006.jpg"));
// Something the library does not have: a tight crop reads as a different picture.
await sharp(src("07")).extract({ left: 200, top: 150, width: 700, height: 500 }).jpeg({ quality: 85 }).toFile(path.join(box, "scan 007.jpg"));
// The scanner delivery: one identical, one new.
fs.copyFileSync(src("08"), path.join(scanner, "IMG_0008.jpg"));
await sharp(src("03")).extract({ left: 100, top: 100, width: 800, height: 600 }).jpeg({ quality: 85 }).toFile(path.join(scanner, "IMG_0009.jpg"));
console.log("files ready");

// ── Session ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1").get();
const token = crypto.randomBytes(24).toString("hex");
db.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, device_name) VALUES (?, ?, ?, ?, 'inbox-demo')")
  .run(`inbox-demo-${Date.now()}`, crypto.createHash("sha256").update(token).digest("hex"), admin.id, new Date(Date.now() + 3600_000).toISOString());

// The demo cleanup from the screenshot session holds the one active slot; the
// Inbox check needs it. Finishing it is what the page's Finish button does.
db.prepare("UPDATE duplicate_jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('draft','review','paused') AND inbox_library_id IS NULL").run();

let csrf = "";
const call = async (method, url, body) => {
  const headers = { cookie: `isputnik_sid=${token}${csrf ? `; isputnik_csrf=${csrf}` : ""}` };
  if (csrf) headers["x-csrf-token"] = csrf;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${url}`, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = /isputnik_csrf=([^;]+)/.exec(setCookie);
  if (m) csrf = m[1];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
};

try {
  await call("GET", "/api/auth/me");
  const created = await call("POST", "/api/library/gallery-libraries", {
    name: "Photo Inbox", sourcePath: INBOX_ROOT, inbox: true, visibility: "public", publicRole: "member", mode: "managed"
  });
  const inboxId = created.library.id;
  console.log("inbox", inboxId);

  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    const libs = await call("GET", "/api/library/gallery-libraries?manage=1");
    const me = libs.libraries.find((l) => l.id === inboxId);
    if (me && me.scanStatus === "idle" && me.bookCount >= 8) break;
  }
  console.log("scanned");

  for (let i = 0; i < 180; i += 1) {
    await sleep(1000);
    const check = await call("GET", `/api/library/gallery/inbox/${inboxId}/check`);
    if (check.check && (check.check.status === "review" || check.check.status === "failed")) { console.log("check", check.check); break; }
    if (!check.check && i === 5) { console.log("check not queued; starting"); await call("POST", `/api/library/gallery/inbox/${inboxId}/check`, {}); }
  }

  const link = await call("POST", `/api/library/gallery/inbox/${inboxId}/drop-links`, {
    label: "Cousin Anna", expiresInDays: 14, maxFiles: 200, maxMB: 2048, oneTime: false
  });
  const dropToken = link.url.split("/drop/")[1];
  console.log("drop link", link.url);

  // A real delivery through the public route: the CSRF cookie from the page's
  // GET, then the multipart POST, exactly as the drop page does it.
  const pub = await fetch(`${API}/api/drop/${dropToken}`);
  const pubCookie = /isputnik_csrf=([^;]+)/.exec(pub.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const form = new FormData();
  for (const [name, file] of [["anna 01.jpg", src("06")], ["anna 02.jpg", src("07")]]) {
    form.append("file", new Blob([fs.readFileSync(file)], { type: "image/jpeg" }), name);
  }
  const drop = await fetch(`${API}/api/drop/${dropToken}/upload`, {
    method: "POST",
    headers: { cookie: `isputnik_csrf=${pubCookie}`, "x-csrf-token": pubCookie },
    body: form
  });
  console.log("drop upload", drop.status, await drop.text());

  await sleep(4000);
  console.log("check after drop", (await call("GET", `/api/library/gallery/inbox/${inboxId}/check`)).check);
  console.log(JSON.stringify({ inboxId, dropToken }));
} finally {
  db.prepare("DELETE FROM sessions WHERE device_name = 'inbox-demo'").run();
  db.close();
}
