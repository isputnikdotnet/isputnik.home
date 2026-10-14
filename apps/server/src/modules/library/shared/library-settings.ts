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

// ── Back sides (gallery) ──────────────────────────────────────────────────────
// How a gallery library pairs the BACK of a scanned print with its front by file
// name (docs/back-sides-proposal.md). Three ordered sources, tried in the order
// stored, each on or off: the Epson FastFoto preset (`{name}_b`, with the `_a`
// enhanced-twin rule), the "named back" preset (`{name}_back` and friends) and
// the library's own patterns. `{name}` stands for the front's file stem; the
// rest of a pattern is literal, matched ignoring case. Off everywhere by default:
// turning it on is a decision per library, since it moves existing photos out of
// the grid and into their fronts.
export const BACK_SIDE_SOURCE_IDS = ["epson", "named", "custom"] as const;
export type BackSideSourceId = typeof BACK_SIDE_SOURCE_IDS[number];

export interface BackSideSourceConfig {
  id: BackSideSourceId;
  enabled: boolean;
}

export interface BackSidesSettings {
  sources: BackSideSourceConfig[];
  patterns: string[];
}

export const BACK_SIDE_PRESETS: Record<Exclude<BackSideSourceId, "custom">, readonly string[]> = {
  epson: ["{name}_b"],
  named: ["{name}_back", "{name}-back", "{name}.back"]
};

export const BACK_PATTERN_MAX_LENGTH = 64;

/** A custom back pattern: `{name}` exactly once, 2–64 characters, something
 *  besides the placeholder, and nothing a file name can't carry. */
export function isValidBackPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const pattern = value.trim();
  if (pattern.length < 2 || pattern.length > BACK_PATTERN_MAX_LENGTH) return false;
  if (pattern.split("{name}").length !== 2) return false;
  if (pattern === "{name}") return false;
  if (/[\\/:*?"<>|{}]/.test(pattern.replace("{name}", ""))) return false;
  if (Array.from(pattern).some((ch) => ch.charCodeAt(0) < 32)) return false;
  return true;
}

export function defaultBackSides(): BackSidesSettings {
  return { sources: BACK_SIDE_SOURCE_IDS.map((id) => ({ id, enabled: false })), patterns: [] };
}

export function isBackSideSourceId(value: unknown): value is BackSideSourceId {
  return typeof value === "string" && (BACK_SIDE_SOURCE_IDS as readonly string[]).includes(value);
}

// Accepts a stored or submitted back_sides value: unknown sources are dropped,
// missing ones appended (off) so a new source shows up on existing libraries,
// invalid patterns dropped, duplicates collapsed.
export function normalizeBackSides(raw: unknown): BackSidesSettings {
  const result = defaultBackSides();
  if (!raw || typeof raw !== "object") return result;
  const { sources, patterns } = raw as { sources?: unknown; patterns?: unknown };
  const ordered: BackSideSourceConfig[] = [];
  if (Array.isArray(sources)) {
    for (const entry of sources) {
      if (!entry || typeof entry !== "object") continue;
      const { id, enabled } = entry as { id?: unknown; enabled?: unknown };
      if (!isBackSideSourceId(id) || ordered.some((existing) => existing.id === id)) continue;
      ordered.push({ id, enabled: enabled === true });
    }
  }
  for (const id of BACK_SIDE_SOURCE_IDS) {
    if (!ordered.some((existing) => existing.id === id)) ordered.push({ id, enabled: false });
  }
  const cleaned: string[] = [];
  if (Array.isArray(patterns)) {
    for (const entry of patterns) {
      if (!isValidBackPattern(entry)) continue;
      const pattern = entry.trim();
      if (cleaned.some((existing) => existing.toLowerCase() === pattern.toLowerCase())) continue;
      cleaned.push(pattern);
      if (cleaned.length >= 20) break;
    }
  }
  return { sources: ordered, patterns: cleaned };
}

/** The patterns in force, in order: each enabled source's patterns, custom ones
 *  being the library's own list. Empty when the rule is off. */
export function enabledBackPatterns(settings: BackSidesSettings): string[] {
  const out: string[] = [];
  for (const source of settings.sources) {
    if (!source.enabled) continue;
    const list = source.id === "custom" ? settings.patterns : BACK_SIDE_PRESETS[source.id];
    for (const pattern of list) if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/** Whether the Epson preset is on — it brings the `_a` enhanced-twin rule. */
export function epsonTwinRule(settings: BackSidesSettings): boolean {
  return settings.sources.some((source) => source.id === "epson" && source.enabled);
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
  // Gallery only: how backs of scanned prints are paired with their fronts.
  // Present on every type after normalisation (all off) so readers never branch.
  back_sides: BackSidesSettings;
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
  ebook: { extensions: ["epub", "pdf", "fb2", "mobi", "azw3", "txt", "rtf"], companions: ["png", "jpg", "jpeg", "webp", "xml", "json"] },
  // Gallery: photos + videos. One file = one asset; no companion files (sidecars
  // aren't catalogued — EXIF is read straight from the image/video).
  // Audio (mp3/m4a/wav/weba/… — see AUDIO_EXTENSIONS in gallery/media.ts) is
  // deliberately NOT in the defaults: defaults apply live to libraries that never
  // stored an explicit list, so adding audio here would make every existing photo
  // library index stray music files on its next scan. A library that should hold
  // recordings opts in through its scan-extensions setting.
  gallery: {
    extensions: ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "tiff", "bmp", "avif", "mp4", "mov", "m4v", "webm", "avi", "mkv"],
    companions: []
  }
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
    back_sides: normalizeBackSides(raw.back_sides),
    tag_encoding: isTagEncoding(raw.tag_encoding) ? raw.tag_encoding : undefined,
    progress_mode: raw.progress_mode === "episodic" ? "episodic" : "linear"
  };
}

export function sourceEnabled(sources: ScanSourceConfig[], id: MetadataSourceId): boolean {
  return sources.some((source) => source.id === id && source.enabled);
}
