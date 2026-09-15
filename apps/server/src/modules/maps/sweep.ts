// Keeping the tile cache under its cap.
//
// A sweep that runs itself, a little after the cache grows, rather than a
// scheduled job: a cap has to hold whether or not anyone schedules anything, and
// nothing about it needs a person to choose when. It is throttled, runs off the
// request path, and never runs twice at once.
//
// It is also ASYNCHRONOUS, and walks only when the cache may be over its cap. A
// cache at 1 GB is half a million tile files; the first version walked all of them
// with statSync every five minutes of map use, and on an Unraid array that froze
// every request for as long as it took (the same lesson as the 4.6.0 Storage page,
// app-storage.ts countFolder). Now the walk yields between batches, and between
// walks the cache's size is kept by counting writes (storage.ts).
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
import { getMapSettings } from "./settings.js";
import { bytesWrittenSoFar, knownTileCacheBytes, recordTileCacheBytes, tileCacheDir } from "./storage.js";

const MB = 1024 * 1024;

/** The cap: the owner's choice on the Maps page (settings.ts), 200 MB unless
 *  they chose otherwise. */
export function cacheLimitBytes(): number {
  return getMapSettings().cacheLimitMb * MB;
}

/** Sweep down to this share of the cap, so a cache sitting at its limit is not
 *  swept again on the very next write. */
const LOW_WATER = 0.9;

/** At most one sweep this often, however busy the cache is. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Stats asked for at once: enough to be quick, few enough that a file read
 *  elsewhere in the server is never far down the threadpool's queue. */
const STAT_BATCH = 16;

const EVICTABLE = ["vector", "raster"];

interface CachedFile {
  file: string;
  bytes: number;
  fetchedAt: number;
}

/** Every file under `dir`, into `into` when given; returns their bytes. */
async function walk(dir: string, into: CachedFile[] | null): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const stats = await Promise.all(
        files.slice(i, i + STAT_BATCH).map((file) => fs.promises.stat(file).then((stat) => ({ file, stat }), () => null))
      );
      for (const found of stats) {
        // Gone between the listing and the stat — counts as nothing.
        if (!found) continue;
        total += found.stat.size;
        into?.push({ file: found.file, bytes: found.stat.size, fetchedAt: found.stat.mtimeMs });
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
export async function sweepTileCache(limit = cacheLimitBytes()): Promise<SweepResult> {
  const root = tileCacheDir();
  const writtenBefore = bytesWrittenSoFar();
  const evictable: CachedFile[] = [];
  let total = 0;
  let top: fs.Dirent[] = [];
  try {
    top = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    top = [];
  }
  for (const entry of top) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && EVICTABLE.includes(entry.name)) {
      total += await walk(full, evictable);
    } else if (entry.isDirectory()) {
      // Counted against the cap — it is disk all the same — but never removed.
      total += await walk(full, null);
    } else if (entry.isFile()) {
      // The TileJSON lives at the top, not in a folder: counted, never removed.
      total += await fs.promises.stat(full).then((stat) => stat.size, () => 0);
    }
  }
  const before = total;
  if (total > limit) {
    const target = limit * LOW_WATER;
    evictable.sort((a, b) => a.fetchedAt - b.fetchedAt);
    let removed = 0;
    for (const entry of evictable) {
      if (total <= target) break;
      try {
        await fs.promises.rm(entry.file, { force: true });
        total -= entry.bytes;
        removed += 1;
      } catch {
        // Held open elsewhere: skip it, the next sweep tries again.
      }
    }
    recordTileCacheBytes(root, total, writtenBefore);
    return { before, after: total, removed };
  }
  recordTileCacheBytes(root, total, writtenBefore);
  return { before, after: total, removed: 0 };
}

/** The cache's size for the Maps page: the running count when there is one, else
 *  a walk (asynchronous, so the page waits and nothing else does). */
export async function tileCacheBytes(): Promise<number> {
  const known = knownTileCacheBytes();
  if (known !== null) return known;
  const root = tileCacheDir();
  const writtenBefore = bytesWrittenSoFar();
  const bytes = await walk(root, null);
  recordTileCacheBytes(root, bytes, writtenBefore);
  return knownTileCacheBytes() ?? bytes;
}

let lastSweep = 0;
let running: Promise<unknown> | null = null;

/** Called after a write. Cheap when there is nothing to do, which is nearly
 *  always: the running count says the cache is under its cap. */
export function sweepSoon(): void {
  if (running) return;
  const known = knownTileCacheBytes();
  if (known !== null && known <= cacheLimitBytes()) return;
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  // Off the request that triggered it: that request already has its tile.
  running = new Promise((resolve) => setImmediate(resolve))
    .then(() => sweepTileCache())
    .catch(() => {
      // A sweep that failed is tried again on a later write.
    })
    .finally(() => {
      running = null;
    });
}

/** For tests: forget the throttle. */
export function resetSweepThrottle(): void {
  lastSweep = 0;
}

/** For tests: wait for a sweep sweepSoon started. */
export async function sweepSettled(): Promise<void> {
  await running;
}
