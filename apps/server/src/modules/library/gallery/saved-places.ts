// Saved places: the points the household pins photos to again and again — home,
// the dacha, grandma's — kept by name so setting a location is one click instead
// of an address typed each time.
//
//  - ONE list for the whole house (gallery_saved_places), read and changed by
//    whoever may edit photos in at least one gallery library. It holds a home
//    address, so it is not offered to anyone who could not have pinned a photo
//    there themselves.
//  - The Home location setting (dashboard/home-location.ts) is COPIED in once,
//    the first time the list is read with a home set. A copy, not a link: the
//    household can rename it, move on from it or delete it here without touching
//    the sign-in map, and a deleted one does not come back.
//  - Recent places (gallery_recent_places) are each person's own: the last few
//    points they pinned by hand that are not a saved place already.
//
// A use is recorded by the routes that set a location (asset-routes.ts), never by
// a request of its own: a point counts as used when a photo was really put there.
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { canUserWriteLibrary } from "../shared/library-access.js";
import { getHomeLocation } from "../../dashboard/home-location.js";
import { distanceKm, geoNamesNamer, type PlaceLabel } from "../../maps/places/namer.js";
import type { GalleryRecentPlaceRow, GallerySavedPlaceRow, LibraryRow } from "../../../db/rows.js";

/** How many places the list holds. A chip row, not an address book. */
export const SAVED_PLACES_LIMIT = 50;
/** Recent places kept per person, and how many of them are offered. */
const RECENT_KEPT = 12;
const RECENT_OFFERED = 5;
/** A point this close to a saved place IS that place: a pin dragged across the
 *  yard still counts as home, and is not offered again as a recent place. */
export const SAME_PLACE_KM = 0.05;

const HOME_SEEDED_KEY = "gallery_saved_places_home_seeded";

export interface SavedPlace {
  id: string;
  /** '' only for the place copied from the Home location and never renamed. */
  name: string;
  lat: number;
  lng: number;
  /** Copied from the Home location setting. */
  home: boolean;
  useCount: number;
}

export interface RecentPlace {
  lat: number;
  lng: number;
  /** What the search called it; null for a point picked on the map. */
  label: string | null;
  /** The town it falls in, for a point with no label — null without a places
   *  database, or too far from any town. */
  place: PlaceLabel | null;
}

export interface Point { lat: number; lng: number }

export class SavedPlaceError extends Error {
  constructor(public code: "duplicate" | "full", message: string) {
    super(message);
  }
}

/** Whether this person is offered the list: an admin, or anyone with the edit
 *  right in a gallery library. */
export function canUseSavedPlaces(user: { id: string; role: string }): boolean {
  if (user.role === "admin") return true;
  const libraries = db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as Pick<LibraryRow, "id">[];
  return libraries.some((library) => canUserWriteLibrary(library, user.id, user.role));
}

function toSavedPlace(row: GallerySavedPlaceRow): SavedPlace {
  return { id: row.id, name: row.name, lat: row.lat, lng: row.lng, home: row.source === "home", useCount: row.use_count };
}

const round5 = (value: number) => Math.round(value * 100_000) / 100_000;

/** Copy the Home location in, once. Waits for a home to be set; after that the
 *  list is the household's own, and deleting the copy is final. */
