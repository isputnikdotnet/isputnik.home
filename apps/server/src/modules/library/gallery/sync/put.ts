// One PUT from a phone, all or nothing (docs/photo-sync-plan.md, decision 9).
//
// The body streams into a hidden `.upload-sync-<id>` folder in the library root,
// hashed as it is written (a 4 GB video is never read twice) and cut off the moment
// it passes the size cap, the member's size limit or the free space. Only when it is
// complete — length right, the client's checksum right if one was sent — is it
// filed, and only then does the phone hear `201`:
//
//   same path, same content already recorded       → 204, nothing written
//   same content already in this personal library  → recorded against that item, 201
//   otherwise                                      → <phone>/YYYY/YYYY-MM-DD/<name>, scanned, 201
//
// The date that files it is the gallery's own chain — EXIF, then a date in the file
// name (Samsung `20261105_100150.jpg`, Pixel `PXL_20261102_160025120.jpg`) — then the
// date the phone sent (`X-OC-Mtime` / `X-RecordTime`), then now. The phone's date
// also becomes the file's mtime, the scanner's last resort, so the item is dated the
// same way. Nothing is ever overwritten: a name already on disk gets " (2)".
//
// The finishing step runs one file at a time per library, so two phones sending the
// same photo at once make one item, and thumbnails go through renderInTurn() inside
// the scanner — a burst of uploads never starts two renders.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type { FastifyRequest } from "fastify";
import { db } from "../../../../db.js";
import { parsePolicy } from "../../../../core/permissions.js";
import { resolveUploadMaxBytes } from "../../shared/library-crud.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { normaliseRelativePath, pathIsInside } from "../../shared/storage-roots.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../../shared/library-settings.js";
import { scanSingleGalleryFile } from "../scanner.js";
import { kindForExtension, readAssetMetadata } from "../media.js";
import { dateFolderForCapture } from "../date-folder.js";
import { dateFromFileName } from "../filename-date.js";
import { uniqueGalleryFileName } from "../files.js";
import { personalQuota } from "../personal/service.js";
import { baseNameOf, ensureParents, fileAt, recordFile } from "./namespace.js";
import type { PhoneIdentity } from "./devices.js";
import type { LibraryRow } from "../../../../db/rows.js";

export const STAGING_PREFIX = ".upload-sync-";
/** Left free on the disk after an upload, so a phone never fills it to the last byte. */
export const FREE_SPACE_RESERVE = 256 * 1024 * 1024;

export class PutRefused extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** A date a client sends: bare unix seconds (`1793893935.00` — PhotoSync's
 *  X-OC-Mtime, X-RecordTime and PROPPATCH getlastmodified), an RFC 1123 date
 *  (`Wed, 05 Nov 2026 10:01:50 GMT`), or ISO. Null for anything implausible. */
export function parseClientDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = /^\d+(\.\d+)?$/.test(trimmed) ? new Date(Number(trimmed) * 1000) : new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1971 || date.getTime() > Date.now() + 2 * 86_400_000) return null;
  return date;
}

export function clientDateOf(request: FastifyRequest): Date | null {
  return parseClientDate(request.headers["x-oc-mtime"]) ?? parseClientDate(request.headers["x-recordtime"]);
}

/** The library subfolder a photo is filed under: EXIF, the name, the phone's date, now. */
export async function syncDateFolder(tmpPath: string, fileName: string, clientDate: Date | null, now = new Date()): Promise<string> {
  const kind = kindForExtension(path.extname(fileName).toLowerCase());
  let takenAt: string | null = null;
  if (kind) {
    try { takenAt = (await readAssetMetadata(kind, tmpPath)).takenAt; } catch { /* no date → fallback */ }
  }
  return dateFolderForCapture(takenAt ?? dateFromFileName(fileName), clientDate ?? now);
}

/** The phone's folder in its owner's library, from its name on the Phones list. */
export function deviceFolderName(label: string | null): string {
  const cleaned = Array.from(label ?? "")
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .replace(/[\s.]+$/g, "");
  return cleaned || "Phone";
}

