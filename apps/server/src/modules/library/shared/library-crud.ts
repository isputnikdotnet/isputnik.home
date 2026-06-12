// Shared create/update logic for libraries of any type. Type-specific routes parse
// their (core-extending) schema and delegate here; type-specific settings keys are
// passed via extraSettings / preserved on update.
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import type { LibraryType } from "./library-types.js";
import { validateLibrarySource } from "./library-source.js";
import { pathIsInside } from "./storage-roots.js";
import { setLibraryAccess, validateLibraryOwner } from "./library-access.js";
import {
  defaultCompanionExtensions,
  defaultScanExtensions,
  normalizeExtensions,
  normalizeLibrarySettings,
  normalizeScanSources,
  TAG_ENCODINGS,
  type ProgressMode,
  type ScanSourceConfig,
  type TagEncoding
} from "./library-settings.js";
import { METADATA_SOURCE_IDS } from "./metadata-sources.js";
import { parsePolicy } from "../../../core/permissions.js";

const scanSourcesSchema = z.array(z.object({
  id: z.enum(METADATA_SOURCE_IDS),
  enabled: z.boolean()
})).max(20);

const extensionSchema = z.string().trim().regex(/^\.?[a-zA-Z0-9]{1,10}$/);

export const coreLibraryCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourcePath: z.string().trim().min(1).max(1000),
  defaultLanguage: z.string().trim().min(2).max(12).default("en"),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  ownerType: z.enum(["user", "group"]).nullable().optional(),
  visibility: z.enum(["private", "public"]).default("public"),
  // Baseline role for all signed-in users when the library is public.
  publicRole: z.enum(["viewer", "member", "contributor"]).default("member"),
  // Library mode: managed (writable) or external/read-only (e.g. a Plex/ABS folder).
  mode: z.enum(["managed", "external"]).default("managed"),
  // Primary content extensions — what the scanner catalogues and uploads accept.
  scanExtensions: z.array(extensionSchema).min(1).max(40).optional(),
  // Upload-only companion files (covers, sidecars, documents). Empty = none.
  companionExtensions: z.array(extensionSchema).max(40).optional(),
  scanSources: scanSourcesSchema.optional(),
  maxUploadMB: z.number().int().min(1).max(10240).nullable().optional(),
  // Default legacy charset for tag mojibake repair (audiobook); null clears it.
  tagEncoding: z.enum(TAG_ENCODINGS).nullable().optional(),
  // Progress model (audiobook): linear book cursor vs. per-episode tracking.
  progressMode: z.enum(["linear", "episodic"]).optional()
});

export const coreLibraryUpdateSchema = coreLibraryCreateSchema.omit({ sourcePath: true });

// parseBody's generic flattens zod defaults away, so accept the input shape and
// apply the same fallbacks the schema defaults declare.
export type CoreLibraryCreateInput = z.input<typeof coreLibraryCreateSchema>;
export type CoreLibraryUpdateInput = z.input<typeof coreLibraryUpdateSchema>;

export interface LibraryCrudError {
  status: number;
  error: string;
}

function buildPolicyJson(mode: "managed" | "external", maxUploadMB: number | null | undefined): string {
  return JSON.stringify({
    mode,
    ...(maxUploadMB != null ? { maxUploadMB } : {})
  });
}

function resolveOwner(data: { ownerId?: string | null; ownerType?: "user" | "group" | null }) {
  const ownerId = data.ownerId ?? null;
  const ownerType = ownerId ? (data.ownerType ?? "user") : null;
  return { ownerId, ownerType };
}

// Reject a source folder that overlaps an existing library — the same folder, or one
// nested inside the other. Overlapping scans would index the same files twice. Source
// paths are stored as realpaths (see validateLibrarySource); compare case-insensitively
// on Windows so C:\Media and c:\media are recognised as the same folder.
function findOverlappingLibrary(sourcePath: string): string | null {
  const rows = db.prepare("SELECT name, source_path FROM libraries").all() as { name: string; source_path: string }[];
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = norm(sourcePath);
  for (const row of rows) {
    const existing = norm(row.source_path);
    if (pathIsInside(target, existing) || pathIsInside(existing, target)) {
      return row.name;
    }
  }
  return null;
}

