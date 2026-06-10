import type { AudiobookLibraryRow } from "./types.js";
import type { LibraryCapabilities } from "../shared/library-access.js";
import { getEveryoneRole, parsePolicy } from "../../../core/permissions.js";
import { coreLibraryCreateSchema, serializeLibrarySettingsForAdmin } from "../shared/library-crud.js";

export const audiobookLibrarySchema = coreLibraryCreateSchema;

export function publicAudiobookLibrary(row: AudiobookLibraryRow, includeSourcePath: boolean, caps: LibraryCapabilities) {
  // Public access is the Everyone assignment (source of truth), not the legacy column.
  const everyoneRole = getEveryoneRole("library", row.id);
  const policy = parsePolicy(row.policy_json);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    // Scan/upload settings, exposed only on the admin (manage) view.
    settings: includeSourcePath ? serializeLibrarySettingsForAdmin("audiobook", row.settings_json, row.policy_json) : undefined,
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
    visibility: everyoneRole ? "public" : "private",
    publicRole: everyoneRole ?? "member",
    mode: policy.mode ?? "managed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: row.book_count,
    fileCount: row.file_count
  };
}