// ── Free space (a seam for the tests' "disk full") ───────────────────────────

function diskFreeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
let freeBytesProbe = diskFreeBytes;

/** Tests only: what the disk is said to have free (null = unknown). */
export function setFreeSpaceProbeForTests(probe: ((dir: string) => number | null) | null): void {
  freeBytesProbe = probe ?? diskFreeBytes;
}

// ── One finishing step at a time per library ────────────────────────────────

const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(libraryId: string, work: () => Promise<T>): Promise<T> {
  const before = turns.get(libraryId) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  turns.set(libraryId, settled);
  void settled.then(() => { if (turns.get(libraryId) === settled) turns.delete(libraryId); });
  return run;
}

// ── The library it writes into ───────────────────────────────────────────────

export interface SyncTarget {
  libraryId: string;
  root: string;
  accept: Set<string>;
  maxBytes: number;
}

/** The phone's personal library, ready to write into, or a refusal. */
export function syncTargetOf(phone: PhoneIdentity): SyncTarget {
  const library = db.prepare("SELECT id, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'gallery' AND personal_user_id = ?")
    .get(phone.libraryId, phone.user.id) as Pick<LibraryRow, "id" | "source_path" | "settings_json" | "policy_json"> | undefined;
  if (!library) throw new PutRefused(403, "This phone's library is unavailable.");
  let root: string;
  try {
    root = validateLibrarySource(library.source_path);
  } catch {
    throw new PutRefused(503, "The library's folder is unavailable.");
  }
  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  return {
    libraryId: library.id,
    root,
    accept: new Set(uploadAcceptExtensions(settings).map((ext) => ext.toLowerCase())),
    maxBytes: resolveUploadMaxBytes(parsePolicy(library.policy_json).maxUploadMB)
  };
}

