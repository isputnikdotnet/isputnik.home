// Video libraries as this server keeps them (docs/video-architecture.md → Who
// keeps what): a `libraries` row of type 'video' and its access assignments,
// exactly like any library — so the Libraries page, the access editor and
// member pages treat them alike — while what is in them lives in the engine.
//
// A video library is remote: its folder is on the engine's mount, not here. It
// is stored as `video:/<folder>` in source_path, a value that can never be
// inside one of this server's own folders, so the checks that compare library
// folders with each other and with app storage leave it alone. It is not one of
// LIBRARY_TYPES: none of this server's scanners, thumbnails or trash touch it.
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { getEveryoneRole } from "../../../core/permissions.js";
import { deleteLibraryAccess, libraryCapabilities, setLibraryAccess, validateLibraryOwner } from "../shared/library-access.js";
import type { LibraryRow } from "../../../db/rows.js";

export const VIDEO_LIBRARY_TYPE = "video";
export const VIDEO_SOURCE_PREFIX = "video:/";

export const VIDEO_KINDS = ["shows", "movies"] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];

const folderSchema = z.string().trim().min(1).max(1000)
  .transform((value) => value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/"))
  .refine((value) => value.length > 0 && !value.split("/").includes(".."), "Pick a folder inside the video app's media");

export const videoLibraryCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(VIDEO_KINDS),
  folder: folderSchema,
  defaultLanguage: z.string().trim().regex(/^[a-z]{2}(-[A-Za-z]{2})?$/).default("en"),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  ownerType: z.enum(["user", "group"]).nullable().optional(),
  visibility: z.enum(["private", "public"]).default("public"),
  publicRole: z.enum(["viewer", "member", "contributor"]).default("member")
});

/** A library keeps the kind it was made with: shows and movies are read differently. */
export const videoLibraryUpdateSchema = videoLibraryCreateSchema.omit({ kind: true });

export type VideoLibraryCreate = z.infer<typeof videoLibraryCreateSchema>;
export type VideoLibraryUpdate = z.infer<typeof videoLibraryUpdateSchema>;

export interface VideoSettings {
  kind: VideoKind;
  folder: string;
  default_language: string;
}

export function videoSettings(row: Pick<LibraryRow, "settings_json">): VideoSettings {
  try {
    const parsed = JSON.parse(row.settings_json) as Partial<VideoSettings>;
    return {
      kind: parsed.kind === "movies" ? "movies" : "shows",
      folder: typeof parsed.folder === "string" ? parsed.folder : "",
      default_language: typeof parsed.default_language === "string" ? parsed.default_language : "en"
    };
  } catch {
    return { kind: "shows", folder: "", default_language: "en" };
  }
}

/** What the engine is told about a library (its PUT body). */
export function engineBody(row: Pick<LibraryRow, "name" | "settings_json">): { name: string; kind: VideoKind; folder: string; language: string } {
  const settings = videoSettings(row);
  return { name: row.name, kind: settings.kind, folder: settings.folder, language: settings.default_language };
}

export class VideoLibraryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function resolveOwner(data: { ownerId?: string | null; ownerType?: "user" | "group" | null }) {
  const ownerId = data.ownerId ?? null;
  return { ownerId, ownerType: ownerId ? (data.ownerType ?? "user") : null };
}

export function getVideoLibrary(id: string): LibraryRow | null {
  return (db.prepare("SELECT * FROM libraries WHERE id = ? AND type = ?").get(id, VIDEO_LIBRARY_TYPE) as LibraryRow | undefined) ?? null;
}

export function listVideoLibraries(): LibraryRow[] {
  return db.prepare("SELECT * FROM libraries WHERE type = ? ORDER BY name COLLATE NOCASE").all(VIDEO_LIBRARY_TYPE) as LibraryRow[];
}

/** Write the row and its access. The engine is told by the caller, which removes
 *  the row again if the engine refuses it, so the two never disagree for long. */
