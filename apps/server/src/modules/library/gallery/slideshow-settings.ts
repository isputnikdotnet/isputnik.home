import { db } from "../../../db.js";

// The single, server-wide "default movie library": when set, every successful slideshow
// movie render is auto-filed into this gallery library as a video item (see
// slideshow-render.ts saveMovieToLibrary). NULL/unset = don't save to a library (the movie
// still previews/downloads in the editor from the thumbnail store). Stored in app_settings
// like the face-recognition settings (faces/settings.ts).
const RENDER_LIBRARY_KEY = "gallery.slideshow.render_library";

// The configured default movie library id, or null when none is set / the library it
// pointed at no longer exists (a deleted library shouldn't leave a dangling target).
export function getRenderLibraryId(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(RENDER_LIBRARY_KEY) as { value: string } | undefined;
  const id = row?.value || null;
  if (!id) return null;
  const exists = db.prepare("SELECT 1 FROM libraries WHERE id = ? AND type = 'gallery'").get(id);
  return exists ? id : null;
}

// Set (or clear, with null) the default movie library. The route validates the id names
// an existing gallery library before calling this.
export function setRenderLibraryId(libraryId: string | null, userId: string): void {
  if (!libraryId) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(RENDER_LIBRARY_KEY);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(RENDER_LIBRARY_KEY, libraryId, userId);
}
