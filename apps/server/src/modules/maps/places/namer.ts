// Coordinates to a place name (docs/map-approach-proposal.md, phase 2, seam 4).
//
// `PlaceNamer` is the seam: GeoNames is one implementation of it, not an
// assumption the rest of the app makes. The rules below were settled against
// real points on the real data (the proposal's phase 2 prototype):
//
//  - NOT simply the nearest place. Standing in Times Square, the nearest place in
//    the data is Weehawken, New Jersey, across the river. A place's pull grows with
//    the log of its population, which names Manhattan there — and still names a
//    village of 600 over a city of a million 12 km away when you are standing in
//    the village.
//  - Neighbourhoods (PPLX) and places that no longer exist are never the answer:
//    a photo in central Minsk was taken in Minsk, not in its October District.
//  - Too far is no answer. Beyond MAX_PLACE_KM the nearest town is a guess — in the
//    Sahara it was 226 km off, possibly across a border — and a wrong name is
//    worse than none.
//  - A numbered part of a place is that place. GeoNames files the Paris and
//    Marseille arrondissements as ordinary towns ("Paris 16 Passy", PPL), and with
//    160,000 people 1.4 km off, the Eiffel Tower was in "Paris 16 Passy". Only a
//    name that is a bigger place's name followed by a number counts: across the
//    whole data that is 45 places, every one a real part (Marseille 05, Seremban 2,
//    San Pedro Arriba 3ra. Sección). Any prefix at all was 723, and made Cocoa
//    Beach part of Cocoa and Sun City West part of Sun City, which they are not.
import type Database from "better-sqlite3";
import { NAME_LANGUAGES, openPlaces, type NameLanguage } from "./dataset.js";

export interface PlaceHit {
  id: number;
  distanceKm: number;
}

export interface PlaceLabel {
  place: string;
  /** Null when there is none, or when it only repeats the place ("Минск · Минск"). */
  region: string | null;
  country: string;
  countryCode: string;
}

export interface PlaceNamer {
  nearest(lat: number, lng: number): PlaceHit | null;
  /** A place near a point that goes by this English name — for putting another
   *  source's name ("Copenhagen (Valby)") into the reader's language without
   *  swapping it for a different town that happens to be nearer. */
  namedNear(lat: number, lng: number, englishName: string, withinKm: number): PlaceHit | null;
  describe(id: number, language: string): PlaceLabel | null;
}

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

/** "Copenhagen (Valby)" and "København" compare by letters alone. */
function comparableName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Beyond this, no place is named. */
export const MAX_PLACE_KM = 50;

/** Bumped whenever the rules below change which place a point names, so photos
 *  named under the old rules are named again (gallery/places.ts). */
export const NAMING_RULES = 2;

/** How far a numbered part can lie from the place it is part of. */
const PART_OF_KM = 15;

const NEVER = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

/** Search radii in km, tried until one holds a candidate. */
const SEARCH_STEPS_KM = [5, 15, MAX_PLACE_KM];

/** How far a place can be and still out-pull the best candidate found so far:
 *  the most populous place on Earth (~30 million) divides its distance by this.
 *  Searching again to bestPull × this makes the answer exact, not an accident of
 *  which box happened to be tried first. */
const PULL_REACH = 1 + Math.log10(1 + 30_000_000) / 2;

const KM_PER_DEGREE = 111.2;

const EARTH_KM = 6371;
const toRad = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lower is a better answer. */
function pull(distance: number, population: number): number {
  return distance / (1 + Math.log10(1 + population) / 2);
}

function languageOf(language: string): NameLanguage {
  const base = language.toLowerCase().split(/[-_]/)[0];
  return (NAME_LANGUAGES as readonly string[]).includes(base) ? (base as NameLanguage) : "en";
}

function countryName(code: string, language: NameLanguage): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

interface PlaceRow {
  id: number;
  name: string;
  lat: number;
  lng: number;
  country: string;
  admin1: string | null;
  population: number;
  fcode: string;
}

/** The namer over the current connection: its statements are prepared once, and a
 *  rebuilt database (a new connection) gets a new one. */
let current: { db: Database.Database; namer: PlaceNamer } | null = null;

/** The GeoNames namer, or null while there is no places database. */
export function geoNamesNamer(): PlaceNamer | null {
  const db = openPlaces();
  if (!db) return null;
  if (current?.db !== db) current = { db, namer: createNamer(db) };
  return current.namer;
}

/** Which of the languages the database holds names in to use for someone:
 *  their own choice, else what their browser asks for, else English. */
export function namesLanguageFor(chosen: string | null | undefined, acceptLanguage: string | undefined): NameLanguage {
  if (chosen) return languageOf(chosen);
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim();
    if (tag && tag !== "*" && (NAME_LANGUAGES as readonly string[]).includes(tag.toLowerCase().split(/[-_]/)[0])) return languageOf(tag);
  }
  return "en";
}

