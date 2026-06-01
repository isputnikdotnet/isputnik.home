import { z } from "zod";
import type { AudiobookLibraryRow } from "./types.js";

export const libraryOverridesSchema = z.object({
  author: z.string().trim().max(300).optional(),
  narrator: z.string().trim().max(300).optional(),
  description: z.string().trim().max(5000).optional(),
  categoryKey: z.string().trim().max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional()
});

export const audiobookLibrarySchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourcePath: z.string().trim().min(1).max(1000),
  defaultLanguage: z.string().trim().min(2).max(12).default("en"),
  ignoreSidecar: z.boolean().default(false),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  ownerType: z.enum(["user", "group"]).nullable().optional(),
  visibility: z.enum(["private", "public"]).default("public"),
  sectionId: z.string().trim().min(1).max(64).nullable().optional(),
  overrides: libraryOverridesSchema.nullable().optional()
});

// Map the camelCase API override shape onto the snake_case form stored in
// settings_json (and read by the scanner). Returns undefined when nothing is set
// so empty override blocks are not persisted.
export function overridesToSettings(overrides: z.infer<typeof libraryOverridesSchema> | null | undefined) {
  if (!overrides) {
    return undefined;
  }
  const stored: {
    author?: string;
    narrator?: string;
    description?: string;
    category_key?: string;
    tags?: string[];
  } = {};
  if (overrides.author?.trim()) stored.author = overrides.author.trim();
  if (overrides.narrator?.trim()) stored.narrator = overrides.narrator.trim();
  if (overrides.description?.trim()) stored.description = overrides.description.trim();
  if (overrides.categoryKey?.trim()) stored.category_key = overrides.categoryKey.trim();
  const tags = (overrides.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > 0) stored.tags = tags;
  return Object.keys(stored).length > 0 ? stored : undefined;
}

export function publicAudiobookLibrary(row: AudiobookLibraryRow, includeSourcePath: boolean) {
  const settings = JSON.parse(row.settings_json || "{}") as {
    ignore_sidecar?: boolean;
    section_id?: string;
    overrides?: { author?: string; narrator?: string; description?: string; category_key?: string; tags?: string[] };
  };
  const sectionId = settings.section_id ?? null;
  const overrides = settings.overrides ?? null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    ignoreSidecar: settings.ignore_sidecar === true,
    sectionId,
    specialSection: Boolean(sectionId),
    // Override values back the admin edit form, so only expose them to admins.
    overrides: includeSourcePath
      ? {
          author: overrides?.author ?? "",
          narrator: overrides?.narrator ?? "",
          description: overrides?.description ?? "",
          categoryKey: overrides?.category_key ?? "",
          tags: overrides?.tags ?? []
        }
      : undefined,
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
