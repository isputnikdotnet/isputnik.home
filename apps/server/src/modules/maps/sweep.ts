// Keeping the tile cache under its cap.
//
// A sweep that runs itself, a little after the cache grows, rather than a
// scheduled job: a cap has to hold whether or not anyone schedules anything, and
// nothing about it needs a person to choose when. It is throttled, runs off the
// request path, and never runs twice at once.
//
// WHAT GOES FIRST: the tiles fetched longest ago. Not strictly least-recently-
// used — Windows does not keep last-access times by default, and a file's mtime
// is already this cache's freshness clock (resolve.ts), so it cannot double as a
// "last read" clock. In practice the two agree: a place the family keeps looking
// at is refetched every 30 days, which renews its mtime, so what is oldest by
// fetch is what nobody has needed in a while.
//
// Only tiles are evicted. Styles, the TileJSON, glyphs and sprites are a few
// hundred KB in all and every map needs them.
import fs from "node:fs";
import path from "node:path";
import { tileCacheDir } from "./storage.js";

const MB = 1024 * 1024;

/** The cap. 200 MB is the proposal's estimate, not a measurement — hence an
 *  operator override until a real library says what it should be. */
export function cacheLimitBytes(): number {
  const override = Number(process.env.MAP_CACHE_LIMIT_MB);
  return Number.isFinite(override) && override > 0 ? override * MB : 200 * MB;
}

/** Sweep down to this share of the cap, so a cache sitting at its limit is not
 *  swept again on the very next write. */
const LOW_WATER = 0.9;

/** At most one sweep this often, however busy the cache is. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const EVICTABLE = ["vector", "raster"];

interface CachedFile {
  file: string;
  bytes: number;
  fetchedAt: number;
}

function walk(dir: string, into: CachedFile[]): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += walk(full, into);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(full);
        into.push({ file: full, bytes: stat.size, fetchedAt: stat.mtimeMs });
        total += stat.size;
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  return total;
}

export interface SweepResult {
  before: number;
  after: number;
  removed: number;
}

/** Bring the cache under its cap now. Exported for tests and for a caller that
 *  wants it done rather than scheduled. */
export function sweepTileCache(limit = cacheLimitBytes()): SweepResult {
  const root = tileCacheDir();
  const evictable: CachedFile[] = [];
  let total = 0;
  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    top = [];
  }
  for (const entry of top) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && EVICTABLE.includes(entry.name)) {
      total += walk(full, evictable);
    } else if (entry.isDirectory()) {
      // Counted against the cap — it is disk all the same — but never removed.
      total += walk(full, []);
    } else if (entry.isFile()) {
      // The TileJSON lives at the top, not in a folder: counted, never removed.
      try {
        total += fs.statSync(full).size;
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  const before = total;
  if (total <= limit) return { before, after: total, removed: 0 };

  const target = limit * LOW_WATER;
  evictable.sort((a, b) => a.fetchedAt - b.fetchedAt);
  let removed = 0;
  for (const entry of evictable) {
    if (total <= target) break;
    try {
      fs.rmSync(entry.file, { force: true });
      total -= entry.bytes;
      removed += 1;
    } catch {
      // Held open elsewhere: skip it, the next sweep tries again.
    }
  }
  return { before, after: total, removed };
}

let lastSweep = 0;
let sweeping = false;

/** Called after a write. Cheap when there is nothing to do, which is nearly
 *  always: a timestamp comparison. */
export function sweepSoon(): void {
  const now = Date.now();
  if (sweeping || now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  sweeping = true;
  // Off the request that triggered it: that request already has its tile.
  setImmediate(() => {
    try {
      sweepTileCache();
    } finally {
      sweeping = false;
    }
  });
}

/** For tests: forget the throttle. */
export function resetSweepThrottle(): void {
  lastSweep = 0;
  sweeping = false;
}
