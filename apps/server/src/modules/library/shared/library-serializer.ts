// One public shape for libraries of every type — consumed by the unified
// Control Panel Libraries page and any per-type route that lists libraries.
import type { LibraryType } from "./library-types.js";
import type { LibraryCapabilities } from "./library-access.js";
import { getEveryoneRole, parsePolicy } from "../../../core/permissions.js";
import { serializeLibrarySettingsForAdmin } from "./library-crud.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "./library-settings.js";
import { db } from "../../../db.js";
import type { LibraryRow, UserRow } from "../../../db/rows.js";

// A libraries row (the list queries select libraries.*) plus its counts.
export interface LibraryListRow extends Pick<
  LibraryRow,
  | "id" | "name" | "type" | "source_path" | "settings_json" | "scan_status" | "last_scanned_at"
  | "owner_id" | "owner_type" | "policy_json" | "role" | "created_at" | "updated_at"
> {
  // Personal libraries (docs/photo-sync-plan.md); the list queries select libraries.*,
  // so these are there, but a row built by hand may leave them out.
  personal_user_id?: LibraryRow["personal_user_id"];
  personal_orphaned_at?: LibraryRow["personal_orphaned_at"];
  personal_adopted_at?: LibraryRow["personal_adopted_at"];
  book_count: number;
  // Audiobooks count audio files; ebooks count available documents.
  file_count?: number;
  total_size_bytes?: number | null;
}

/** Whose personal library this is, or null for an ordinary library. */
function personalOf(row: LibraryListRow) {
  if (!row.personal_user_id) return null;
  const owner = db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.personal_user_id) as Pick<UserRow, "display_name"> | undefined;
  return {
    ownerId: row.personal_user_id,
    ownerName: owner?.display_name ?? "",
    orphaned: row.personal_orphaned_at != null,
    orphanedAt: row.personal_orphaned_at ?? null,
    adoptedAt: row.personal_adopted_at ?? null
  };
}

/** Someone else's personal library, as an admin's list shows it: whose it is and its
 *  size, nothing more (docs/photo-sync-plan.md, decision 3) — no folder, no settings,
 *  no counts. The caller has already found that the viewer cannot open it. */
export function redactedPersonalLibrary(row: LibraryListRow, caps: LibraryCapabilities) {
  return { ...publicLibrary(row, false, caps), bookCount: 0, fileCount: null };
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
    canDelete: caps.canDelete,
    canCurate: caps.canCurate,
    canManageMembers: caps.canManageMembers,
    canManageLibrary: caps.canManageLibrary,
    // Upload constraints for the client-side dropzone (mirrors the server policy;
    // harmless to expose to non-uploaders). Scan extensions plus the library's
    // configured companion files (covers, sidecars, documents).
    uploadExtensions: uploadAcceptExtensions(normalizeLibrarySettings(row.type as LibraryType, row.settings_json)),
    maxUploadMB: policy.maxUploadMB ?? null,
    scanStatus: row.scan_status,
    lastScannedAt: row.last_scanned_at,
    ownerId: row.owner_id,
    ownerType: row.owner_type ?? null,
    visibility: everyoneRole ? "public" : "private",
    publicRole: everyoneRole ?? "member",
    mode: policy.mode ?? "managed",
    // A system library (gallery): 'inbox' = the Photo Inbox, 'app-files' = App
    // files. Exposed to everyone, not only admins — the gallery labels both,
    // leaves them out of its implicit scope, and routes the review page on the Inbox.
    role: row.role ?? null,
    inbox: row.role === "inbox",
    personal: personalOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: row.book_count,
    fileCount: row.file_count ?? null,
    totalSizeBytes: row.total_size_bytes ?? null
  };
}
