// What App storage holds — the Contents page beside Storage (docs/app-storage-plan.md).
//
// The Storage page says where each room is; this says what is in it, so an
// admin can answer "what is taking the space, and who owns it" without a
// terminal. Every room gets a count and a size. The App files library gets
// more: each of its folders listed file by file with the thing that owns the
// file — the story a recording narrates, the photo a voice note sits on, the
// track a music file plays as, the slideshow a movie was rendered from, the
// person a family-tree photo belongs to — and a file whose owner is gone is
// an orphan, which is the one thing the page lets an admin delete. Files in
// the library that none of the app's folders account for (uploads that landed
// there by hand) are listed as "other" with the way out: move the folder.
//
// Sizes for the rooms that are plain folders (thumbnails, renders, backups,
// staging) come from a bounded walk; libraries and the bin come from rows.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.js";
import { APP_ROOMS, getAppStoragePath, type AppRoom } from "../../core/app-storage.js";
import { HOUSE_FOLDERS, getHouseLibrary } from "./gallery/house-library.js";
import { roomView } from "./app-storage.js";
import { trashBook, TrashError } from "./shared/trash.js";

const WALK_LIMIT = 250_000;

export interface FolderStats { files: number; bytes: number; complete: boolean }

/** Files and bytes under `dir`, stopping at WALK_LIMIT files so a thumbnail
 *  store of millions cannot hold a request; `complete` says whether it stopped. */
export function folderStats(dir: string | null): FolderStats {
  const out: FolderStats = { files: 0, bytes: 0, complete: true };
  if (!dir) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.isFile()) continue;
      try { out.bytes += fs.statSync(abs).size; } catch { continue; }
      out.files += 1;
      if (out.files >= WALK_LIMIT) { out.complete = false; return out; }
    }
  }
  return out;
}

export type AppFileOwnerType = "story" | "photo" | "track" | "slideshow" | "person";

export interface AppFileOwner {
  type: AppFileOwnerType;
  id: string;
  title: string;
  /** For a photo owner: the folder its file sits in, for a Folder view link. */
  folder?: string;
  libraryId?: string;
}

export interface AppFileEntry {
  itemId: string;
  relativePath: string;
  kind: string;
  size: number;
  addedAt: string;
  owner: AppFileOwner | null;
  /** Under one of the app's folders, with no owner left: the file is dead weight. */
  orphan: boolean;
}

export type AppFileFolderKey = "recordings" | "voiceNotes" | "music" | "movies" | "familyTree" | "other";

export interface AppFileFolder {
  key: AppFileFolderKey;
  /** The folder's name inside the library; "" for "other". */
  folder: string;
  files: number;
  bytes: number;
  orphans: number;
  entries: AppFileEntry[];
}

export interface RoomContents {
  room: AppRoom;
  mode: "app" | "own" | "off";
  path: string | null;
  files: number;
  bytes: number;
  complete: boolean;
  /** The library behind a library room. */
  library: { id: string; name: string } | null;
}

export interface AppStorageContents {
  path: string | null;
  rooms: RoomContents[];
  staging: FolderStats & { path: string | null };
  appFiles: { library: { id: string; name: string; path: string } | null; folders: AppFileFolder[] };
}

const ENTRY_LIMIT_PER_FOLDER = 500;

interface ItemRow { id: string; folder_path: string; kind: string | null; size: number | null; discovered_at: string }