export function insertVideoLibrary(data: VideoLibraryCreate, userId: string): LibraryRow {
  const { ownerId, ownerType } = resolveOwner(data);
  const ownerError = validateLibraryOwner(ownerId, ownerType);
  if (ownerError) throw new VideoLibraryError(ownerError.error, ownerError.status);
  const clash = db.prepare("SELECT name FROM libraries WHERE type = ? AND source_path = ?").get(VIDEO_LIBRARY_TYPE, VIDEO_SOURCE_PREFIX + data.folder) as { name: string } | undefined;
  if (clash) throw new VideoLibraryError(`The library "${clash.name}" already uses this folder.`, 409);

  const id = nanoid(16);
  const settings: VideoSettings = { kind: data.kind, folder: data.folder, default_language: data.defaultLanguage };
  db.prepare(`
    INSERT INTO libraries (id, name, type, source_path, settings_json, created_by, owner_id, owner_type, policy_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, VIDEO_LIBRARY_TYPE, VIDEO_SOURCE_PREFIX + data.folder, JSON.stringify(settings), userId, ownerId, ownerType,
    // Read-only from here: home never writes into the engine's folders.
    JSON.stringify({ mode: "external" }));
  setLibraryAccess(id, { visibility: data.visibility, publicRole: data.publicRole, ownerType, ownerId, createdBy: userId });
  return getVideoLibrary(id)!;
}

export function updateVideoLibrary(id: string, data: VideoLibraryUpdate, userId: string): { before: LibraryRow; after: LibraryRow } {
  const before = getVideoLibrary(id);
  if (!before) throw new VideoLibraryError("Video library not found", 404);
  const { ownerId, ownerType } = resolveOwner(data);
  const ownerError = validateLibraryOwner(ownerId, ownerType);
  if (ownerError) throw new VideoLibraryError(ownerError.error, ownerError.status);
  const clash = db.prepare("SELECT name FROM libraries WHERE type = ? AND source_path = ? AND id != ?").get(VIDEO_LIBRARY_TYPE, VIDEO_SOURCE_PREFIX + data.folder, id) as { name: string } | undefined;
  if (clash) throw new VideoLibraryError(`The library "${clash.name}" already uses this folder.`, 409);

  const settings: VideoSettings = { ...videoSettings(before), folder: data.folder, default_language: data.defaultLanguage };
  db.prepare(`
    UPDATE libraries SET name = ?, source_path = ?, settings_json = ?, owner_id = ?, owner_type = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(data.name, VIDEO_SOURCE_PREFIX + data.folder, JSON.stringify(settings), ownerId, ownerType, id);
  setLibraryAccess(id, { visibility: data.visibility, publicRole: data.publicRole, ownerType, ownerId, createdBy: userId });
  return { before, after: getVideoLibrary(id)! };
}

/** Put a row back exactly as it was, after the engine refused the change. */
export function restoreVideoLibrary(row: LibraryRow): void {
  db.prepare(`
    UPDATE libraries SET name = ?, source_path = ?, settings_json = ?, owner_id = ?, owner_type = ?, updated_at = ?
    WHERE id = ?
  `).run(row.name, row.source_path, row.settings_json, row.owner_id, row.owner_type, row.updated_at, row.id);
}

export function deleteVideoLibraryRow(id: string): void {
  deleteLibraryAccess(id);
  db.prepare("DELETE FROM libraries WHERE id = ? AND type = ?").run(id, VIDEO_LIBRARY_TYPE);
}

/** One library, as the engine counted it (GET /video/api/admin/libraries). */
export interface EngineLibrary {
  id: string;
  state: "active" | "detached";
  scanState: "idle" | "queued" | "scanning" | "error";
  scanError: string | null;
  lastScanAt: string | null;
  titles: number;
  episodes: number;
  sizeBytes: number;
}

/** The shape the Libraries page reads for every type (library-serializer.ts),
 *  with what only a video library has: its kind, its folder on the engine, and
 *  the engine's counts — null when the engine did not answer. */
export function publicVideoLibrary(row: LibraryRow, user: { id: string; role: string }, engine: EngineLibrary | null | undefined, includeAdmin: boolean) {
  const caps = libraryCapabilities(row, user.id, user.role);
  const everyoneRole = getEveryoneRole("library", row.id);
  const settings = videoSettings(row);
  return {
    id: row.id,
    name: row.name,
    type: VIDEO_LIBRARY_TYPE,
    kind: settings.kind,
    folder: includeAdmin ? settings.folder : undefined,
    sourcePath: includeAdmin ? row.source_path : undefined,
    defaultLanguage: settings.default_language,
    myRole: caps.role,
    canWrite: caps.canEdit,
    canDownload: caps.canDownload,
    canUpload: false,
    canDelete: caps.canDelete,
    canCurate: caps.canCurate,
    canManageMembers: caps.canManageMembers,
    canManageLibrary: caps.canManageLibrary,
    scanStatus: engine?.scanState === "scanning" || engine?.scanState === "queued" ? "scanning" : engine?.scanState === "error" ? "error" : "idle",
    lastScannedAt: engine?.lastScanAt ?? null,
    ownerId: row.owner_id,
    ownerType: row.owner_type ?? null,
    visibility: everyoneRole ? "public" : "private",
    publicRole: everyoneRole ?? "member",
    mode: "external",
    role: null,
    inbox: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: engine?.titles ?? null,
    fileCount: engine ? (settings.kind === "shows" ? engine.episodes : engine.titles) : null,
    totalSizeBytes: engine?.sizeBytes ?? null,
    engine: engine === undefined ? null : engine === null
      ? { online: false as const }
      : { online: true as const, scanState: engine.scanState, scanError: engine.scanError, lastScanAt: engine.lastScanAt, titles: engine.titles, episodes: engine.episodes }
  };
}

export function noteVideoLibrary(event: string, row: Pick<LibraryRow, "id" | "name">, userId: string, ip: string, detail: string): void {
  logActivity({ event: `library.video.${event}`, actorUserId: userId, targetType: "library", targetId: row.id, detail, ipAddress: ip });
}
