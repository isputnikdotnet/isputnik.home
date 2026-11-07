import { BookOpen, Clapperboard, Headphones, Image } from "lucide-react";
import type { AudiobookLibrary, LibraryMode } from "../../audiobooks/types";
// Plain lookup functions rather than module-level consts, so a language switch
// is picked up (docs/i18n-plan.md's namespace-key typing pitfall #3).
import i18n from "../../../i18n";
import { formatNumber } from "../../../shared/dates";
import { formatBytes } from "../../../shared/utils";

// The library row as Library › Libraries and a library's Manage page see it, and
// the words both use for it. Split out of LibrariesSection in 4.73, when the
// Manage page took over what the row's icons and its details dialog showed.

export type ManagedLibraryType = "audiobook" | "ebook" | "gallery" | "video";

// One row shape for every library type (the server serializes them identically;
// a video library adds what it is and the video app's counts —
// modules/library/video/libraries.ts).
export interface ManagedLibrary extends Omit<AudiobookLibrary, "type" | "fileCount"> {
  type: ManagedLibraryType;
  fileCount: number | null;
  kind?: "shows" | "movies";
  /** A video library's folder on the video app, and the language its titles are looked up in. */
  folder?: string;
  defaultLanguage?: string;
  /** A member's personal library (docs/photo-sync-plan.md): only they can open it.
   *  Someone else's comes to an admin as whose it is and its size, nothing more. */
  personal?: { ownerId: string; ownerName: string; orphaned: boolean; orphanedAt: string | null; adoptedAt: string | null } | null;
}

/** Languages a video library's titles can be described in (TMDB); one it was
 *  given elsewhere stays in the list. */
export const VIDEO_LANGUAGES = ["en", "ru", "uk", "be", "de", "fr", "es", "it", "pl", "pt", "ja", "zh"];

export const TYPE_ICON: Record<ManagedLibraryType, typeof Headphones> = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: Image,
  video: Clapperboard
};

export function typeLabel(type: ManagedLibraryType): string {
  switch (type) {
    case "audiobook": return i18n.t("control:libraries.typeAudiobooks");
    case "ebook": return i18n.t("control:libraries.typeEbooks");
    case "gallery": return i18n.t("control:libraries.typeGallery");
    case "video": return i18n.t("control:libraries.typeVideo");
  }
}

/** A language code in the reader's own words: "ru" → "Russian (ru)". */
export function languageLabel(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    return name ? `${name.charAt(0).toLocaleUpperCase(locale)}${name.slice(1)} (${code})` : code;
  } catch {
    return code;
  }
}

/** The type, and for a video library what it holds: "Video · Shows". */
export function rowTypeLabel(library: ManagedLibrary): string {
  if (library.type !== "video") return typeLabel(library.type);
  const kind = library.kind === "movies" ? i18n.t("control:libraries.video.kindMovies") : i18n.t("control:libraries.video.kindShows");
  return `${typeLabel("video")} · ${kind}`;
}

export const TYPE_FILTER_VALUES: ("all" | ManagedLibraryType)[] = ["all", "audiobook", "ebook", "gallery", "video"];

export function typeFilterLabel(value: "all" | ManagedLibraryType): string {
  return value === "all" ? i18n.t("control:libraries.filterAll") : typeLabel(value);
}

export function modeLabel(mode: LibraryMode): string {
  return mode === "managed" ? i18n.t("control:libraries.modeManaged") : i18n.t("control:libraries.modeExternal");
}

export const ROLE_KEY: Record<string, "viewer" | "member" | "contributor" | "manager" | "deny"> = {
  viewer: "viewer",
  member: "member",
  contributor: "contributor",
  manager: "manager",
  deny: "deny"
};

export function scanStatusLabel(status: ManagedLibrary["scanStatus"]): string {
  switch (status) {
    case "idle": return i18n.t("control:libraries.scanIdle");
    case "scanning": return i18n.t("control:libraries.scanScanning");
    case "error": return i18n.t("control:libraries.scanError");
  }
}

export function formatCount(value: number | null | undefined) {
  return value == null ? "—" : formatNumber(value);
}

export function formatLibrarySize(value: number | null | undefined) {
  return value == null ? "—" : formatBytes(value);
}

/** A shared photo library: phones may be linked to it (Photo Sync phase 6) — never a
 *  personal library or a system one (Inbox, App files). */
export function phoneLinkable(library: ManagedLibrary): boolean {
  return library.type === "gallery" && !library.personal && !library.role;
}

export function roleLabel(role: string | null | undefined) {
  const key = role ? ROLE_KEY[role] : undefined;
  return key ? i18n.t(`control:libraries.role.${key}`) : i18n.t("control:libraries.role.none");
}

export function accessSummary(library: ManagedLibrary) {
  return library.visibility === "public" ? i18n.t("control:libraries.public") : i18n.t("control:libraries.private");
}

export function capabilityLabels(library: ManagedLibrary) {
  return [
    library.canDownload ? i18n.t("control:libraries.capabilityDownload") : null,
    library.canWrite ? i18n.t("control:libraries.capabilityEdit") : null,
    library.canUpload ? i18n.t("control:libraries.capabilityUpload") : null,
    library.canCurate ? i18n.t("control:libraries.capabilityCurate") : null,
    library.canManageMembers ? i18n.t("control:libraries.capabilityManageMembers") : null,
    library.canManageLibrary ? i18n.t("control:libraries.capabilityManageSettings") : null
  ].filter(Boolean) as string[];
}

