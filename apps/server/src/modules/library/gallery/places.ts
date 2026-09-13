// Photos named after the place they were taken in (docs/map-approach-proposal.md,
// phase 2). The names come from the optional place names database
// (modules/maps/places); what a photo keeps is only the place's id, in
// gallery_places, so each viewer reads the name in their own language.
//
// A photo is named when it has coordinates and no current answer: never named,
// named from coordinates that have since moved, or named against an older build of
// the database. One sweep finds all three, so nothing that writes coordinates (a
// scan, an upload, a pin dragged in the lightbox, a duplicate merge) has to
// remember to call it — it only asks for a sweep soon.
import type { FastifyRequest } from "fastify";
import { db } from "../../../db.js";
import { geoNamesNamer, NAMING_RULES, namesLanguageFor, type PlaceLabel } from "../../maps/places/namer.js";
import { onPlacesRemoved, placesStatus } from "../../maps/places/dataset.js";
import { onPlacesBuilt } from "../../maps/places/job.js";

/** Photos named per turn of the event loop. A lookup is a fraction of a
 *  millisecond, so this keeps each turn short on a library of 100,000. */
const BATCH = 500;

const upsert = () => db.prepare(`
  INSERT INTO gallery_places (item_id, place_id, distance_km, lat, lng, dataset) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    place_id = excluded.place_id, distance_km = excluded.distance_km,
    lat = excluded.lat, lng = excluded.lng, dataset = excluded.dataset
`);

/** Which build of the database, and which version of the naming rules, an answer
 *  came from: a change to either names every photo again. */
function datasetStamp(): string | null {
  const status = placesStatus();
  return status.present ? `${status.builtAt ?? "unknown"} rules ${NAMING_RULES}` : null;
}

interface Unnamed {
  item_id: string;
  gps_lat: number;
  gps_lng: number;
}

function unnamed(dataset: string, limit: number, itemIds?: string[]): Unnamed[] {
  const only = itemIds ? `AND gallery_details.item_id IN (${itemIds.map(() => "?").join(", ")})` : "";
  return db.prepare(`
    SELECT gallery_details.item_id, gallery_details.gps_lat, gallery_details.gps_lng
    FROM gallery_details
    LEFT JOIN gallery_places ON gallery_places.item_id = gallery_details.item_id
    WHERE gallery_details.gps_lat IS NOT NULL AND gallery_details.gps_lng IS NOT NULL
      AND (gallery_places.item_id IS NULL
        OR gallery_places.lat <> gallery_details.gps_lat OR gallery_places.lng <> gallery_details.gps_lng
        OR gallery_places.dataset <> ?)
      ${only}
    LIMIT ?
  `).all(dataset, ...(itemIds ?? []), limit) as Unnamed[];
}

/** Name what needs naming, up to `limit` photos. Returns how many it named, 0
 *  when there is no database. */
function nameSome(limit: number, itemIds?: string[]): number {
  const namer = geoNamesNamer();
  const dataset = datasetStamp();
  if (!namer || !dataset) return 0;
  const rows = unnamed(dataset, limit, itemIds);
  if (rows.length === 0) return 0;
  const write = upsert();
  db.transaction(() => {
    for (const row of rows) {
      const hit = namer.nearest(row.gps_lat, row.gps_lng);
      write.run(row.item_id, hit?.id ?? null, hit?.distanceKm ?? null, row.gps_lat, row.gps_lng, dataset);
    }
  })();
  return rows.length;
}

/** Name these photos now, if they need it — for a read that wants the answer
 *  before the next sweep would get to it. */
export function namePhotoPlacesNow(itemIds: string[]): number {
  return itemIds.length > 0 ? nameSome(itemIds.length, itemIds) : 0;
}

let sweeping: Promise<number> | null = null;
let again = false;

/** Name every photo that needs it, a batch per turn. One sweep at a time; asking
 *  during one runs another after it, so a photo pinned mid-sweep is not missed. */
export function sweepPhotoPlaces(): Promise<number> {
  if (sweeping) {
    again = true;
    return sweeping;
  }
  const run = (async () => {
    let total = 0;
    do {
      again = false;
      // Coordinates cleared since: the pin is gone, so is the name.
      db.prepare(`
        DELETE FROM gallery_places WHERE item_id IN (
          SELECT item_id FROM gallery_details WHERE gps_lat IS NULL OR gps_lng IS NULL)
      `).run();
      for (;;) {
        const named = nameSome(BATCH);
        total += named;
        if (named < BATCH) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } while (again);
    return total;
  })();
  // Cleared once settled, never inside the body: a sweep with nothing to do
  // finishes before `run` is even assigned, and would leave itself behind.
  sweeping = run;
  run.then(() => { if (sweeping === run) sweeping = null; }, () => { if (sweeping === run) sweeping = null; });
  return run;
}

let soon: NodeJS.Timeout | null = null;

/** Ask for a sweep shortly — after the burst of writes that asked has settled. */
export function requestPhotoPlaceSweep(delayMs = 2_000): void {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void sweepPhotoPlaces().catch(() => { /* the next request tries again */ });
  }, delayMs);
  soon.unref?.();
}

/** Names disappear with the database. */
export function forgetPhotoPlaces(): void {
  db.prepare("DELETE FROM gallery_places").run();
}

/** A photo's place, described for one viewer. Null for no place, or no database. */
export function describePlace(placeId: number | null, language: string): PlaceLabel | null {
  if (placeId == null) return null;
  return geoNamesNamer()?.describe(placeId, language) ?? null;
}

/** The language to spell places in for whoever is asking. */
export function placeLanguage(request: FastifyRequest): string {
  return namesLanguageFor(request.user?.language, request.headers["accept-language"]);
}

/** Wire naming to the database's lifecycle and to a slow heartbeat that catches
 *  whatever no one asked about. Returns the stop. */
export function startPhotoPlaceNaming(): () => void {
  const stopBuilt = onPlacesBuilt(() => requestPhotoPlaceSweep(0));
  const stopRemoved = onPlacesRemoved(() => forgetPhotoPlaces());
  requestPhotoPlaceSweep(60_000);
  const heartbeat = setInterval(() => requestPhotoPlaceSweep(0), 10 * 60 * 1000);
  heartbeat.unref?.();
  return () => {
    stopBuilt();
    stopRemoved();
    clearInterval(heartbeat);
    if (soon) {
      clearTimeout(soon);
      soon = null;
    }
  };
}
