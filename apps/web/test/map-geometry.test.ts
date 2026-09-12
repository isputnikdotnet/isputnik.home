import { describe, expect, it } from "vitest";
import { dashFor, glZoom, paddedBounds, rasterZoom, toLngLat } from "../src/shared/map/maplibre-geometry";

// The arithmetic between the app's map vocabulary and MapLibre's. Each of these
// fails silently when wrong — a map framed on the wrong continent, one zoom level
// too close, a flight arc drawn across the equator — so each is pinned.

describe("map geometry", () => {
  it("turns [lat, lng] into MapLibre's [lng, lat]", () => {
    // Minsk. The wrong way round is a point in the Indian Ocean.
    expect(toLngLat([53.9, 27.56])).toEqual([27.56, 53.9]);
  });

  it("translates zoom between the raster scale callers use and MapLibre's", () => {
    // MapLibre's 512 px tiles show at z what 256 px raster shows at z + 1.
    expect(glZoom(14)).toBe(13);
    expect(rasterZoom(13)).toBe(14);
    // Never below MapLibre's floor.
    expect(glZoom(0)).toBe(0);
  });

  it("pads bounds by a share of their own size, exactly as Leaflet's pad() did", () => {
    // 2° of latitude by 4° of longitude, padded by a quarter on every side.
    expect(paddedBounds([[50, 20], [52, 24]], 0.25)).toEqual([[19, 49.5], [25, 52.5]]);
  });

  it("has no bounds for no points, and zero extent for one", () => {
    expect(paddedBounds([], 0.25)).toBeNull();
    expect(paddedBounds([[53.9, 27.56]], 0.25)).toEqual([[27.56, 53.9], [27.56, 53.9]]);
  });

  it("stops at the edge of what Web Mercator can draw", () => {
    const [[, south], [, north]] = paddedBounds([[-84, 0], [84, 10]], 0.5)!;
    expect(south).toBeGreaterThanOrEqual(-85.06);
    expect(north).toBeLessThanOrEqual(85.06);
  });

  it("turns pixel dashes into multiples of the line width", () => {
    // "6 6" on a 3 px line: MapLibre counts in widths, so 2 on, 2 off.
    expect(dashFor("6 6", 3)).toEqual([2, 2]);
    expect(dashFor(undefined, 3)).toBeNull();
    expect(dashFor("", 3)).toBeNull();
  });
});
