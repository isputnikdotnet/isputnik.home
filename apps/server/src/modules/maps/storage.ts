// The map cache on disk.
//
// Everything is keyed by what the asset IS, never by the upstream URL it came
// from. The difference matters: OpenFreeMap's tile URLs carry a build version
// that changes every week, so a cache keyed on them would throw away every tile
// the family has ever looked at, weekly, for no visible change.
//
// Writes are atomic (temp file, then rename), so a crash or a full disk mid-write
// can never leave a truncated tile that is then served forever.
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { resolveAppLocation } from "../../core/app-storage.js";
import { pathIsInside } from "../library/shared/storage-roots.js";
import type { MapAsset } from "./provider.js";

/** What the Map data room holds, by top-level folder. A move carries these and
 *  nothing else, so a file that happens to sit beside them is never swept up —
 *  the same guard RENDER_BUCKETS gives the Renders room. */
export const MAP_DATA_FOLDERS = ["Tiles", "Places", "Locations"] as const;

/** The Map data room's "own place": MAP_DATA_PATH, else `<data>/map-data`
 *  beside the database's folder — the room's BACKUP_PATH, in effect. Always absolute:
 *  a move compares and carries between paths, and a relative one would resolve
 *  against whatever the working directory happens to be. */
export function ownMapDataDir(): string {
  if (process.env.MAP_DATA_PATH) return path.resolve(process.env.MAP_DATA_PATH);
  return path.resolve(path.dirname(path.dirname(config.dbPath)), "map-data");
}

/** Where map data lives right now: the Map data room in App storage, or the
 *  room's own place (core/app-storage.ts, resolveAppLocation). */
export function mapDataDir(): string {
  return resolveAppLocation("maps") ?? ownMapDataDir();
}

/** The base map's part of it: tiles, fonts, sprites and styles. Deleting this
 *  folder is what turning the cache off does, and all of it refills itself. */
export function tileCacheDir(): string {
  return path.join(mapDataDir(), "Tiles");
}

/** Bodies stored gzipped on disk: vector tiles, glyphs and JSON. Measured
 *  against the real provider: a Minsk z14 tile is 1.9 KB gzipped against 2.4 KB
 *  raw (protobuf is already compact, so tiles gain least), a glyph range 42 KB
 *  against 77 KB. PNGs are already compressed and stored as they came — and a
 *  hillshade tile is ~190 KB, about a hundred vector tiles, which is what a
 *  byte-based cache cap is for. */
export function isStoredGzipped(asset: MapAsset): boolean {
  if (asset.kind === "raster") return false;
  if (asset.kind === "sprite") return asset.file.endsWith(".json");
  return true;
}

/** The asset's file under the cache, or null if it would land outside it —
 *  which validation upstream of here should already have made impossible. */
export function assetPath(asset: MapAsset): string | null {
  const root = tileCacheDir();
  let relative: string[];
  switch (asset.kind) {
    case "style":
      relative = ["styles", `${asset.style}.json.gz`];
      break;
    case "tilejson":
      relative = ["tilejson.json.gz"];
      break;
    case "vector":
      relative = ["vector", String(asset.z), String(asset.x), `${asset.y}.pbf.gz`];
      break;
    case "raster":
      relative = ["raster", String(asset.z), String(asset.x), `${asset.y}.png`];
      break;
    case "font":
      relative = ["fonts", asset.fontstack, `${asset.range}.pbf.gz`];
      break;
    case "sprite":
      relative = ["sprites", asset.version, asset.file.endsWith(".json") ? `${asset.file}.gz` : asset.file];
      break;
  }
  const file = path.join(root, ...relative);
  return pathIsInside(file, root) ? file : null;
}

export interface CachedBody {
  /** As stored: gzipped when isStoredGzipped(asset). */
  body: Buffer;
  ageMs: number;
}

export function readCached(asset: MapAsset): CachedBody | null {
  const file = assetPath(asset);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return { body: fs.readFileSync(file), ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Best effort: a full disk or a read-only folder costs the cache, never the
 *  response — the caller already has the bytes it fetched. */
export function writeCached(asset: MapAsset, stored: Buffer): void {
  const file = assetPath(asset);
  if (!file) return;
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, stored);
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to do: the next request tries again.
    }
  }
}

/** Bytes under a folder, following nothing. For "turning this off frees X". */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // Gone between the listing and the stat — counts as nothing.
      }
    }
  }
  return total;
}

/** The sign-in location databases (core/geoip.ts reads them from here, unless
 *  GEOIP_PATH says otherwise). */
export function locationsDir(): string {
  return path.join(mapDataDir(), "Locations");
}

/** Empty the tile cache. Returns what it freed. */
export function clearTileCache(): number {
  const dir = tileCacheDir();
  const freed = folderBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return freed;
}
