// The places database on disk (docs/map-approach-proposal.md, phase 2).
//
// One SQLite file, built on this install from GeoNames (build.ts) and read here.
// It lives in the Map data room's Places folder, so it moves with the rest of the
// room and is counted with it. Turning named places off deletes it; everything
// that shows a place name reads through this file and simply finds nothing.
//
// Opened read-only, once, and reopened only when the file is replaced — a build
// swaps a new file in by renaming over this one. On Windows an open handle would
// block that rename, which is why every writer closes the connection first.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { mapDataDir } from "../storage.js";

export const PLACES_FOLDER = "Places";

/** Bumped when the file's shape changes. An older file is treated as absent, so
 *  an upgrade shows the level as needing a rebuild rather than failing on read. */
export const PLACES_FORMAT = 1;

/** The interface languages names are kept for. English is also the fallback
 *  when a place has no name in the language asked for. */
export const NAME_LANGUAGES = ["en", "ru"] as const;
export type NameLanguage = (typeof NAME_LANGUAGES)[number];

export function placesDir(): string {
  return path.join(mapDataDir(), PLACES_FOLDER);
}

export function placesFile(): string {
  return path.join(placesDir(), "places.sqlite");
}

/** Where a build keeps its downloads while it runs. Removed when it finishes. */
export function placesBuildDir(): string {
  return path.join(placesDir(), ".build");
}

export interface PlacesStatus {
  present: boolean;
  sizeBytes: number;
  builtAt: string | null;
  /** When GeoNames last changed the files this was built from. */
  sourceDate: string | null;
  places: number;
}

const ABSENT: PlacesStatus = { present: false, sizeBytes: 0, builtAt: null, sourceDate: null, places: 0 };

let open: { file: string; mtimeMs: number; db: Database.Database } | null = null;

/** Close the connection, so the file can be replaced or deleted. */
export function closePlaces(): void {
  if (!open) return;
  try {
    open.db.close();
  } catch {
    // Already closed.
  }
  open = null;
}

/** The database, or null when there is none (or it is from an older format). */
export function openPlaces(): Database.Database | null {
  const file = placesFile();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    closePlaces();
    return null;
  }
  if (open && open.file === file && open.mtimeMs === mtimeMs) return open.db;
  closePlaces();
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const format = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | undefined;
    if (Number(format?.value) !== PLACES_FORMAT) {
      db.close();
      return null;
    }
    open = { file, mtimeMs, db };
    return db;
  } catch {
    return null;
  }
}

export function placesStatus(): PlacesStatus {
  const db = openPlaces();
  if (!db) return { ...ABSENT };
  const meta = new Map(
    (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((row) => [row.key, row.value])
  );
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(placesFile()).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    present: true,
    sizeBytes,
    builtAt: meta.get("built_at") ?? null,
    sourceDate: meta.get("source_date") ?? null,
    places: Number(meta.get("places") ?? 0)
  };
}

/** Delete the database and anything a build left behind. Returns what that freed. */
type RemovedListener = () => void;
const afterRemove: RemovedListener[] = [];

/** Run something once the database is gone — forgetting what photos were named
 *  after it, for one. Names disappear with the database (the proposal's choice). */
export function onPlacesRemoved(listener: RemovedListener): () => void {
  afterRemove.push(listener);
  return () => {
    const index = afterRemove.indexOf(listener);
    if (index !== -1) afterRemove.splice(index, 1);
  };
}

export function removePlaces(): number {
  closePlaces();
  let freed = 0;
  try {
    freed = fs.statSync(placesFile()).size;
  } catch {
    freed = 0;
  }
  fs.rmSync(placesDir(), { recursive: true, force: true });
  for (const listener of [...afterRemove]) {
    try {
      listener();
    } catch {
      // A listener's failure is its own; the database is gone either way.
    }
  }
  return freed;
}
