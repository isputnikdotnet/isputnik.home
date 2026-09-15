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

// --- How big the cache is, without walking it ----------------------------------------
//
// A tile cache at its cap is hundreds of thousands of small files, and walking them
// to learn its size is minutes of disk work on a NAS array. So it is walked once
// (sweep.ts, off the request path) and then kept up to date by counting what is
// written. A rewrite of a file already counted is counted again, so the count only
// errs high — which at worst brings the next walk forward, and the walk corrects it.

/** Bytes this process has written into the cache, ever. */
let bytesWritten = 0;
let counted: { dir: string; bytes: number; writtenAt: number } | null = null;

/** The tile cache's size as last walked plus what has been written since, or null
 *  when it has not been walked (or the cache has moved since). */
export function knownTileCacheBytes(): number | null {
  if (!counted || counted.dir !== tileCacheDir()) return null;
  return counted.bytes + (bytesWritten - counted.writtenAt);
}

/** Record a walk's result. `writtenBefore` is bytesWrittenSoFar() from when the
 *  walk started, so what arrived during it is not lost. */
export function recordTileCacheBytes(dir: string, bytes: number, writtenBefore: number): void {
  counted = { dir, bytes: bytes + (bytesWritten - writtenBefore), writtenAt: bytesWritten };
}

export function bytesWrittenSoFar(): number {
  return bytesWritten;
}

// Reads and writes are asynchronous: a map asks for a hundred tiles at once, and
// on a NAS array (Unraid's /mnt/user) a synchronous stat or read can take long
// enough that a hundred of them in a row stall every other request.

export async function readCached(asset: MapAsset): Promise<CachedBody | null> {
  const file = assetPath(asset);
  if (!file) return null;
  try {
    const stat = await fs.promises.stat(file);
    return { body: await fs.promises.readFile(file), ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Best effort: a full disk or a read-only folder costs the cache, never the
 *  response — the caller already has the bytes it fetched. Says whether it wrote. */
export async function writeCached(asset: MapAsset, stored: Buffer): Promise<boolean> {
  const file = assetPath(asset);
  if (!file) return false;
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(temp, stored);
    await fs.promises.rename(temp, file);
    bytesWritten += stored.length;
    return true;
  } catch {
    await fs.promises.rm(temp, { force: true }).catch(() => {
      // Nothing more to do: the next request tries again.
    });
    return false;
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

/** Empty the tile cache. Returns what it freed. Synchronous, and a walk: only for
 *  an admin turning caching (or App storage) off, never for anything a map does. */
export function clearTileCache(): number {
  const dir = tileCacheDir();
  const freed = folderBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  recordTileCacheBytes(dir, 0, bytesWritten);
  return freed;
}
