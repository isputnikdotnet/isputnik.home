import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { rememberSections, type SectionKey, type Sections } from "../../app/sections";
import type { SystemStatus } from "./types";
import type { AppStatus } from "./sections/AppsSection";
import type { AppKey } from "./nav";

// What the Applications directory and each workspace's Setup say about an
// application (control panel v2, phase 2 — docs/control-panel-v2-plan.md): whether
// it is on, what it needs, and the libraries, connection and storage it uses.
//
// An application SHOWS these and LINKS to their owners; it owns none of them. So
// this reads the endpoints the owning pages already use rather than a summary of
// its own: the sections switches (/api/config), the containers (/api/apps/admin/
// status), each type's libraries (the Libraries page's ?manage=1 lists) and their
// sizes (/api/status). Read once and shared by every page that asks within a
// minute, so moving between a workspace's tabs does not refetch it each time.

export type LibraryType = "gallery" | "video" | "ebook" | "audiobook";
export type ApplicationStatus = "ready" | "needsSetup" | "off" | "unavailable";
/** Why an application needs setup — the first thing missing. */
export type SetupGap = "connection" | "libraries";

export interface AppLibrary {
  id: string;
  name: string;
  items: number | null;
  sizeBytes: number | null;
  scanStatus: "idle" | "scanning" | "error" | null;
  lastScannedAt: string | null;
  personal: boolean;
}

export interface ApplicationsData {
  sections: Sections;
  /** null means the check failed; an empty list means it succeeded with no entries. */
  containers: AppStatus[] | null;
  libraries: Record<LibraryType, AppLibrary[] | null>;
}

/** What each application is made of. `container` is required for it to work
 *  unless `containerOptional` (Gallery runs without the face engine). */
export const APP_PARTS: Record<AppKey, {
  section: SectionKey | null;
  libraryType: LibraryType | null;
  container: "video" | "faces" | "games" | null;
  containerOptional?: boolean;
}> = {
  gallery: { section: "gallery", libraryType: "gallery", container: "faces", containerOptional: true },
  videos: { section: "video", libraryType: "video", container: "video" },
  ebooks: { section: "ebooks", libraryType: "ebook", container: null },
  audiobooks: { section: "audiobooks", libraryType: "audiobook", container: null },
  stories: { section: "stories", libraryType: null, container: null },
  familyTree: { section: "familyTree", libraryType: null, container: null },
  games: { section: "games", libraryType: null, container: "games" },
  shared: { section: null, libraryType: null, container: null }
};

/** Mirrors AppsSection's isRunning: configured, answering, and taking our signature. */
export function containerRunning(container: AppStatus | null | undefined): boolean {
  return Boolean(container && container.configured && container.server?.ok && container.secretAccepted !== false);
}

export interface ApplicationState {
  status: ApplicationStatus | null;
  gap: SetupGap | null;
  libraries: AppLibrary[] | null;
  sizeBytes: number | null;
  container: AppStatus | null;
  sizeComplete: boolean;
}

export function applicationState(key: AppKey, data: ApplicationsData): ApplicationState {
  const parts = APP_PARTS[key];
  const libraries = parts.libraryType ? data.libraries[parts.libraryType] : null;
  const container = parts.container ? data.containers?.find((app) => app.id === parts.container) ?? null : null;
  const sized = libraries?.filter((library) => library.sizeBytes !== null) ?? [];
  const sizeComplete = libraries !== null && sized.length === libraries.length;
  const sizeBytes = sized.length || libraries?.length === 0 ? sized.reduce((sum, library) => sum + (library.sizeBytes ?? 0), 0) : null;

  let status: ApplicationStatus | null = null;
  let gap: SetupGap | null = null;
  if (parts.section) {
    if (!data.sections[parts.section]) status = "off";
    else if ((parts.container && !parts.containerOptional && data.containers === null)
      || (parts.libraryType && libraries === null)) status = "unavailable";
    else if (parts.container && !parts.containerOptional && !containerRunning(container)) { status = "needsSetup"; gap = "connection"; }
    else if (libraries && libraries.length === 0) { status = "needsSetup"; gap = "libraries"; }
    else status = "ready";
  }
  return { status, gap, libraries, sizeBytes, sizeComplete, container };
}

interface ManagedRow {
  id: string;
  name: string;
  bookCount?: number | null;
  fileCount?: number | null;
  totalSizeBytes?: number | null;
  scanStatus?: "idle" | "scanning" | "error";
  lastScannedAt?: string | null;
  personal?: unknown;
  role?: "inbox" | "app-files" | null;
}

function toLibraries(rows: ManagedRow[], sizes: Map<string, { items: number; sizeBytes: number }>): AppLibrary[] {
  // System libraries are shared app storage, not an application's ordinary libraries.
  return rows.filter((row) => !row.role).map((row) => {
    const sized = sizes.get(row.id);
    return {
      id: row.id,
      name: row.name,
      items: sized?.items ?? row.bookCount ?? row.fileCount ?? null,
      sizeBytes: sized?.sizeBytes ?? row.totalSizeBytes ?? null,
      scanStatus: row.scanStatus ?? null,
      lastScannedAt: row.lastScannedAt ?? null,
      personal: Boolean(row.personal)
    };
  });
}