function libraryStats(libraryId: string): { files: number; bytes: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS files, COALESCE(SUM(g.size), 0) AS bytes
    FROM library_items i LEFT JOIN gallery_details g ON g.item_id = i.id
    WHERE i.library_id = ? AND i.deleted_at IS NULL
  `).get(libraryId) as { files: number; bytes: number };
  return row;
}

function roomContents(room: AppRoom): RoomContents {
  const view = roomView(room);
  const base = { room, mode: view.mode, path: view.resolvedPath, library: view.library, complete: true };
  switch (room) {
    case "trash": {
      const row = db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM trashed_items").get() as { files: number; bytes: number };
      return { ...base, files: row.files, bytes: row.bytes };
    }
    case "inbox":
    case "house": {
      if (!view.library) return { ...base, files: 0, bytes: 0 };
      return { ...base, ...libraryStats(view.library.id) };
    }
    case "thumbnails":
    case "renders":
    case "backups": {
      const stats = folderStats(view.mode === "off" ? null : view.resolvedPath);
      return { ...base, files: stats.files, bytes: stats.bytes, complete: stats.complete };
    }
  }
}

/** Who owns an item in one of the App files folders, by folder kind. */
function ownerOf(key: AppFileFolderKey, itemId: string): AppFileOwner | null {
  switch (key) {
    case "recordings": {
      const row = db.prepare(`
        SELECT s.id, s.title FROM story_blocks b
        JOIN story_chapters c ON c.id = b.chapter_id
        JOIN stories s ON s.id = c.story_id
        WHERE b.entity_type = 'gallery' AND b.entity_id = ? AND s.deleted_at IS NULL
        LIMIT 1
      `).get(itemId) as { id: string; title: string } | undefined;
      return row ? { type: "story", id: row.id, title: row.title } : null;
    }
    case "voiceNotes": {
      const row = db.prepare(`
        SELECT i.id, i.library_id, i.folder_path, COALESCE(m.title, i.folder_path) AS title
        FROM gallery_voice_notes v
        JOIN library_items i ON i.id = v.item_id AND i.deleted_at IS NULL
        LEFT JOIN item_metadata m ON m.item_id = i.id
        WHERE v.audio_item_id = ?
        LIMIT 1
      `).get(itemId) as { id: string; library_id: string; folder_path: string; title: string } | undefined;
      if (!row) return null;
      const folder = row.folder_path.includes("/") ? row.folder_path.slice(0, row.folder_path.lastIndexOf("/")) : "";
      return { type: "photo", id: row.id, title: row.title, folder, libraryId: row.library_id };
    }
    case "music": {
      const row = db.prepare("SELECT id, title FROM gallery_music_tracks WHERE item_id = ? LIMIT 1").get(itemId) as { id: string; title: string } | undefined;
      return row ? { type: "track", id: row.id, title: row.title } : null;
    }
    case "movies": {
      const row = db.prepare("SELECT id, name FROM gallery_slideshows WHERE movie_item_id = ? LIMIT 1").get(itemId) as { id: string; name: string } | undefined;
      return row ? { type: "slideshow", id: row.id, title: row.name } : null;
    }
    case "familyTree": {
      const row = db.prepare(`
        SELECT p.id, p.name FROM family_tree_photos fp
        JOIN family_tree_persons p ON p.id = fp.person_id
        WHERE fp.item_id = ?
        LIMIT 1
      `).get(itemId) as { id: string; name: string } | undefined;
      return row ? { type: "person", id: row.id, title: row.name } : null;
    }
    case "other":
      return null;
  }
}

const FOLDER_KEYS: { key: Exclude<AppFileFolderKey, "other">; folder: string }[] = [
  { key: "recordings", folder: HOUSE_FOLDERS.recordings },
  { key: "voiceNotes", folder: HOUSE_FOLDERS.voiceNotes },
  { key: "music", folder: HOUSE_FOLDERS.music },
  { key: "movies", folder: HOUSE_FOLDERS.movies },
  { key: "familyTree", folder: HOUSE_FOLDERS.familyTree }
];

function appFileFolders(libraryId: string): AppFileFolder[] {
  const rows = db.prepare(`
    SELECT i.id, i.folder_path, g.kind, g.size, i.discovered_at
    FROM library_items i LEFT JOIN gallery_details g ON g.item_id = i.id
    WHERE i.library_id = ? AND i.deleted_at IS NULL
    ORDER BY i.discovered_at DESC
  `).all(libraryId) as ItemRow[];
  const folders = new Map<AppFileFolderKey, AppFileFolder>();
  const folderFor = (key: AppFileFolderKey, folder: string): AppFileFolder => {
    let f = folders.get(key);
    if (!f) { f = { key, folder, files: 0, bytes: 0, orphans: 0, entries: [] }; folders.set(key, f); }
    return f;
  };
  for (const row of rows) {
    const known = FOLDER_KEYS.find((f) => row.folder_path === f.folder || row.folder_path.startsWith(`${f.folder}/`));
    const key: AppFileFolderKey = known?.key ?? "other";
    const bucket = folderFor(key, known?.folder ?? "");
    const owner = ownerOf(key, row.id);
    const orphan = key !== "other" && owner === null;
    bucket.files += 1;
    bucket.bytes += row.size ?? 0;
    if (orphan) bucket.orphans += 1;
    if (bucket.entries.length < ENTRY_LIMIT_PER_FOLDER) {
      bucket.entries.push({ itemId: row.id, relativePath: row.folder_path, kind: row.kind ?? "file", size: row.size ?? 0, addedAt: row.discovered_at, owner, orphan });
    }
  }
  // The app's folders first, in their fixed order, then the rest; orphans first
  // inside each so the dead weight is at the top.
  const order: AppFileFolderKey[] = [...FOLDER_KEYS.map((f) => f.key), "other"];
  return order
    .map((key) => folders.get(key))
    .filter((f): f is AppFileFolder => Boolean(f))
    .map((f) => ({ ...f, entries: [...f.entries].sort((a, b) => Number(b.orphan) - Number(a.orphan) || b.addedAt.localeCompare(a.addedAt)) }));
}

export function appStorageContents(): AppStorageContents {
  const root = getAppStoragePath();
  const house = getHouseLibrary();
  const staging = root ? path.join(root, ".staging") : null;
  return {
    path: root,
    rooms: APP_ROOMS.map(roomContents),
    staging: { ...folderStats(staging), path: staging },
    appFiles: {
      library: house ? { id: house.id, name: house.name, path: house.source_path } : null,
      folders: house ? appFileFolders(house.id) : []
    }
  };
}

export class AppStorageContentsError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AppStorageContentsError";
  }
}

/** Delete an orphan: an item in one of the app's folders that nothing owns any
 *  more. It goes to the Recycle Bin like any deleted file. Anything still owned,
 *  or outside the app's folders, is refused — the page never deletes a thing the
 *  family can still reach. */
export function deleteOrphanAppFile(itemId: string, userId: string): { relativePath: string } {
  const house = getHouseLibrary();
  if (!house) throw new AppStorageContentsError("There is no App files library.", 404);
  const row = db.prepare("SELECT id, folder_path FROM library_items WHERE id = ? AND library_id = ? AND deleted_at IS NULL").get(itemId, house.id) as { id: string; folder_path: string } | undefined;
  if (!row) throw new AppStorageContentsError("That file is not in the App files library.", 404);
  const known = FOLDER_KEYS.find((f) => row.folder_path === f.folder || row.folder_path.startsWith(`${f.folder}/`));
  if (!known) throw new AppStorageContentsError("That file is not in one of the app's folders. Move its folder to another library instead.", 409);
  if (ownerOf(known.key, row.id)) throw new AppStorageContentsError("That file still belongs to something; it is not an orphan.", 409);
  try {
    trashBook(row.id, userId, { source: "manual" });
  } catch (err) {
    if (err instanceof TrashError) throw new AppStorageContentsError(err.message, err.statusCode);
    throw err;
  }
  return { relativePath: row.folder_path };
}