/** Removes staging folders a crash or a restart left behind in personal libraries. */
export function sweepStaleSyncStaging(): number {
  let removed = 0;
  const rows = db.prepare("SELECT source_path FROM libraries WHERE type = 'gallery' AND personal_user_id IS NOT NULL")
    .all() as Pick<LibraryRow, "source_path">[];
  for (const row of rows) {
    let names: string[];
    try { names = fs.readdirSync(row.source_path); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      fs.rmSync(path.join(row.source_path, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// ── The PUT ──────────────────────────────────────────────────────────────────

export interface PutOutcome {
  status: 201 | 204;
  sha256: string;
  /** Which branch it took — for the tests and the log. */
  result: "unchanged" | "known" | "stored";
  itemId: string | null;
}

/** Checks a client checksum header against what arrived. Unknown algorithms are ignored. */
function checksumsOf(request: FastifyRequest): Array<{ algorithm: "md5" | "sha1" | "sha256"; expected: string; encoding: "hex" | "base64" }> {
  const wanted: Array<{ algorithm: "md5" | "sha1" | "sha256"; expected: string; encoding: "hex" | "base64" }> = [];
  const oc = request.headers["oc-checksum"];
  if (typeof oc === "string") {
    const match = /^\s*(MD5|SHA1|SHA256):([0-9a-f]+)\s*$/i.exec(oc);
    if (match) wanted.push({ algorithm: match[1]!.toLowerCase() as "md5" | "sha1" | "sha256", expected: match[2]!.toLowerCase(), encoding: "hex" });
  }
  const md5 = request.headers["content-md5"];
  if (typeof md5 === "string" && md5.trim()) wanted.push({ algorithm: "md5", expected: md5.trim(), encoding: "base64" });
  return wanted;
}

/** The same bytes already in this library: something a phone sent, or an item whose
 *  file has the same size and digest (hashed now if it never was). */
async function sameContentIn(target: SyncTarget, sha: string, size: number): Promise<string | null> {
  const sent = db.prepare(`
    SELECT f.item_id FROM photo_sync_files f
    JOIN library_items li ON li.id = f.item_id
    WHERE f.sha256 = ? AND li.library_id = ? AND li.deleted_at IS NULL
    LIMIT 1
  `).get(sha, target.libraryId) as { item_id: string } | undefined;
  if (sent) return sent.item_id;

  // Byte-identical files share a size, so only same-size items are read.
  const candidates = db.prepare(`
    SELECT gd.item_id, gd.relative_path, gd.content_hash, gd.content_hash_at FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND gd.size = ?
    LIMIT 50
  `).all(target.libraryId, size) as Array<{ item_id: string; relative_path: string; content_hash: string | null; content_hash_at: string | null }>;
  const setHash = db.prepare("UPDATE gallery_details SET content_hash = ?, content_hash_at = ? WHERE item_id = ?");
  for (const row of candidates) {
    const abs = path.resolve(target.root, ...row.relative_path.split("/"));
    if (!pathIsInside(abs, target.root)) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size !== size) continue;
    const mtime = new Date(stat.mtimeMs).toISOString();
    let digest = row.content_hash && row.content_hash_at === mtime ? row.content_hash : null;
    if (!digest) {
      digest = await sha256OfFile(abs);
      // Kept the way the duplicate scan keeps it: the digest and the mtime it was read at.
      if (digest) setHash.run(digest, mtime, row.item_id);
    }
    if (digest === sha) return row.item_id;
  }
  return null;
}

async function sha256OfFile(abs: string): Promise<string | null> {
  const hash = crypto.createHash("sha256");
  try {
    await pipeline(fs.createReadStream(abs), new Transform({
      transform(chunk: Buffer, _enc, callback) { hash.update(chunk); callback(); }
    }));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Receives one PUT into the phone's library. Throws PutRefused with the status to
 *  answer; the caller has already authenticated the phone and checked the path. */
export async function receivePut(request: FastifyRequest, phone: PhoneIdentity, davPath: string): Promise<PutOutcome> {
  const target = syncTargetOf(phone);
  const name = baseNameOf(davPath);
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!extension || !target.accept.has(extension)) throw new PutRefused(415, `File type not allowed: .${extension || "?"}`);

  // Limits known before a byte arrives. Content-Length is a promise, checked again below.
  const declaredHeader = request.headers["content-length"];
  const declared = declaredHeader !== undefined ? Number(declaredHeader) : null;
  if (declared !== null && (!Number.isFinite(declared) || declared < 0)) throw new PutRefused(400, "Bad Content-Length.");
  const quota = personalQuota(target.libraryId);
  const quotaLeft = quota ? quota.limitBytes - quota.usedBytes : Infinity;
  const free = freeBytesProbe(target.root);
  const spaceLeft = free === null ? Infinity : free - FREE_SPACE_RESERVE;
  if (quotaLeft <= 0) throw new PutRefused(507, "The personal library has reached its size limit.");
  if (spaceLeft <= 0) throw new PutRefused(507, "The server's disk is full.");
  if (declared !== null) {
    if (declared > target.maxBytes) throw new PutRefused(413, "The file is larger than this library allows.");
    if (declared > quotaLeft) throw new PutRefused(507, "The file would take the personal library past its size limit.");
    if (declared > spaceLeft) throw new PutRefused(507, "The server's disk is full.");
  }

  const stagingDir = path.join(target.root, `${STAGING_PREFIX}${nanoid(10)}`);
  const tmpPath = path.join(stagingDir, `${nanoid(12)}.${extension}`);
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    const sha = crypto.createHash("sha256");
    const checks = checksumsOf(request).map((check) => ({ ...check, hash: crypto.createHash(check.algorithm) }));
    let bytes = 0;
    // Set from inside the stream, so a holder rather than a narrowed local.
    const cut: { over: PutRefused | null } = { over: null };
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > target.maxBytes) cut.over = new PutRefused(413, "The file is larger than this library allows.");
        else if (bytes > quotaLeft) cut.over = new PutRefused(507, "The file would take the personal library past its size limit.");
        else if (bytes > spaceLeft) cut.over = new PutRefused(507, "The server's disk is full.");
        if (cut.over) { callback(cut.over); return; }
        sha.update(chunk);
        for (const check of checks) check.hash.update(chunk);
        callback(null, chunk);
      }
    });
    try {
      await pipeline(request.raw, counter, fs.createWriteStream(tmpPath));
    } catch (err) {
      if (cut.over) throw cut.over;
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") throw new PutRefused(507, "The server's disk is full.");
      throw new PutRefused(400, "The upload did not complete.");
    }
    if (declared !== null && declared !== bytes) throw new PutRefused(400, `Expected ${declared} bytes, received ${bytes}.`);
    if (bytes === 0) throw new PutRefused(400, "The file is empty.");
    for (const check of checks) {
      if (check.hash.digest(check.encoding).toLowerCase() !== check.expected.toLowerCase()) {
        throw new PutRefused(400, "The file's checksum does not match.");
      }
    }
    const digest = sha.digest("hex");
    const clientDate = clientDateOf(request);

    return await inTurn(target.libraryId, async () => {
      const existing = fileAt(phone.deviceId, davPath);
      if (existing && existing.sha256 === digest) {
        return { status: 204, sha256: digest, result: "unchanged", itemId: existing.item_id } as const;
      }
      const record = (itemId: string | null) => {
        ensureParents(phone.deviceId, davPath);
        recordFile({
          deviceId: phone.deviceId, davPath, size: bytes, sha256: digest,
          clientMtime: clientDate?.toISOString() ?? null, itemId
        });
      };

      const known = await sameContentIn(target, digest, bytes);
      if (known) {
        record(known);
        return { status: 201, sha256: digest, result: "known", itemId: known } as const;
      }

      const dated = await syncDateFolder(tmpPath, name, clientDate);
      const targetDir = path.join(target.root, deviceFolderName(phone.label), ...dated.split("/"));
      if (!pathIsInside(targetDir, target.root)) throw new PutRefused(400, "Bad path.");
      fs.mkdirSync(targetDir, { recursive: true });
      const finalName = uniqueGalleryFileName(targetDir, name);
      if (!finalName) throw new PutRefused(400, "The file name is unusable.");
      if (clientDate) fs.utimesSync(tmpPath, clientDate, clientDate);
      const finalPath = path.join(targetDir, finalName);
      fs.renameSync(tmpPath, finalPath);
      const relativePath = normaliseRelativePath(path.relative(target.root, finalPath));
      let itemId: string | null = null;
      try {
        itemId = await scanSingleGalleryFile(target.libraryId, relativePath);
      } catch (err) {
        // The file is safe under its final name; a full scan will catalogue it.
        request.log.warn({ err, relativePath }, "Photo sync: stored a file the scanner could not catalogue yet");
      }
      record(itemId);
      return { status: 201, sha256: digest, result: "stored", itemId } as const;
    });
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** PROPPATCH brought a date the PUT didn't: the item was dated "now", so give the
 *  file the phone's date and let the scanner re-date it (EXIF and the name still win). */
export async function redateFromClient(phone: PhoneIdentity, itemId: string, date: Date): Promise<void> {
  const target = syncTargetOf(phone);
  const row = db.prepare(`
    SELECT gd.relative_path FROM gallery_details gd JOIN library_items li ON li.id = gd.item_id
    WHERE gd.item_id = ? AND li.library_id = ? AND li.deleted_at IS NULL
  `).get(itemId, target.libraryId) as { relative_path: string } | undefined;
  if (!row) return;
  const abs = path.resolve(target.root, ...row.relative_path.split("/"));
  if (!pathIsInside(abs, target.root)) return;
  await inTurn(target.libraryId, async () => {
    fs.utimesSync(abs, date, date);
    await scanSingleGalleryFile(target.libraryId, row.relative_path);
  });
}
