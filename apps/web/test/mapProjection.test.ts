import { describe, expect, it } from "vitest";
import {
  MAP_VIEWBOX_HEIGHT,
  MAP_VIEWBOX_WIDTH,
  projectToMap
} from "../src/features/control/sections/dashboard/mapProjection";

// The constants in mapProjection.ts were measured against the bundled map, not
// documented by it — so these pin the measurement. If someone swaps the map
// package for another one, these fail loudly instead of the dots quietly drifting
// into the sea.
//
// Expected pixels come from the browser check that validated the fit: each of
// these cities was confirmed to land inside (or within half a pixel of) its own
// country's filled path on the real map.

const CITIES: { name: string; lat: number; lon: number; x: number; y: number }[] = [
  { name: "London", lat: 51.5074, lon: -0.1278, x: 474.7, y: 294.7 },
  { name: "Cairo", lat: 30.0444, lon: 31.2357, x: 562.7, y: 375.1 },
  { name: "Tokyo", lat: 35.6895, lon: 139.692, x: 867.3, y: 356.3 },
  { name: "Reykjavik", lat: 64.1466, lon: -21.9426, x: 413.4, y: 227.5 },
  { name: "Buenos Aires", lat: -34.6037, lon: -58.3816, x: 311.1, y: 566.3 },
  { name: "Sydney", lat: -33.8688, lon: 151.2093, x: 899.6, y: 563.9 },
  { name: "Sao Paulo", lat: -23.5505, lon: -46.6333, x: 344.1, y: 530.9 },
  { name: "Nairobi", lat: -1.2921, lon: 36.8219, x: 578.4, y: 466.8 }
];

describe("projectToMap", () => {
  it("puts known cities where the map draws their countries", () => {
    for (const city of CITIES) {
      const point = projectToMap(city.lat, city.lon);
      expect(point, city.name).not.toBeNull();
      // Half a pixel on a 1010px map — the tolerance the coastline itself has.
      expect(Math.abs(point!.x - city.x), `${city.name} x`).toBeLessThan(0.5);
      expect(Math.abs(point!.y - city.y), `${city.name} y`).toBeLessThan(0.5);
    }
  });

  it("grows east and south, the way the viewBox does", () => {
    const west = projectToMap(0, -100)!;
    const east = projectToMap(0, 100)!;
    const north = projectToMap(40, 0)!;
    const south = projectToMap(-40, 0)!;
    expect(east.x).toBeGreaterThan(west.x);
    expect(south.y).toBeGreaterThan(north.y);
  });

  it("keeps everything it returns inside the drawing", () => {
    for (let lat = -80; lat <= 80; lat += 5) {
      for (let lon = -180; lon <= 180; lon += 15) {
        const point = projectToMap(lat, lon);
        if (!point) continue;
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(MAP_VIEWBOX_WIDTH);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(MAP_VIEWBOX_HEIGHT);
      }
    }
  });

  it("declines the poles and anything unmeasurable rather than drawing off-map", () => {
    expect(projectToMap(90, 0)).toBeNull();
    expect(projectToMap(-90, 0)).toBeNull();
    expect(projectToMap(-70, 0)).toBeNull(); // below the map's southern crop
    expect(projectToMap(Number.NaN, 10)).toBeNull();
    expect(projectToMap(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
