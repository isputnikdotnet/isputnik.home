// The tile cache cap. What must hold: the cache comes back under its cap, the
// tiles fetched longest ago go first, and the small files every map needs —
// styles, the TileJSON, glyphs, sprites — are never evicted to make room.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSweepThrottle, sweepSoon, sweepTileCache } from "../src/modules/maps/sweep.js";

let dataDir = "";

/** A cached file of `kb` kilobytes, fetched `daysAgo` days ago. */
function cached(relative: string, kb: number, daysAgo: number): string {
  const file = path.join(dataDir, "Tiles", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(kb * 1024));
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-map-sweep-"));
  process.env.MAP_DATA_PATH = dataDir;
  resetSweepThrottle();
});

afterEach(() => {
  delete process.env.MAP_DATA_PATH;
  delete process.env.MAP_CACHE_LIMIT_MB;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("sweepTileCache", () => {
  it("leaves a cache under its cap alone", () => {
    const tile = cached("vector/14/1/1.pbf.gz", 10, 1);
    expect(sweepTileCache(1024 * 1024)).toEqual({ before: 10 * 1024, after: 10 * 1024, removed: 0 });
    expect(fs.existsSync(tile)).toBe(true);
  });

  it("removes the tiles fetched longest ago until the cache is back under its cap", () => {
    const oldest = cached("raster/6/1/1.png", 100, 20);
    const older = cached("vector/14/1/1.pbf.gz", 100, 10);
    const newer = cached("vector/14/1/2.pbf.gz", 100, 1);

    const result = sweepTileCache(250 * 1024);
    expect(result.removed).toBe(1);
    expect(result.after).toBeLessThanOrEqual(250 * 1024);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(older)).toBe(true);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it("sweeps below the cap, not to it, so the next write does not sweep again", () => {
    for (let i = 0; i < 10; i += 1) cached(`vector/14/0/${i}.pbf.gz`, 10, 10 - i);
    // 100 KB against a 95 KB cap: getting under 95 would take one tile, but the
    // low-water mark (90% of the cap, 85.5 KB) takes two.
    const result = sweepTileCache(95 * 1024);
    expect(result.removed).toBe(2);
    expect(result.after).toBe(80 * 1024);
  });

  it("never evicts what every map needs, even when that alone is over the cap", () => {
    const keep = [
      cached("styles/liberty.json.gz", 40, 400),
      cached("tilejson.json.gz", 5, 400),
      cached("fonts/Noto Sans Regular/0-255.pbf.gz", 40, 400),
      cached("sprites/ofm_f384/ofm@2x.png", 120, 400)
    ];
    const tile = cached("vector/14/1/1.pbf.gz", 10, 1);

    const result = sweepTileCache(50 * 1024);
    // The tile goes — it is the only thing that can — and the rest is counted
    // honestly as still over the cap rather than pretending otherwise.
    expect(fs.existsSync(tile)).toBe(false);
    for (const file of keep) expect(fs.existsSync(file)).toBe(true);
    expect(result.after).toBe(205 * 1024);
  });

  it("copes with no cache folder at all", () => {
    expect(sweepTileCache()).toEqual({ before: 0, after: 0, removed: 0 });
  });
});

describe("sweepSoon", () => {
  it("sweeps off the request path, and not again straight away", async () => {
    process.env.MAP_CACHE_LIMIT_MB = String(100 / 1024); // 100 KB
    const first = cached("vector/14/1/1.pbf.gz", 80, 5);
    cached("vector/14/1/2.pbf.gz", 80, 1);

    sweepSoon();
    // Nothing has happened yet: the sweep waits for the current turn to finish.
    expect(fs.existsSync(first)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(first)).toBe(false);

    // Over the cap again at once, but the throttle holds it off.
    const again = cached("vector/14/1/3.pbf.gz", 80, 3);
    sweepSoon();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(again)).toBe(true);
  });
});