async function fetchApplicationsData(): Promise<ApplicationsData> {
  // A failed read is unknown, never evidence that the user has no libraries.
  const soft = <T,>(promise: Promise<T>) => promise.catch(() => null);
  const [config, containers, audiobook, ebook, gallery, video, status] = await Promise.all([
    api<{ config: { sections: Sections } }>("/api/config"),
    soft(api<{ apps: AppStatus[] }>("/api/apps/admin/status")),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/audiobook-libraries?manage=1")),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/ebook-libraries?manage=1")),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/gallery-libraries?manage=1")),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/video-libraries?manage=1")),
    soft(api<{ status: SystemStatus }>("/api/status").then((payload) => payload.status))
  ]);

  const sizes = new Map<string, { items: number; sizeBytes: number }>();
  for (const library of status?.libraryStats.libraries ?? []) sizes.set(library.id, { items: library.bookCount, sizeBytes: library.totalSizeBytes });
  for (const library of status?.ebookStats.libraries ?? []) sizes.set(library.id, { items: library.bookCount, sizeBytes: library.totalSizeBytes });
  for (const library of status?.galleryStats.libraries ?? []) sizes.set(library.id, { items: library.itemCount, sizeBytes: library.totalSizeBytes });

  return {
    sections: config.config.sections,
    containers: containers?.apps ?? null,
    libraries: {
      audiobook: audiobook ? toLibraries(audiobook.libraries, sizes) : null,
      ebook: ebook ? toLibraries(ebook.libraries, sizes) : null,
      gallery: gallery ? toLibraries(gallery.libraries, sizes) : null,
      video: video ? toLibraries(video.libraries, sizes) : null
    }
  };
}

const FRESH_MS = 60_000;
let cached: { at: number; promise: Promise<ApplicationsData> } | null = null;

function load(force: boolean): Promise<ApplicationsData> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.promise;
  const promise = fetchApplicationsData();
  cached = { at: Date.now(), promise };
  // A failure is not kept: the next page to ask tries again.
  promise.catch(() => { if (cached?.promise === promise) cached = null; });
  return promise;
}

export function useApplicationsData() {
  const [data, setData] = useState<ApplicationsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback((force = false) => {
    setLoading(true);
    return load(force)
      .then((next) => { setData(next); setError(""); })
      .catch((err: unknown) => { setData(null); setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void reload(false); }, [reload]);

  /** Switch an application on or off in the menu — the save Appearance's Sections
   *  card made until v2. Applied at once, so the menu beside the page changes with
   *  it (rememberSections), then saved, and put back if the save fails. */
  const setSection = useCallback(async (key: SectionKey, on: boolean) => {
    const base = data;
    if (!base) return;
    const previous = base.sections;
    const optimistic = { ...previous, [key]: on };
    setData({ ...base, sections: optimistic });
    rememberSections(optimistic);
    try {
      const payload = await api<{ config: { sections: Sections } }>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ sections: optimistic })
      });
      const next = { ...base, sections: payload.config.sections };
      rememberSections(next.sections);
      cached = { at: Date.now(), promise: Promise.resolve(next) };
      setData(next);
    } catch (err) {
      rememberSections(previous);
      setData(base);
      throw err;
    }
  }, [data]);

  return { data, error, loading, reload, setSection };
}

/** Tests: forget what was read, so each starts from the server. */
export function resetApplicationsCache(): void {
  cached = null;
}

// ---- Activity, Tasks and Logs, narrowed to one application (phase 3) ----
//
// Those three pages live in Infrastructure, one for everything; an application
// links to them with its filter already chosen (?application=<key>). What an
// application IS to each of them is product knowledge, so it is mapped here, in
// the control panel, and the server only ever sees generic filters: event-name
// prefixes for the log (core/logs.ts) and job types / a library type for tasks.

/** Its log events, by name prefix. Stories, Family Tree and Games log under their
 *  own; Gallery also owns phone backup, maps and its albums and slideshows. */
export const APP_LOG_PREFIXES: Partial<Record<AppKey, string[]>> = {
  gallery: ["library.gallery.", "gallery.", "photo_sync.", "maps."],
  videos: ["library.video."],
  ebooks: ["library.ebook."],
  audiobooks: ["library.audiobook."],
  stories: ["story."],
  familyTree: ["familytree."],
  games: ["games."]
};

/** Its tasks: these job types, or any job on one of its libraries. Videos'
 *  scanning runs in its engine, so only jobs on a video library land here. */
export const APP_TASK_SCOPE: Partial<Record<AppKey, { types: string[]; libraryType: LibraryType }>> = {
  gallery: {
    types: ["SCAN_GALLERY_LIBRARY", "SCAN_GALLERY_FACES", "SCAN_GALLERY_DUPLICATES", "TRANSCODE_GALLERY_VIDEO", "FASTSTART_GALLERY_VIDEO", "gallery-slideshow-render", "BUILD_PLACES"],
    libraryType: "gallery"
  },
  videos: { types: [], libraryType: "video" },
  ebooks: { types: ["SCAN_EBOOK_LIBRARY"], libraryType: "ebook" },
  audiobooks: { types: ["SCAN_AUDIOBOOK_LIBRARY"], libraryType: "audiobook" }
};

/** ?application= as an application the page can filter by, or "". */
export function applicationParam(value: string | null, map: Partial<Record<AppKey, unknown>>): AppKey | "" {
  // Own keys only: `in` would also take "toString" and the rest of the prototype.
  return value && Object.prototype.hasOwnProperty.call(map, value) ? (value as AppKey) : "";
}