export function createLibraryRecord(opts: {
  type: LibraryType;
  data: CoreLibraryCreateInput;
  userId: string;
  ip: string;
  // Type-specific settings keys merged into settings_json (e.g. cover_filenames).
  extraSettings?: Record<string, unknown>;
}): { libraryId: string } | LibraryCrudError {
  const { type, data } = opts;

  let sourcePath: string;
  try {
    sourcePath = validateLibrarySource(data.sourcePath);
  } catch (err) {
    return { status: 400, error: err instanceof Error ? err.message : "Invalid library source path" };
  }

  const overlapping = findOverlappingLibrary(sourcePath);
  if (overlapping) {
    return {
      status: 409,
      error: `This folder overlaps the existing library "${overlapping}". Pick a folder that isn't already used by another library.`
    };
  }

  const { ownerId, ownerType } = resolveOwner(data);
  const ownerError = validateLibraryOwner(ownerId, ownerType, type);
  if (ownerError) {
    return ownerError;
  }

  const visibility = data.visibility ?? "public";
  const publicRole = data.publicRole ?? "member";
  const scanExtensions = data.scanExtensions ? normalizeExtensions(data.scanExtensions) : defaultScanExtensions(type);
  const settings: Record<string, unknown> = {
    ...(opts.extraSettings ?? {}),
    default_language: data.defaultLanguage ?? "en",
    scan_extensions: scanExtensions.length > 0 ? scanExtensions : defaultScanExtensions(type),
    companion_extensions: data.companionExtensions
      ? normalizeExtensions(data.companionExtensions)
      : defaultCompanionExtensions(type),
    scan_sources: normalizeScanSources(type, data.scanSources),
    ...(data.tagEncoding ? { tag_encoding: data.tagEncoding } : {}),
    ...(data.progressMode ? { progress_mode: data.progressMode } : {})
  };

  const libraryId = nanoid(16);
  db.prepare(`
    INSERT INTO libraries (id, name, type, source_path, settings_json, created_by, owner_id, owner_type, policy_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    libraryId, data.name, type, sourcePath, JSON.stringify(settings), opts.userId,
    ownerId, ownerType, buildPolicyJson(data.mode ?? "managed", data.maxUploadMB)
  );

  // Unified access model: Everyone grant (if public) + owner as manager.
  setLibraryAccess(libraryId, {
    visibility,
    publicRole,
    ownerType,
    ownerId,
    createdBy: opts.userId
  });

  logActivity({
    event: `library.${type}.created`,
    actorUserId: opts.userId,
    targetType: "library",
    targetId: libraryId,
    detail: `Created ${type} library "${data.name}" and queued a scan.`,
    ipAddress: opts.ip
  });

  return { libraryId };
}

export function updateLibraryRecord(opts: {
  type: LibraryType;
  id: string;
  data: CoreLibraryUpdateInput;
  userId: string;
  ip: string;
}): { updated: true } | LibraryCrudError {
  const { type, id, data } = opts;
  const existing = db.prepare("SELECT id, settings_json, policy_json FROM libraries WHERE id = ? AND type = ?")
    .get(id, type) as { id: string; settings_json: string; policy_json: string } | undefined;
  if (!existing) {
    return { status: 404, error: `${type === "audiobook" ? "Audiobook" : "Library"} library not found` };
  }

  const { ownerId, ownerType } = resolveOwner(data);
  const ownerError = validateLibraryOwner(ownerId, ownerType, type, id);
  if (ownerError) {
    return ownerError;
  }

  const visibility = data.visibility ?? "public";
  const publicRole = data.publicRole ?? "member";

  // Merge core fields into existing settings, preserving type-specific keys.
  const settings = normalizeLibrarySettings(type, existing.settings_json);
  if (data.defaultLanguage) settings.default_language = data.defaultLanguage;
  if (data.scanExtensions) {
    const extensions = normalizeExtensions(data.scanExtensions);
    if (extensions.length > 0) settings.scan_extensions = extensions;
  }
  if (data.companionExtensions) {
    // Empty list is a valid choice: uploads then accept scan extensions only.
    settings.companion_extensions = normalizeExtensions(data.companionExtensions);
  }
  if (data.scanSources) {
    settings.scan_sources = normalizeScanSources(type, data.scanSources);
  }
  if (data.tagEncoding !== undefined) {
    if (data.tagEncoding === null) {
      delete settings.tag_encoding;
    } else {
      settings.tag_encoding = data.tagEncoding;
    }
  }
  if (data.progressMode !== undefined) {
    settings.progress_mode = data.progressMode;
  }

  db.prepare(`
    UPDATE libraries
    SET name = ?, owner_id = ?, owner_type = ?, policy_json = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    data.name, ownerId, ownerType,
    buildPolicyJson(data.mode ?? "managed", data.maxUploadMB), JSON.stringify(settings), id
  );

  // Re-sync the Everyone + owner assignments with the new visibility/owner.
  setLibraryAccess(id, {
    visibility,
    publicRole,
    ownerType,
    ownerId,
    createdBy: opts.userId
  });

  logActivity({
    event: `library.${type}.updated`,
    actorUserId: opts.userId,
    targetType: "library",
    targetId: id,
    detail: `Updated ${type} library "${data.name}".`,
    ipAddress: opts.ip
  });

  return { updated: true };
}

export interface AdminLibrarySettings {
  defaultLanguage: string | null;
  scanExtensions: string[];
  companionExtensions: string[];
  scanSources: ScanSourceConfig[];
  maxUploadMB: number | null;
  tagEncoding: TagEncoding | null;
  progressMode: ProgressMode;
}

// Settings payload for admin views (create/edit/rescan dialogs in the Control Panel).
export function serializeLibrarySettingsForAdmin(
  type: LibraryType,
  settingsJson: string | null | undefined,
  policyJson: string | null | undefined
): AdminLibrarySettings {
  const settings = normalizeLibrarySettings(type, settingsJson);
  const policy = parsePolicy(policyJson);
  return {
    defaultLanguage: settings.default_language ?? null,
    scanExtensions: settings.scan_extensions,
    companionExtensions: settings.companion_extensions,
    scanSources: settings.scan_sources,
    maxUploadMB: policy.maxUploadMB ?? null,
    tagEncoding: (settings as { tag_encoding?: TagEncoding }).tag_encoding ?? null,
    progressMode: (settings as { progress_mode?: ProgressMode }).progress_mode ?? "linear"
  };
}
