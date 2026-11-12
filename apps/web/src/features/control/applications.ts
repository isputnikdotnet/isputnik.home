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
export type ApplicationStatus = "ready" | "needsSetup" | "off";
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
  containers: AppStatus[];
  libraries: Record<LibraryType, AppLibrary[]>;
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
}

export function applicationState(key: AppKey, data: ApplicationsData): ApplicationState {
  const parts = APP_PARTS[key];
  const libraries = parts.libraryType ? data.libraries[parts.libraryType] : null;
  const container = parts.container ? data.containers.find((app) => app.id === parts.container) ?? null : null;
  const sized = libraries?.filter((library) => library.sizeBytes !== null) ?? [];
  const sizeBytes = sized.length ? sized.reduce((sum, library) => sum + (library.sizeBytes ?? 0), 0) : null;

  let status: ApplicationStatus | null = null;
  let gap: SetupGap | null = null;
  if (parts.section) {
    if (!data.sections[parts.section]) status = "off";
    else if (parts.container && !parts.containerOptional && !containerRunning(container)) { status = "needsSetup"; gap = "connection"; }
    else if (libraries && libraries.length === 0) { status = "needsSetup"; gap = "libraries"; }
    else status = "ready";
  }
  return { status, gap, libraries, sizeBytes, container };
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
}

function toLibraries(rows: ManagedRow[], sizes: Map<string, { items: number; sizeBytes: number }>): AppLibrary[] {
  return rows.map((row) => {
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
  // Each part is optional: a container that does not answer or a list that fails
  // leaves that part empty rather than the whole page blank.
  const soft = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [config, containers, audiobook, ebook, gallery, video, status] = await Promise.all([
    api<{ config: { sections: Sections } }>("/api/config"),
    soft(api<{ apps: AppStatus[] }>("/api/apps/admin/status"), { apps: [] as AppStatus[] }),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/audiobook-libraries?manage=1"), { libraries: [] as ManagedRow[] }),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/ebook-libraries?manage=1"), { libraries: [] as ManagedRow[] }),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/gallery-libraries?manage=1"), { libraries: [] as ManagedRow[] }),
    soft(api<{ libraries: ManagedRow[] }>("/api/library/video-libraries?manage=1"), { libraries: [] as ManagedRow[] }),
    soft(api<{ status: SystemStatus }>("/api/status").then((payload) => payload.status), null)
  ]);

  const sizes = new Map<string, { items: number; sizeBytes: number }>();
  for (const library of status?.libraryStats.libraries ?? []) sizes.set(library.id, { items: library.bookCount, sizeBytes: library.totalSizeBytes });
  for (const library of status?.ebookStats.libraries ?? []) sizes.set(library.id, { items: library.bookCount, sizeBytes: library.totalSizeBytes });
  for (const library of status?.galleryStats.libraries ?? []) sizes.set(library.id, { items: library.itemCount, sizeBytes: library.totalSizeBytes });

  return {
    sections: config.config.sections,
    containers: containers.apps,
    libraries: {
      audiobook: toLibraries(audiobook.libraries, sizes),
      ebook: toLibraries(ebook.libraries, sizes),
      gallery: toLibraries(gallery.libraries, sizes),
      video: toLibraries(video.libraries, sizes)
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

  const reload = useCallback((force = false) => {
    load(force)
      .then((next) => { setData(next); setError(""); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => reload(false), [reload]);

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

  return { data, error, reload, setSection };
}

/** Tests: forget what was read, so each starts from the server. */
export function resetApplicationsCache(): void {
  cached = null;
}
