#!/usr/bin/env node
// Photo Sync phase 0: turns the WebDAV spike's request log into the answers the
// plan is waiting on (docs/photo-sync-plan.md, "Open questions" and Roadmap 0).
//
//   node scripts/photo-sync-spike-report.mjs [path/to/requests.jsonl]
//
// Default log: data/photo-sync-spike/requests.jsonl (the spike's default folder).
// Clients are told apart by User-Agent and address; the user names each one
// signed in with are listed, so give each phone its own.
import fs from "node:fs";
import path from "node:path";

const candidates = [
  process.argv[2],
  "data/photo-sync-spike/requests.jsonl",
  "apps/server/data/photo-sync-spike/requests.jsonl"
].filter(Boolean);
const logPath = candidates.find((p) => fs.existsSync(p));
if (!logPath) {
  console.error(`No spike log found (looked for ${candidates.join(", ")}).`);
  process.exit(1);
}

const entries = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
console.log(`${entries.length} requests in ${path.resolve(logPath)}\n`);

const clientKey = (e) => `${e.headers?.["user-agent"] ?? "(no user agent)"}  [from ${e.ip}]`;
const groups = new Map();
for (const e of entries) {
  const key = clientKey(e);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}

const count = (items, keyOf) => {
  const map = new Map();
  for (const item of items) map.set(keyOf(item), (map.get(keyOf(item)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const STANDARD_HEADERS = new Set([
  "host", "user-agent", "accept", "accept-encoding", "accept-language", "connection", "content-length",
  "content-type", "authorization", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
  "cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor", "cdn-loop", "expect", "transfer-encoding"
]);
const CHUNK_HINT = /chunk|part|upload-?id|content-range|oc-chunk|tus|offset/i;

for (const [client, list] of groups) {
  console.log("=".repeat(100));
  console.log(client);
  console.log("=".repeat(100));
  const first = list[0];
  console.log(`From ${first.at} to ${list.at(-1).at}, ${list.length} requests, user names: ${[...new Set(list.map((e) => e.user).filter(Boolean))].join(", ") || "(none)"}`);

  console.log("\nMethods → statuses:");
  for (const [method, n] of count(list, (e) => e.method)) {
    const statuses = count(list.filter((e) => e.method === method), (e) => e.status).map(([s, c]) => `${s}×${c}`).join(" ");
    console.log(`  ${method.padEnd(10)} ${String(n).padStart(6)}   ${statuses}`);
  }

  // Q: does it authenticate up front, or wait for the 401 challenge?
  const noAuth = list.filter((e) => e.method !== "OPTIONS" && !e.headers?.authorization);
  console.log(`\nAuth: ${noAuth.length === 0 ? "always sends Basic up front" : `${noAuth.length} request(s) without credentials (waits for the 401 challenge)`}`);

  // Q: what does it ask for before uploading?
  const propfinds = list.filter((e) => e.method === "PROPFIND");
  if (propfinds.length) {
    console.log(`\nPROPFIND: ${propfinds.length}, depths ${count(propfinds, (e) => e.depth).map(([d, c]) => `${d}×${c}`).join(" ")}`);
    for (const [body, n] of count(propfinds, (e) => (e.body ?? "(empty body = allprop)").replace(/\s+/g, " ").slice(0, 400)).slice(0, 5)) {
      console.log(`  ${n}× ${body}`);
    }
  }

  // Q: does it check a file exists before sending it (PROPFIND/HEAD on the target path)?
  const puts = list.filter((e) => e.method === "PUT");
  const checkedFirst = puts.filter((put) => list.some((e) =>
    (e.method === "PROPFIND" || e.method === "HEAD") && e.path === put.path && e.at <= put.at));
  if (puts.length) {
    const sent = puts.filter((e) => e.status === 201 || e.status === 204);
    const bytes = sent.reduce((sum, e) => sum + (e.bodyBytes ?? 0), 0);
    const largest = puts.reduce((max, e) => Math.max(max, e.bodyBytes ?? 0), 0);
    console.log(`\nPUT: ${puts.length} (${sent.length} stored, ${mb(bytes)}; largest ${mb(largest)}); ` +
      `${checkedFirst.length} were checked with PROPFIND/HEAD on the same path first; ` +
      `${puts.filter((e) => e.status === 204).length} overwrote an existing file`);
    const aborted = puts.filter((e) => e.aborted || e.error);
    if (aborted.length) {
      console.log(`  ${aborted.length} failed mid-upload:`);
      for (const e of aborted.slice(0, 10)) console.log(`    ${e.at} ${e.path} — ${e.error ?? "aborted"} after ${mb(e.bodyBytes ?? 0)}`);
    }
    const types = count(puts, (e) => e.headers?.["content-type"] ?? "(none)");
    console.log(`  Content-Type: ${types.map(([t, c]) => `${t}×${c}`).join(", ")}`);
    const exts = count(puts, (e) => path.extname(e.path ?? "").toLowerCase() || "(none)");
    console.log(`  Extensions: ${exts.map(([t, c]) => `${t}×${c}`).join(", ")}`);
    console.log(`  Expect: 100-continue on ${puts.filter((e) => e.headers?.expect).length} of ${puts.length}`);
    console.log("  Sample paths:");
    for (const e of puts.slice(0, 8)) console.log(`    ${e.path}`);
  }

  // Q: upload to a temporary name, then MOVE?
  const moves = list.filter((e) => e.method === "MOVE");
  if (moves.length) {
    console.log(`\nMOVE: ${moves.length} — sample:`);
    for (const e of moves.slice(0, 5)) console.log(`    ${e.path}  →  ${e.destination}  (${e.status}, Overwrite: ${e.headers?.overwrite ?? "-"})`);
  } else {
    console.log("\nMOVE: none — uploads go straight to their final name");
  }

  // Q: how is "upload in chunks" spelled?
  const chunkSignals = list.filter((e) =>
    Object.keys(e.headers ?? {}).some((h) => CHUNK_HINT.test(h)) || CHUNK_HINT.test(e.path ?? ""));
  console.log(`\nChunking signals: ${chunkSignals.length ? "" : "none seen"}`);
  for (const e of chunkSignals.slice(0, 10)) {
    const hints = Object.entries(e.headers ?? {}).filter(([h]) => CHUNK_HINT.test(h)).map(([h, v]) => `${h}: ${v}`);
    console.log(`    ${e.method} ${e.path} ${hints.join("; ")} (${e.status})`);
  }

  // Q: how do dates and other metadata arrive?
  const extraHeaders = count(list.flatMap((e) => Object.keys(e.headers ?? {}).filter((h) => !STANDARD_HEADERS.has(h)).map((h) => `${e.method} ${h}`)), (x) => x);
  console.log("\nNon-standard headers (method header × count):");
  for (const [h, n] of extraHeaders) console.log(`  ${h} ×${n}`);
  const dated = list.find((e) => e.headers?.["x-oc-mtime"] || e.headers?.["x-file-mtime"]);
  if (dated) console.log(`  e.g. ${dated.path}: X-OC-Mtime ${dated.headers["x-oc-mtime"] ?? dated.headers["x-file-mtime"]}`);
  const proppatches = list.filter((e) => e.method === "PROPPATCH");
  if (proppatches.length) {
    console.log(`\nPROPPATCH: ${proppatches.length}, e.g.:\n  ${(proppatches[0].body ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
  }

  // Q: Live Photos — still + MOV with the same base name?
  const baseNames = count(puts.filter((e) => e.status === 201 || e.status === 204), (e) => {
    const p = e.path ?? "";
    return path.posix.join(path.posix.dirname(p), path.posix.basename(p, path.posix.extname(p))).toLowerCase();
  }).filter(([, n]) => n > 1);
  if (baseNames.length) {
    console.log(`\nSame base name, several files (Live Photos?): ${baseNames.length}, e.g.:`);
    for (const [base] of baseNames.slice(0, 5)) {
      console.log(`    ${[...new Set(puts.filter((e) => (e.path ?? "").toLowerCase().startsWith(base + ".")).map((e) => e.path))].join("  +  ")}`);
    }
  }

  const deletes = list.filter((e) => e.method === "DELETE");
  if (deletes.length) console.log(`\nDELETE: ${deletes.length} — sample: ${deletes.slice(0, 5).map((e) => `${e.path} (${e.status})`).join(", ")}`);
  const locks = list.filter((e) => e.method === "LOCK" || e.method === "UNLOCK");
  if (locks.length) console.log(`\nLOCK/UNLOCK: ${locks.length}`);
  const refused = list.filter((e) => e.status === 429 || (e.status === 403 && e.method !== "DELETE"));
  if (refused.length) console.log(`\nRefused before the spike saw them (429 / 403): ${refused.length} — check rate limit, IP block, deletion protection`);

  // Q: a second run — does it re-send what it already sent?
  const dupes = count(puts, (e) => e.path).filter(([, n]) => n > 1);
  console.log(`\nSame path PUT more than once: ${dupes.length}${dupes.length ? `, e.g. ${dupes.slice(0, 3).map(([p, n]) => `${p}×${n}`).join(", ")}` : ""}`);
  console.log("");
}
