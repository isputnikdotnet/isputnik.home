// A phone's own namespace over /dav (docs/photo-sync-plan.md, decision 8).
//
// The phone chooses its layout (PhotoSync makes `/<device model>/<album>/`) and
// decides what to send by listing the server, so it must be answered with the paths
// IT used. The library is filed by date instead (put.ts). These rows are the bridge:
// `photo_sync_files` (one per path the phone sent) and `photo_sync_folders` (what it
// made with MKCOL). Nothing here touches the filesystem, and no client path ever
// reaches it: a path is only a key.
//
// Paths are normalised to "/" or "/a/b" (no trailing slash). A segment may hold any
// character except "/", "\" and controls, and may not be "." or "..".
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import type { PhotoSyncFileRow } from "../../../../db/rows.js";

export const DAV_PREFIX = "/dav";
const MAX_PATH = 1024;
const MAX_SEGMENT = 255;

/** The DAV path of a request URL ("/dav/A/b.jpg?x" → "/A/b.jpg"), or null when it is
 *  not under /dav or a segment is unusable (escape, control character, too long). */
export function davPathOf(url: string): string | null {
  const pathname = url.split("?")[0] ?? "";
  if (!pathname.startsWith(DAV_PREFIX)) return null;
  const rest = pathname.slice(DAV_PREFIX.length);
  if (rest !== "" && !rest.startsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return null; }
    if (!usableSegment(segment)) return null;
    segments.push(segment);
  }
  const joined = `/${segments.join("/")}`;
  return joined.length > MAX_PATH ? null : joined;
}

function usableSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".." || segment.length > MAX_SEGMENT) return false;
  if (/[\\/]/.test(segment)) return false;
  for (const ch of segment) if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) return false;
  return true;
}

/** A Destination header (absolute URL or a path) as a DAV path. */
export function destinationPathOf(header: unknown): string | null {
  if (typeof header !== "string" || !header) return null;
  let pathname: string;
  try { pathname = new URL(header, "http://phone.invalid").pathname; } catch { return null; }
  return davPathOf(pathname);
}

export const parentOf = (davPath: string): string => {
  const cut = davPath.lastIndexOf("/");
  return cut <= 0 ? "/" : davPath.slice(0, cut);
};
export const baseNameOf = (davPath: string): string => davPath.slice(davPath.lastIndexOf("/") + 1);

/** The href of a DAV path, each segment percent-encoded; folders end in "/". */
export function hrefFor(davPath: string, isFolder: boolean): string {
  const encoded = davPath === "/" ? "/" : davPath.split("/").map((s) => encodeURIComponent(s)).join("/");
  const href = `${DAV_PREFIX}${encoded}`;
  return isFolder && !href.endsWith("/") ? `${href}/` : href;
}

// Rows strictly under a folder, as a range on the (device_id, client_path) key —
// "/A/" up to "/A0" ("0" follows "/") — so no LIKE escaping and the index is used.
function underRange(folder: string): [string, string] {
  const prefix = folder === "/" ? "/" : `${folder}/`;
  return [prefix, `${prefix.slice(0, -1)}0`];
}

export type SyncFile = PhotoSyncFileRow;

export function fileAt(deviceId: string, davPath: string): SyncFile | null {
  return (db.prepare("SELECT * FROM photo_sync_files WHERE device_id = ? AND client_path = ?")
    .get(deviceId, davPath) as SyncFile | undefined) ?? null;
}

/** Whether a folder exists in the phone's namespace: the root, one it made, or one
 *  implied by something it sent beneath it. */
export function folderExists(deviceId: string, davPath: string): boolean {
  if (davPath === "/") return true;
  if (db.prepare("SELECT 1 FROM photo_sync_folders WHERE device_id = ? AND client_path = ?").get(deviceId, davPath)) return true;
  const [from, to] = underRange(davPath);
  return Boolean(
    db.prepare("SELECT 1 FROM photo_sync_folders WHERE device_id = ? AND client_path >= ? AND client_path < ? LIMIT 1").get(deviceId, from, to)
    ?? db.prepare("SELECT 1 FROM photo_sync_files WHERE device_id = ? AND client_path >= ? AND client_path < ? LIMIT 1").get(deviceId, from, to)
  );
}