function createNamer(db: Database.Database): PlaceNamer {
  const inBox = db.prepare(`
    SELECT p.id, p.name, p.lat, p.lng, p.country, p.admin1, p.population, p.fcode
    FROM places_rtree r JOIN places p ON p.id = r.id
    WHERE r.min_lat >= ? AND r.max_lat <= ? AND r.min_lng >= ? AND r.max_lng <= ?
  `);
  const placeById = db.prepare("SELECT id, name, country, admin1 FROM places WHERE id = ?");
  const regionByCode = db.prepare("SELECT id, name FROM regions WHERE code = ?");
  const nameIn = db.prepare("SELECT name FROM names WHERE id = ? AND lang = ?");

  const named = (id: number, fallback: string, language: NameLanguage): string =>
    (nameIn.get(id, language) as { name: string } | undefined)?.name
    ?? (language === "en" ? fallback : (nameIn.get(id, "en") as { name: string } | undefined)?.name ?? fallback);

  const around = (centreLat: number, centreLng: number, km: number) => {
    const latDegrees = km / KM_PER_DEGREE;
    // A degree of longitude shrinks toward the poles; widen the box to match.
    const lngDegrees = latDegrees / Math.max(0.05, Math.cos(toRad(centreLat)));
    return (inBox.all(centreLat - latDegrees, centreLat + latDegrees, centreLng - lngDegrees, centreLng + lngDegrees) as PlaceRow[])
      .filter((row) => !NEVER.has(row.fcode));
  };

  return {
    namedNear(lat, lng, englishName, withinKm) {
      const wanted = comparableName(englishName);
      if (!wanted || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      let best: { row: PlaceRow; distance: number } | null = null;
      for (const row of around(lat, lng, withinKm)) {
        const distance = distanceKm(lat, lng, row.lat, row.lng);
        if (distance > withinKm) continue;
        const english = (nameIn.get(row.id, "en") as { name: string } | undefined)?.name;
        if (comparableName(row.name) !== wanted && (!english || comparableName(english) !== wanted)) continue;
        if (!best || row.population > best.row.population) best = { row, distance };
      }
      return best ? { id: best.row.id, distanceKm: Math.round(best.distance * 10) / 10 } : null;
    },

    nearest(lat, lng) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const within = (km: number) => around(lat, lng, km);
      const bestOf = (rows: PlaceRow[]) => {
        let best: { row: PlaceRow; score: number; distance: number } | null = null;
        for (const row of rows) {
          const distance = distanceKm(lat, lng, row.lat, row.lng);
          if (distance > MAX_PLACE_KM) continue;
          const score = pull(distance, row.population);
          if (!best || score < best.score) best = { row, score, distance };
        }
        return best;
      };

      // "Paris 16 Passy" → Paris: the most populous nearby place whose name, and a
      // number after it, begins this one's.
      const wholeOf = (part: PlaceRow): PlaceRow => {
        let whole = part;
        for (const row of around(part.lat, part.lng, PART_OF_KM)) {
          if (row.country !== part.country || row.population <= whole.population) continue;
          if (!part.name.startsWith(`${row.name} `) || !/^[0-9]/.test(part.name.slice(row.name.length + 1))) continue;
          if (distanceKm(part.lat, part.lng, row.lat, row.lng) > PART_OF_KM) continue;
          whole = row;
        }
        return whole;
      };

      for (const radius of SEARCH_STEPS_KM) {
        const first = bestOf(within(radius));
        if (!first) continue;
        // Anything that could still beat it lies within this reach; look once more.
        const reach = Math.min(MAX_PLACE_KM, first.score * PULL_REACH);
        const best = reach > radius ? bestOf(within(reach)) ?? first : first;
        const whole = wholeOf(best.row);
        const distance = whole === best.row ? best.distance : distanceKm(lat, lng, whole.lat, whole.lng);
        return { id: whole.id, distanceKm: Math.round(distance * 10) / 10 };
      }
      return null;
    },

    describe(id, language) {
      const lang = languageOf(language);
      const row = placeById.get(id) as Pick<PlaceRow, "id" | "name" | "country" | "admin1"> | undefined;
      if (!row) return null;
      const place = named(row.id, row.name, lang);
      const regionRow = row.admin1 ? (regionByCode.get(`${row.country}.${row.admin1}`) as { id: number; name: string } | undefined) : undefined;
      const regionName = regionRow ? named(regionRow.id, regionRow.name, lang) : null;
      return {
        place,
        region: regionName && regionName.toLowerCase() !== place.toLowerCase() ? regionName : null,
        country: countryName(row.country, lang),
        countryCode: row.country
      };
    }
  };
}
