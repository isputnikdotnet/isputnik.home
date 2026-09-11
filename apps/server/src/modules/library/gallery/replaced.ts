// The originals Replace file set aside — what the Recycle Bin page lists under
// "Replaced originals" (replace.ts says why they are kept at all).
//
// They have no rows: a replaced original is a file at
//   <bin>/replaced/<library>/<item>/<stamp>-<original name>
// under the install-wide bin root, or under a library's own .trash when no root
// is configured (or was not, when the file was set aside — the bin move carries
// them, storage-move.ts). Nothing else in the app looks at them, and nothing
// expires them, so this is the one place they are seen, counted and let go.
// Everything here reads the disk; the database is only asked for names.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { getTrashRootSetting } from "../shared/trash-settings.js";
import type { LibraryRow } from "../../../db/rows.js";

const LIBRARY_TRASH_DIR = ".trash";

export interface ReplacedOriginal {
  /** Opaque handle for the delete routes: where the file is, encoded. */
  key: string;
  libraryId: string;
  libraryName: string | null;
  itemId: string;
  /** The photo's title now, when it still exists. */
  itemTitle: string | null;
  itemExists: boolean;
  /** The file as kept: `<stamp>-<original name>`. */
  fileName: string;
  /** The name the file had in the library. */
  originalName: string;
  /** When Replace set it aside, read from the stamp; null when the name has none. */
  keptAt: string | null;
  size: number;
  /** Where it sits: the bin root, or a library's own .trash (that library's id). */
  root: "bin" | string;
}

interface Root { kind: "bin" | string; dir: string }

/** Every `replaced/` folder that can hold originals right now. */
function replacedRoots(): Root[] {
  const roots: Root[] = [];
  const bin = getTrashRootSetting();
  if (bin) roots.push({ kind: "bin", dir: path.join(bin, "replaced") });
  const libraries = db.prepare("SELECT id, source_path FROM libraries WHERE type = 'gallery'").all() as Pick<LibraryRow, "id" | "source_path">[];
  for (const library of libraries) roots.push({ kind: library.id, dir: path.join(library.source_path, LIBRARY_TRASH_DIR, "replaced") });
  return roots;
}

function rootDir(kind: string): string | null {
  return replacedRoots().find((root) => root.kind === kind)?.dir ?? null;
}

/** `2026-09-03T21-32-59-482Z-FL000021.jpg` → the ISO stamp and the name after it. */
function splitStamp(fileName: string): { keptAt: string | null; originalName: string } {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/);
  if (!match) return { keptAt: null, originalName: fileName };
  return { keptAt: `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`, originalName: match[6] };
}

const encodeKey = (kind: string, relative: string): string => Buffer.from(JSON.stringify({ kind, relative }), "utf8").toString("base64url");

function decodeKey(key: string): { kind: string; relative: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(key, "base64url").toString("utf8")) as { kind?: unknown; relative?: unknown };
    if (typeof parsed.kind !== "string" || typeof parsed.relative !== "string") return null;
    // Exactly <library>/<item>/<file>, no dots-only segments, no separators inside.
    const parts = parsed.relative.split("/");
    if (parts.length !== 3 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
    return { kind: parsed.kind, relative: parsed.relative };
  } catch {
    return null;
  }
}

export function listReplacedOriginals(): ReplacedOriginal[] {
  const libraryNames = new Map(
    (db.prepare("SELECT id, name FROM libraries").all() as Pick<LibraryRow, "id" | "name">[]).map((row) => [row.id, row.name])
  );
  const titleOf = db.prepare(`
    SELECT COALESCE(m.title, i.folder_path) AS title
    FROM library_items i LEFT JOIN item_metadata m ON m.item_id = i.id
    WHERE i.id = ? AND i.deleted_at IS NULL
  `);
  const out: ReplacedOriginal[] = [];
  for (const root of replacedRoots()) {
    let libraryIds: string[];
    try { libraryIds = fs.readdirSync(root.dir); } catch { continue; }
    for (const libraryId of libraryIds) {
      let itemIds: string[];
      try { itemIds = fs.readdirSync(path.join(root.dir, libraryId)); } catch { continue; }
      for (const itemId of itemIds) {
        const itemDir = path.join(root.dir, libraryId, itemId);
        let files: string[];
        try { files = fs.readdirSync(itemDir); } catch { continue; }
        const item = titleOf.get(itemId) as { title: string } | undefined;
        for (const fileName of files) {
          let size = 0;
          try {
            const stat = fs.statSync(path.join(itemDir, fileName));
            if (!stat.isFile()) continue;
            size = stat.size;
          } catch { continue; }
          const { keptAt, originalName } = splitStamp(fileName);
          out.push({
            key: encodeKey(root.kind, `${libraryId}/${itemId}/${fileName}`),
            libraryId,
            libraryName: libraryNames.get(libraryId) ?? null,
            itemId,
            itemTitle: item?.title ?? null,
            itemExists: item !== undefined,
            fileName,
            originalName,
            keptAt,
            size,
            root: root.kind
          });
        }
      }
    }
  }
  // Newest first; the unstamped (hand-placed) at the end, by name.
  return out.sort((a, b) => (b.keptAt ?? "").localeCompare(a.keptAt ?? "") || a.fileName.localeCompare(b.fileName));
}

/** Remove one kept original for good, and the emptied `<item>` and `<library>`
 *  folders above it. Returns what was removed, or null when the key names
 *  nothing that exists. Refuses anything that does not resolve inside a
 *  `replaced/` folder the app knows. */
export function deleteReplacedOriginal(key: string): { fileName: string; size: number } | null {
  const decoded = decodeKey(key);
  if (!decoded) return null;
  const dir = rootDir(decoded.kind);
  if (!dir) return null;
  const abs = path.resolve(dir, ...decoded.relative.split("/"));
  if (!pathIsInside(abs, dir)) return null;
  let size = 0;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null;
  }
  fs.rmSync(abs, { force: true });
  for (const parent of [path.dirname(abs), path.dirname(path.dirname(abs))]) {
    try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { break; }
  }
  return { fileName: path.basename(abs), size };
}

/** Remove every kept original. Returns how many files and bytes went. */
export function deleteAllReplacedOriginals(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const original of listReplacedOriginals()) {
    const removed = deleteReplacedOriginal(original.key);
    if (removed) {
      files += 1;
      bytes += removed.size;
    }
  }
  return { files, bytes };
}