export function folderCreatedAt(deviceId: string, davPath: string): string | null {
  const row = db.prepare("SELECT created_at FROM photo_sync_folders WHERE device_id = ? AND client_path = ?")
    .get(deviceId, davPath) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/** MKCOL: false when it already exists (the caller answers 405 — PhotoSync re-sends
 *  MKCOL before every file and expects that). */
export function makeFolder(deviceId: string, davPath: string): boolean {
  if (davPath === "/" || fileAt(deviceId, davPath) || folderExists(deviceId, davPath)) return false;
  db.prepare("INSERT OR IGNORE INTO photo_sync_folders (device_id, client_path) VALUES (?, ?)").run(deviceId, davPath);
  return true;
}

/** Records the folders above a path a lenient client PUT to without MKCOL. */
export function ensureParents(deviceId: string, davPath: string): void {
  const insert = db.prepare("INSERT OR IGNORE INTO photo_sync_folders (device_id, client_path) VALUES (?, ?)");
  let parent = parentOf(davPath);
  while (parent !== "/") {
    insert.run(deviceId, parent);
    parent = parentOf(parent);
  }
}

export interface ListedEntry {
  path: string;
  folder: boolean;
  file?: SyncFile;
  createdAt?: string | null;
}

/** The direct children of a folder: what the phone sent there and the folders it made
 *  (or implied) — never anything of the library's own. */
export function listChildren(deviceId: string, folder: string): ListedEntry[] {
  const [prefix, to] = underRange(folder);
  const folders = new Map<string, string | null>();
  const files: ListedEntry[] = [];
  const addFolder = (path: string, createdAt: string | null) => {
    if (!folders.has(path) || createdAt) folders.set(path, createdAt ?? folders.get(path) ?? null);
  };
  // The direct child a deeper path sits in, or null when the path IS a direct child.
  const childOf = (path: string): string | null => {
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf("/");
    return cut < 0 ? null : `${prefix}${rest.slice(0, cut)}`;
  };
  for (const row of db.prepare("SELECT client_path, created_at FROM photo_sync_folders WHERE device_id = ? AND client_path >= ? AND client_path < ?")
    .all(deviceId, prefix, to) as { client_path: string; created_at: string }[]) {
    const child = childOf(row.client_path);
    if (child) addFolder(child, null); else addFolder(row.client_path, row.created_at);
  }
  for (const row of db.prepare("SELECT * FROM photo_sync_files WHERE device_id = ? AND client_path >= ? AND client_path < ?")
    .all(deviceId, prefix, to) as SyncFile[]) {
    const child = childOf(row.client_path);
    if (child) addFolder(child, null); else files.push({ path: row.client_path, folder: false, file: row });
  }
  const fileNames = new Set(files.map((f) => f.path));
  const listed: ListedEntry[] = Array.from(folders.entries())
    .filter(([path]) => !fileNames.has(path))
    .map(([path, createdAt]) => ({ path, folder: true, createdAt }));
  return [...listed, ...files].sort((a, b) => a.path.localeCompare(b.path));
}

/** Records (or re-points) what the phone sent at a path. */
export function recordFile(input: {
  deviceId: string; davPath: string; size: number; sha256: string; clientMtime: string | null; itemId: string | null;
}): void {
  db.prepare(`
    INSERT INTO photo_sync_files (id, device_id, client_path, size, client_mtime, sha256, item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, client_path) DO UPDATE SET
      size = excluded.size, client_mtime = excluded.client_mtime, sha256 = excluded.sha256,
      item_id = excluded.item_id, received_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(nanoid(), input.deviceId, input.davPath, input.size, input.clientMtime, input.sha256, input.itemId);
}

export function setClientMtime(fileId: string, iso: string): void {
  db.prepare("UPDATE photo_sync_files SET client_mtime = ? WHERE id = ?").run(iso, fileId);
}

export type MoveResult = "moved" | "missing" | "exists" | "conflict";

/** MOVE inside the phone's namespace: renames the records only — the library file
 *  stays where it was filed. A file may replace another record when the client says
 *  Overwrite: T (the earlier file stays in the library); a folder never lands on
 *  anything that exists. */
export function moveInNamespace(deviceId: string, from: string, to: string, overwrite: boolean): MoveResult {
  if (from === "/" || to === "/" || to === from || to.startsWith(`${from}/`)) return "conflict";
  const file = fileAt(deviceId, from);
  const destinationTaken = Boolean(fileAt(deviceId, to)) || folderExists(deviceId, to);
  if (file) {
    if (folderExists(deviceId, to)) return "conflict";
    if (destinationTaken && !overwrite) return "exists";
    db.transaction(() => {
      db.prepare("DELETE FROM photo_sync_files WHERE device_id = ? AND client_path = ?").run(deviceId, to);
      db.prepare("UPDATE photo_sync_files SET client_path = ? WHERE id = ?").run(to, file.id);
      ensureParents(deviceId, to);
    })();
    return "moved";
  }
  if (!folderExists(deviceId, from)) return "missing";
  if (destinationTaken) return overwrite ? "conflict" : "exists";
  const [lo, hi] = underRange(from);
  db.transaction(() => {
    const rename = (table: "photo_sync_files" | "photo_sync_folders") => {
      db.prepare(`
        UPDATE ${table} SET client_path = ? || substr(client_path, ?)
        WHERE device_id = ? AND (client_path = ? OR (client_path >= ? AND client_path < ?))
      `).run(to, from.length + 1, deviceId, from, lo, hi);
    };
    rename("photo_sync_folders");
    rename("photo_sync_files");
    if (!db.prepare("SELECT 1 FROM photo_sync_folders WHERE device_id = ? AND client_path = ?").get(deviceId, to)) {
      db.prepare("INSERT INTO photo_sync_folders (device_id, client_path) VALUES (?, ?)").run(deviceId, to);
    }
    ensureParents(deviceId, to);
  })();
  return "moved";
}
