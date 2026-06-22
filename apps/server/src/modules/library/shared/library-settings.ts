// Per-library settings stored in libraries.settings_json — shared shape across
// library types plus per-type defaults. The extension list is the single source of
// truth for scanning; uploads accept it plus per-type companion files (see
// uploadExtensionsForType below).
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
  // Dotless lowercase extensions, e.g. ["mp3", "m4b"]. Defines what the scanner
  // treats as primary content (audio tracks / ebooks); uploads accept these too.
  scan_extensions: string[];
  // Extra extensions accepted ONLY in uploads (covers, metadata sidecars,
  // documents). Never scanned as primary content — the scanner has its own
  // cover/document/sidecar handling. Configured per library like scan_extensions.
  companion_extensions: string[];
  // Ordered by priority: index 0 = highest. First source providing a field wins.
  scan_sources: ScanSourceConfig[];
  // Opt-in: infer series + position from in-file metadata and folder shape during
  // scan. Off by default, so libraries keep today's flat behaviour until enabled.
  auto_series?: boolean;
}

// How playback progress is modelled. linear = one resume cursor for the whole book
// (chapters of a single work). episodic = each track is an independent unit with its
// own played/position state (radio shows, podcasts), so skipping one never touches
// the others.
export type ProgressMode = "linear" | "episodic";

export interface AudiobookLibrarySettings extends BaseLibrarySettings {
  show_narrator?: boolean;
  cover_filenames?: string[];
  // Default legacy charset for repairing mojibake in audio tags during scans.
  tag_encoding?: TagEncoding;
  progress_mode?: ProgressMode;
}

// Per-type defaults. `companions` seeds companion_extensions for new libraries
// (and for existing ones that predate the setting): cover art, metadata sidecars
// (metadata.json, .xml), and bundled documents for audiobooks.
export const LIBRARY_TYPE_DEFAULTS: Partial<Record<LibraryType, { extensions: string[]; companions: string[] }>> = {
  audiobook: {
    extensions: ["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac", "wav", "wave"],
    companions: ["png", "jpg", "jpeg", "webp", "xml", "json", "epub", "pdf"]
  },
  ebook: { extensions: ["epub", "pdf", "fb2", "mobi", "azw3", "txt", "rtf"], companions: ["png", "jpg", "jpeg", "webp", "xml", "json"] }
};

export function defaultCompanionExtensions(type: LibraryType): string[] {
  return [...(LIBRARY_TYPE_DEFAULTS[type]?.companions ?? [])];
}

// Everything a library accepts in an upload: its scan extensions plus its
// configured companion files.
export function uploadAcceptExtensions(settings: BaseLibrarySettings): string[] {
  return Array.from(new Set([...settings.scan_extensions, ...settings.companion_extensions]));
}

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
    // Absent key (library predates the setting) → type defaults; an explicit
    // empty list means "no companion files" and is respected.
    companion_extensions: raw.companion_extensions === undefined
      ? defaultCompanionExtensions(type)
      : normalizeExtensions(raw.companion_extensions),
    scan_sources: normalizeScanSources(type, raw.scan_sources),
    auto_series: raw.auto_series === true,
    tag_encoding: isTagEncoding(raw.tag_encoding) ? raw.tag_encoding : undefined,
    progress_mode: raw.progress_mode === "episodic" ? "episodic" : "linear"
  };
}

export function sourceEnabled(sources: ScanSourceConfig[], id: MetadataSourceId): boolean {
  return sources.some((source) => source.id === id && source.enabled);
}
