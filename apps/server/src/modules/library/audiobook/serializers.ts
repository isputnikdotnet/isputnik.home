import { z } from "zod";
import type { AudiobookLibraryRow } from "./types.js";
import type { LibraryCapabilities } from "../shared/library-access.js";

export const audiobookLibrarySchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourcePath: z.string().trim().min(1).max(1000),
  defaultLanguage: z.string().trim().min(2).max(12).default("en"),
  ignoreSidecar: z.boolean().default(false),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  ownerType: z.enum(["user", "group"]).nullable().optional(),
  visibility: z.enum(["private", "public"]).default("public")
});

export function publicAudiobookLibrary(row: AudiobookLibraryRow, includeSourcePath: boolean, caps: LibraryCapabilities) {
  const settings = JSON.parse(row.settings_json || "{}") as {
    ignore_sidecar?: boolean;
  };
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    ignoreSidecar: settings.ignore_sidecar === true,
    // The requesting user's effective role + capabilities on this library, used by
    // the client to gate download/edit/curate/manage UI. Server still enforces each.
    myRole: caps.role,
    canWrite: caps.canEdit,
    canDownload: caps.canDownload,
    canUpload: caps.canUpload,
    canCurate: caps.canCurate,
    canManageMembers: caps.canManageMembers,
    canManageLibrary: caps.canManageLibrary,
    scanStatus: row.scan_status,
    lastScannedAt: row.last_scanned_at,
    ownerId: row.owner_id,
    ownerType: row.owner_type ?? null,
    visibility: row.visibility ?? "public",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: row.book_count,
    fileCount: row.file_count
  };
}
