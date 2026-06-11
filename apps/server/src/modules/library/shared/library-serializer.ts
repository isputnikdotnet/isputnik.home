// One public shape for libraries of every type — consumed by the unified
// Control Panel Libraries page and any per-type route that lists libraries.
import type { LibraryType } from "./library-types.js";
import type { LibraryCapabilities } from "./library-access.js";
import { getEveryoneRole, parsePolicy } from "../../../core/permissions.js";
import { serializeLibrarySettingsForAdmin } from "./library-crud.js";

export interface LibraryListRow {
  id: string;
  name: string;
  type: string;
  source_path: string;
  settings_json: string;
  scan_status: string;
  last_scanned_at: string | null;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  policy_json: string;
  created_at: string;
  updated_at: string;
  book_count: number;
  // Audiobooks count audio files; ebooks count available documents.
  file_count?: number;
  total_size_bytes?: number | null;
}

export function publicLibrary(row: LibraryListRow, includeSourcePath: boolean, caps: LibraryCapabilities) {
  // Public access is the Everyone assignment (source of truth), not a column.
  const everyoneRole = getEveryoneRole("library", row.id);
  const policy = parsePolicy(row.policy_json);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    // Scan/upload settings, exposed only on the admin (manage) view.
    settings: includeSourcePath ? serializeLibrarySettingsForAdmin(row.type as LibraryType, row.settings_json, row.policy_json) : undefined,
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
    fileCount: row.file_count ?? null,
    totalSizeBytes: row.total_size_bytes ?? null
  };
}
