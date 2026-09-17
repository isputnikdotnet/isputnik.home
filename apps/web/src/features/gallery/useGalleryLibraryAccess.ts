import { useEffect, useState } from "react";
import { api } from "../../api";
import type { GalleryLibrary } from "./types";

// What the signed-in person may do in each gallery library, shared by every
// photo viewer so a photo offers the same edits wherever it is opened (Home,
// a tag, a family member, a story, the gallery itself).
//
// One request serves every viewer for a minute. A failed request is forgotten
// straight away, so the next photo asks again instead of staying read-only for
// the rest of the visit.
const FRESH_MS = 60_000;
let cached: { at: number; libraries: Promise<GalleryLibrary[]> } | null = null;

export function loadGalleryLibraries(): Promise<GalleryLibrary[]> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.libraries;
  const entry = {
    at: Date.now(),
    libraries: api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries").then((payload) => payload.libraries)
  };
  entry.libraries.catch(() => { if (cached === entry) cached = null; });
  cached = entry;
  return entry.libraries;
}

/** The library `libraryId` with its permission flags, or null until known (read-only meanwhile). */
export function useGalleryLibraryAccess(libraryId: string | undefined, enabled = true): GalleryLibrary | null {
  const [libraries, setLibraries] = useState<GalleryLibrary[] | null>(null);
  const known = libraries?.some((library) => library.id === libraryId) ?? false;
  useEffect(() => {
    if (!enabled || !libraryId || known) return;
    let alive = true;
    loadGalleryLibraries()
      .then((list) => { if (alive) setLibraries(list); })
      .catch(() => { /* read-only; the next photo asks again */ });
    return () => { alive = false; };
  }, [enabled, libraryId, known]);
  return libraries?.find((library) => library.id === libraryId) ?? null;
}
