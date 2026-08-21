import { describe, expect, it } from "vitest";
import {
  COUNTRY_CENTROIDS,
  countryCentroid
} from "../src/features/control/sections/dashboard/countryCentroids";

// countryCentroids.ts is generated (scripts/gen-country-centroids.mjs) from map
// path data by way of a measured projection — nothing in it is documented by the
// source package. These pin the result: if the generator, the fit or the map
// package changes, the bubbles fail loudly here instead of quietly drifting into
// the sea.

// Real coordinates of a point well inside each country, from the usual published
// centres. The generator takes the biggest landmass, so the tolerance is generous
// — this is checking that a bubble lands in the right country, not that it lands
// on a capital. `slack` widens it for a country whose published centre is pulled
// away by land the generator ignores: Russia's is dragged east by Chukotka, which
// the map draws as a separate shape on the far side of the antimeridian.
const DEFAULT_SLACK = 3;
const KNOWN: { code: string; name: string; lat: number; lng: number; slack?: number }[] = [
  { code: "us", name: "United States", lat: 39.8, lng: -98.6 },
  { code: "ru", name: "Russia", lat: 61.5, lng: 105.3, slack: 5 },
  { code: "ca", name: "Canada", lat: 58.0, lng: -106.3 },
  { code: "gb", name: "United Kingdom", lat: 54.0, lng: -2.5 },
  { code: "de", name: "Germany", lat: 51.2, lng: 10.4 },
  { code: "fr", name: "France", lat: 46.6, lng: 2.4 },
  { code: "br", name: "Brazil", lat: -10.3, lng: -53.2 },
  { code: "au", name: "Australia", lat: -25.7, lng: 134.5 },
  { code: "jp", name: "Japan", lat: 36.2, lng: 138.3 },
  { code: "cn", name: "China", lat: 35.9, lng: 104.2 },
  { code: "in", name: "India", lat: 22.9, lng: 79.0 },
  { code: "za", name: "South Africa", lat: -28.5, lng: 24.7 },
  { code: "by", name: "Belarus", lat: 53.7, lng: 27.9 },
  { code: "ua", name: "Ukraine", lat: 48.4, lng: 31.2 },
  // Past the antimeridian on the drawing, so this also pins the longitude wrap.
  { code: "ws", name: "Samoa", lat: -13.8, lng: -172.1 }
];

describe("country centroids", () => {
  it("puts known countries where they actually are", () => {
    for (const country of KNOWN) {
      const point = countryCentroid(country.code);
      expect(point, country.name).not.toBeNull();
      const [lat, lng] = point!;
      const slack = country.slack ?? DEFAULT_SLACK;
      expect(Math.abs(lat - country.lat), `${country.name} latitude`).toBeLessThan(slack);
      expect(Math.abs(lng - country.lng), `${country.name} longitude`).toBeLessThan(slack);
    }
  });

  it("covers the whole map and stays inside the world", () => {
    expect(Object.keys(COUNTRY_CENTROIDS).length).toBeGreaterThan(200);
    for (const [code, [lat, lng]] of Object.entries(COUNTRY_CENTROIDS)) {
      expect(Number.isFinite(lat) && Number.isFinite(lng), code).toBe(true);
      // Leaflet wraps past these, but a bubble outside them means the generator
      // failed to fold a Pacific island back over the antimeridian.
      expect(Math.abs(lat), `${code} latitude`).toBeLessThanOrEqual(85);
      expect(Math.abs(lng), `${code} longitude`).toBeLessThanOrEqual(180);
    }
  });

  it("takes a code in any case and shrugs at one it doesn't know", () => {
    expect(countryCentroid("BY")).toEqual(countryCentroid("by"));
    expect(countryCentroid("zz")).toBeNull();
    expect(countryCentroid("")).toBeNull();
  });
});