function seedHomeOnce(): void {
  const seeded = db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(HOME_SEEDED_KEY);
  if (seeded) return;
  const home = getHomeLocation();
  if (!home) return;
  db.transaction(() => {
    const point = { lat: round5(home.latitude), lng: round5(home.longitude) };
    // Someone may have saved the house by hand before the admin set a home.
    if (!nearestSaved(point)) {
      db.prepare("INSERT INTO gallery_saved_places (id, name, lat, lng, source) VALUES (?, ?, ?, ?, 'home')")
        .run(nanoid(12), home.label.trim(), point.lat, point.lng);
    }
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key) DO NOTHING
    `).run(HOME_SEEDED_KEY);
  })();
}

function allSaved(): GallerySavedPlaceRow[] {
  // Most used first; home ahead of the rest while nothing has been used yet.
  return db.prepare(`
    SELECT * FROM gallery_saved_places
    ORDER BY use_count DESC, (source = 'home') DESC, name COLLATE NOCASE, created_at
  `).all() as GallerySavedPlaceRow[];
}

function nearestSaved(point: Point): GallerySavedPlaceRow | null {
  let best: { row: GallerySavedPlaceRow; km: number } | null = null;
  for (const row of db.prepare("SELECT * FROM gallery_saved_places").all() as GallerySavedPlaceRow[]) {
    const km = distanceKm(point.lat, point.lng, row.lat, row.lng);
    if (km <= SAME_PLACE_KM && (!best || km < best.km)) best = { row, km };
  }
  return best?.row ?? null;
}

export function listSavedPlaces(): SavedPlace[] {
  seedHomeOnce();
  return allSaved().map(toSavedPlace);
}

/** This person's recent points that no saved place covers, newest first. */
export function listRecentPlaces(userId: string, language: string): RecentPlace[] {
  const saved = allSaved();
  const rows = db.prepare("SELECT * FROM gallery_recent_places WHERE user_id = ? ORDER BY used_at DESC")
    .all(userId) as GalleryRecentPlaceRow[];
  const namer = geoNamesNamer();
  return rows
    .filter((row) => !saved.some((place) => distanceKm(row.lat, row.lng, place.lat, place.lng) <= SAME_PLACE_KM))
    .slice(0, RECENT_OFFERED)
    .map((row) => {
      const hit = row.label ? null : namer?.nearest(row.lat, row.lng) ?? null;
      return { lat: row.lat, lng: row.lng, label: row.label, place: hit ? namer?.describe(hit.id, language) ?? null : null };
    });
}

function nameTaken(name: string, exceptId?: string): boolean {
  const row = db.prepare("SELECT id FROM gallery_saved_places WHERE name = ? COLLATE NOCASE AND id <> ?")
    .get(name, exceptId ?? "") as Pick<GallerySavedPlaceRow, "id"> | undefined;
  return Boolean(row);
}

export function createSavedPlace(input: { name: string } & Point, userId: string): SavedPlace {
  const name = input.name.trim();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM gallery_saved_places").get() as { n: number }).n;
  if (count >= SAVED_PLACES_LIMIT) {
    throw new SavedPlaceError("full", `The list holds ${SAVED_PLACES_LIMIT} places. Delete one to save another.`);
  }
  if (nameTaken(name)) throw new SavedPlaceError("duplicate", `There is already a saved place called "${name}".`);
  const id = nanoid(12);
  db.prepare("INSERT INTO gallery_saved_places (id, name, lat, lng, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, round5(input.lat), round5(input.lng), userId);
  return toSavedPlace(db.prepare("SELECT * FROM gallery_saved_places WHERE id = ?").get(id) as GallerySavedPlaceRow);
}

/** Null when there is no such place. */
export function renameSavedPlace(id: string, rawName: string): SavedPlace | null {
  const name = rawName.trim();
  const row = db.prepare("SELECT * FROM gallery_saved_places WHERE id = ?").get(id) as GallerySavedPlaceRow | undefined;
  if (!row) return null;
  if (nameTaken(name, id)) throw new SavedPlaceError("duplicate", `There is already a saved place called "${name}".`);
  db.prepare("UPDATE gallery_saved_places SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(name, id);
  return toSavedPlace({ ...row, name });
}

/** The place that was deleted, or null when there was none. Photos pinned there
 *  keep their location: a saved place is a shortcut, not what holds the pin. */
export function deleteSavedPlace(id: string): SavedPlace | null {
  const row = db.prepare("SELECT * FROM gallery_saved_places WHERE id = ?").get(id) as GallerySavedPlaceRow | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM gallery_saved_places WHERE id = ?").run(id);
  return toSavedPlace(row);
}

/** A photo was pinned to this point by hand. Counts towards the saved place it
 *  falls on, or is remembered as one of this person's recent places. */
export function recordPlaceUse(userId: string, point: Point, label?: string | null): void {
  const saved = nearestSaved(point);
  if (saved) {
    db.prepare("UPDATE gallery_saved_places SET use_count = use_count + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(saved.id);
    return;
  }
  const text = label?.trim() || null;
  db.transaction(() => {
    // A label is kept when the same spot is pinned again without one (a click on
    // the map after a search found it the first time).
    db.prepare(`
      INSERT INTO gallery_recent_places (user_id, lat, lng, label, used_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(user_id, lat, lng) DO UPDATE SET label = COALESCE(excluded.label, label), used_at = excluded.used_at
    `).run(userId, round5(point.lat), round5(point.lng), text);
    db.prepare(`
      DELETE FROM gallery_recent_places
      WHERE user_id = ? AND rowid NOT IN (
        SELECT rowid FROM gallery_recent_places WHERE user_id = ? ORDER BY used_at DESC LIMIT ?
      )
    `).run(userId, userId, RECENT_KEPT);
  })();
}
