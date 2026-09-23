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
import path from "node:path";
import { db } from "../../db.js";
import { APP_ROOMS, getAppStoragePath, type AppRoom } from "../../core/app-storage.js";
import { countFolder, type FolderStats } from "./app-storage.js";
import { HOUSE_FOLDERS, getHouseLibrary } from "./gallery/house-library.js";
import { appStorageView } from "./app-storage-service.js";
import { trashBook } from "./shared/trash.js";
import { TrashError } from "./shared/trash-settings.js";
import type {
  FamilyTreePersonRow,
  GalleryDetailRow,
  GalleryMusicTrackRow,
  GallerySlideshowRow,
  LibraryItemRow,
  Nullable,
  StoryRow
} from "../../db/rows.js";

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

export { countFolder, type FolderStats };

export interface RoomContents {
  room: AppRoom;
  /** app = inside App storage; own = in a place of its own; off = App storage is off. */
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

type ItemRow = Pick<LibraryItemRow, "id" | "folder_path" | "discovered_at"> & Nullable<Pick<GalleryDetailRow, "kind" | "size">>;

function libraryStats(libraryId: string): { files: number; bytes: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS files, COALESCE(SUM(g.size), 0) AS bytes
    FROM library_items i LEFT JOIN gallery_details g ON g.item_id = i.id
    WHERE i.library_id = ? AND i.deleted_at IS NULL
  `).get(libraryId) as { files: number; bytes: number };
  return row;
}

async function roomContents(room: AppRoom, enabled: boolean, parts: ReturnType<typeof appStorageView>["parts"]): Promise<RoomContents> {
  const view = parts.find((part) => part.part === room)!;
  const mode = !enabled ? "off" : view.inside ? "app" : "own";
  const base = { room, mode, path: enabled ? view.folder : null, library: view.library, complete: true } as const;
  switch (room) {
    case "inbox":
    case "house": {
      if (!view.library) return { ...base, files: 0, bytes: 0 };
      return { ...base, ...libraryStats(view.library.id) };
    }
    case "renders":
    case "maps": {
      const stats = await countFolder(enabled ? view.folder : null);
      return { ...base, files: stats.files, bytes: stats.bytes, complete: stats.complete };
    }
  }
}

/** Who owns an item: first the owner its folder is for, then any other. A photo
 *  uploaded while writing a story sits in a dated folder and still belongs to the
 *  story; a family-tree photo may be in a story too. */
function ownerOf(key: AppFileFolderKey, itemId: string): AppFileOwner | null {
  if (key !== "other") {
    const byFolder = ownerByKind(key, itemId);
    if (byFolder) return byFolder;
  }
  for (const kind of OWNER_KINDS) {
    if (kind === key) continue;
    const owner = ownerByKind(kind, itemId);
    if (owner) return owner;
  }
  return null;
}

const OWNER_KINDS: Exclude<AppFileFolderKey, "other">[] = ["recordings", "movies", "familyTree", "voiceNotes", "music"];

/** The owner of one kind: recordings → a story (block, chapter hero or cover),
 *  movies → a slideshow (movie, member, cover or card), and so on. */
function ownerByKind(key: Exclude<AppFileFolderKey, "other">, itemId: string): AppFileOwner | null {
  switch (key) {
    case "recordings": {
      const row = db.prepare(`
        SELECT s.id, s.title FROM stories s
        WHERE s.deleted_at IS NULL AND (
          s.cover_item_id = ?
          OR EXISTS (SELECT 1 FROM story_chapters c WHERE c.story_id = s.id AND c.hero_item_id = ?)
          OR EXISTS (SELECT 1 FROM story_blocks b JOIN story_chapters c ON c.id = b.chapter_id
                     WHERE c.story_id = s.id AND b.entity_type = 'gallery' AND b.entity_id = ?)
          OR EXISTS (SELECT 1 FROM story_block_items bi
                     JOIN story_blocks b ON b.id = bi.block_id
                     JOIN story_chapters c ON c.id = b.chapter_id
                     WHERE c.story_id = s.id AND bi.item_id = ?)
        )
        LIMIT 1
      `).get(itemId, itemId, itemId, itemId) as Pick<StoryRow, "id" | "title"> | undefined;
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
      `).get(itemId) as (Pick<LibraryItemRow, "id" | "library_id" | "folder_path"> & { title: string }) | undefined;
      if (!row) return null;
      const folder = row.folder_path.includes("/") ? row.folder_path.slice(0, row.folder_path.lastIndexOf("/")) : "";
      return { type: "photo", id: row.id, title: row.title, folder, libraryId: row.library_id };
    }
    case "music": {
      const row = db.prepare("SELECT id, title FROM gallery_music_tracks WHERE item_id = ? LIMIT 1").get(itemId) as Pick<GalleryMusicTrackRow, "id" | "title"> | undefined;
      return row ? { type: "track", id: row.id, title: row.title } : null;
    }
    case "movies": {
      const row = db.prepare(`
        SELECT id, name FROM gallery_slideshows
        WHERE movie_item_id = ? OR cover_item_id = ? OR title_photo_item_id = ? OR closing_photo_item_id = ? OR outro_item_id = ?
          OR id IN (SELECT slideshow_id FROM gallery_slideshow_items WHERE item_id = ?)
        LIMIT 1
      `).get(itemId, itemId, itemId, itemId, itemId, itemId) as Pick<GallerySlideshowRow, "id" | "name"> | undefined;
      return row ? { type: "slideshow", id: row.id, title: row.name } : null;
    }
    case "familyTree": {
      const row = db.prepare(`
        SELECT p.id, p.name FROM family_tree_persons p
        WHERE p.portrait_item_id = ? OR p.portrait_file_item_id = ?
          OR p.id IN (SELECT person_id FROM family_tree_photos WHERE item_id = ?)
          OR p.id IN (SELECT ev.person_id FROM family_tree_event_photos ep JOIN family_tree_events ev ON ev.id = ep.event_id WHERE ep.item_id = ?)
        LIMIT 1
      `).get(itemId, itemId, itemId, itemId) as Pick<FamilyTreePersonRow, "id" | "name"> | undefined;
      return row ? { type: "person", id: row.id, title: row.name } : null;
    }
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

/** Counted when asked (the Contents page is opened on purpose), walking the
 *  folder parts asynchronously so the server keeps answering meanwhile. */
export async function appStorageContents(): Promise<AppStorageContents> {
  const root = getAppStoragePath();
  const view = appStorageView();
  const house = getHouseLibrary();
  const staging = root ? path.join(root, ".staging") : null;
  const rooms: RoomContents[] = [];
  for (const room of APP_ROOMS) rooms.push(await roomContents(room, view.enabled, view.parts));
  return {
    path: root,
    rooms,
    staging: { ...(await countFolder(staging)), path: staging },
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
  const row = db.prepare("SELECT id, folder_path FROM library_items WHERE id = ? AND library_id = ? AND deleted_at IS NULL").get(itemId, house.id) as Pick<LibraryItemRow, "id" | "folder_path"> | undefined;
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
