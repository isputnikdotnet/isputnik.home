// Per-library settings stored in libraries.settings_json — shared shape across
// library types plus per-type defaults. The extension list is the single source of
// truth for both scanning and (future) upload validation.
import type { LibraryType } from "./library-types.js";
import { sourcesForType, isMetadataSourceId, type MetadataSourceId } from "./metadata-sources.js";

export interface ScanSourceConfig {
  id: MetadataSourceId;
  enabled: boolean;
}

// Legacy charsets the tag-encoding repair supports (see repairEncoding in the
// audiobook scanner). Stored per-library as settings.tag_encoding; a rescan can
// override it for one run.
export const TAG_ENCODINGS = ["windows-1251", "windows-1250", "windows-1252", "koi8-r"] as const;
export type TagEncoding = typeof TAG_ENCODINGS[number];

export function isTagEncoding(value: unknown): value is TagEncoding {
  return typeof value === "string" && (TAG_ENCODINGS as readonly string[]).includes(value);
}

export interface BaseLibrarySettings {
  default_language?: string;
  // Dotless lowercase extensions, e.g. ["mp3", "m4b"]. Used for scan AND upload.
  scan_extensions: string[];
  // Ordered by priority: index 0 = highest. First source providing a field wins.
  scan_sources: ScanSourceConfig[];
}

export interface AudiobookLibrarySettings extends BaseLibrarySettings {
  show_narrator?: boolean;
  cover_filenames?: string[];
  // Default legacy charset for repairing mojibake in audio tags during scans.
  tag_encoding?: TagEncoding;
}

export const LIBRARY_TYPE_DEFAULTS: Partial<Record<LibraryType, { extensions: string[] }>> = {
  audiobook: { extensions: ["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac", "wav", "wave"] },
  ebook: { extensions: ["epub", "pdf"] }
};

export function defaultScanSources(type: LibraryType): ScanSourceConfig[] {
  return sourcesForType(type).map((source) => ({ id: source.id, enabled: source.defaultEnabled }));
}

export function defaultScanExtensions(type: LibraryType): string[] {
  return [...(LIBRARY_TYPE_DEFAULTS[type]?.extensions ?? [])];
}

export function normalizeExtensions(extensions: unknown): string[] {
  if (!Array.isArray(extensions)) return [];
  const normalized = extensions
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
    .filter((value) => /^[a-z0-9]{1,10}$/.test(value));
  return Array.from(new Set(normalized));
}

// Accepts user/stored scan_sources, drops unknown or not-applicable ids, and appends
// any registry sources missing from the list (disabled) so new sources show up on
// existing libraries without a migration.
export function normalizeScanSources(type: LibraryType, sources: unknown): ScanSourceConfig[] {
  const applicable = new Set(sourcesForType(type).map((source) => source.id));
  const result: ScanSourceConfig[] = [];
  if (Array.isArray(sources)) {
    for (const entry of sources) {
      if (!entry || typeof entry !== "object") continue;
      const { id, enabled } = entry as { id?: unknown; enabled?: unknown };
      if (typeof id !== "string" || !isMetadataSourceId(id) || !applicable.has(id)) continue;
      if (result.some((existing) => existing.id === id)) continue;
      result.push({ id, enabled: enabled === true });
    }
  }
  if (result.length === 0) {
    return defaultScanSources(type);
  }
  for (const source of sourcesForType(type)) {
    if (!result.some((existing) => existing.id === source.id)) {
      result.push({ id: source.id, enabled: false });
    }
  }
  return result;
}

// Fills missing fields from type defaults so readers never deal with absent keys.
// Preserves any type-specific keys (cover_filenames, show_narrator, ...).
export function normalizeLibrarySettings(type: LibraryType, settingsJson: string | null | undefined): BaseLibrarySettings & Record<string, unknown> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(settingsJson || "{}");
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // fall through to defaults
  }
  const extensions = normalizeExtensions(raw.scan_extensions);
  return {
    ...raw,
    default_language: typeof raw.default_language === "string" && raw.default_language.trim() ? raw.default_language.trim() : undefined,
    scan_extensions: extensions.length > 0 ? extensions : defaultScanExtensions(type),
    scan_sources: normalizeScanSources(type, raw.scan_sources),
    tag_encoding: isTagEncoding(raw.tag_encoding) ? raw.tag_encoding : undefined
  };
}

export function sourceEnabled(sources: ScanSourceConfig[], id: MetadataSourceId): boolean {
  return sources.some((source) => source.id === id && source.enabled);
}
