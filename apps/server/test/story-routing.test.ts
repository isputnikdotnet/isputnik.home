import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { ROUTING_SETTINGS_KEY, isRoutableMode, routeLeg } from "../src/core/routing.js";
import { resolveRouteGeometry } from "../src/modules/stories/route-geometry.js";
import { sealSecret } from "../src/core/mfa.js";
import { resetDb } from "./helpers/seed.js";

// Following roads is the one thing here that reaches outside the house, so what
// is tested is exactly that: when it is asked, when it is not, and what happens
// when the answer never comes.

const MINSK = { lat: 53.9, lng: 27.56, label: "Minsk", mode: null };
const VILNIUS = { lat: 54.69, lng: 25.28, label: "Vilnius", mode: "drive" };
const RIGA = { lat: 56.95, lng: 24.11, label: "Riga", mode: "drive" };

function saveKey(apiKey: string, endpoint = "") {
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)")
    .run(ROUTING_SETTINGS_KEY, JSON.stringify({ apiKey: sealSecret(apiKey), endpoint }));
}

/** A routing service that always answers, counting how often it was asked. */
function stubService(geometry = "_p~iF~ps|U") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ routes: [{ geometry }] }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which modes have roads", () => {
  it("routes the ones that travel on them, and draws the rest", () => {
    expect(["walk", "cycle", "drive", "bus"].every(isRoutableMode)).toBe(true);
    // No road router knows a railway, a flight path or open water — asking
    // would return a car's route between two stations, which is a lie.
    expect(["train", "plane", "boat"].some(isRoutableMode)).toBe(false);
    expect(isRoutableMode(null)).toBe(false);
  });
});

describe("asking the routing service", () => {
  it("stays home until a key is saved", async () => {
    const calls = stubService();
    expect(await routeLeg(MINSK, VILNIUS, "drive")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never asks about a leg that has no road", async () => {
    saveKey("test-key");
    const calls = stubService();
    expect(await routeLeg(MINSK, VILNIUS, "plane")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns the line, and asks the profile the mode maps to", async () => {
    saveKey("test-key");
    const calls = stubService("abc123");
    expect(await routeLeg(MINSK, VILNIUS, "walk")).toBe("abc123");
    expect(calls[0]).toContain("/v2/directions/foot-walking");
  });

  it("goes to a self-hosted service when one is configured", async () => {
    saveKey("test-key", "https://router.example.test/");
    const calls = stubService();
    await routeLeg(MINSK, VILNIUS, "drive");
    expect(calls[0]).toBe("https://router.example.test/v2/directions/driving-car");
  });

  it("falls back to a drawn line when the service will not answer", async () => {
    saveKey("test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await routeLeg(MINSK, VILNIUS, "drive")).toBeNull();
  });

  it("falls back to a drawn line when the request throws", async () => {
    saveKey("test-key");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network is down"); }));
    expect(await routeLeg(MINSK, VILNIUS, "drive")).toBeNull();
  });
});

describe("resolving a route's legs", () => {
  it("asks once per routable leg and leaves the first stop alone", async () => {
    saveKey("test-key");
    const calls = stubService();
    const points = await resolveRouteGeometry([MINSK, VILNIUS, RIGA], []);
    expect(calls).toHaveLength(2);
    expect(points[0]).toMatchObject({ mode: null, geometry: null });
    expect(points[1].geometry).not.toBeNull();
    expect(points[2].geometry).not.toBeNull();
  });

  it("reuses the line of a leg nothing changed about", async () => {
    saveKey("test-key");
    const calls = stubService();
    const existing = await resolveRouteGeometry([MINSK, VILNIUS, RIGA], []);
    calls.length = 0;
    // Renaming a stop moves nothing, so no leg is asked about again.
    const renamed = await resolveRouteGeometry(
      [{ ...MINSK, label: "Home" }, VILNIUS, RIGA],
      existing
    );
    expect(calls).toHaveLength(0);
    expect(renamed[1].geometry).toBe(existing[1].geometry);
  });

  it("asks again when a leg's mode changes, because a walk is not a drive", async () => {
    saveKey("test-key");
    const calls = stubService();
    const existing = await resolveRouteGeometry([MINSK, VILNIUS], []);
    calls.length = 0;
    await resolveRouteGeometry([MINSK, { ...VILNIUS, mode: "walk" }], existing);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("foot-walking");
  });

  it("asks again when a stop is dragged somewhere else", async () => {
    saveKey("test-key");
    const calls = stubService();
    const existing = await resolveRouteGeometry([MINSK, VILNIUS], []);
    calls.length = 0;
    await resolveRouteGeometry([MINSK, { ...VILNIUS, lat: 54.7 }], existing);
    expect(calls).toHaveLength(1);
  });

  it("only asks about the leg that was added", async () => {
    saveKey("test-key");
    const calls = stubService();
    const existing = await resolveRouteGeometry([MINSK, VILNIUS], []);
    calls.length = 0;
    await resolveRouteGeometry([MINSK, VILNIUS, RIGA], existing);
    expect(calls).toHaveLength(1);
  });

  it("carries a leg's line through a reorder that keeps the leg itself", async () => {
    saveKey("test-key");
    const calls = stubService();
    const existing = await resolveRouteGeometry([RIGA, MINSK, VILNIUS], []);
    calls.length = 0;
    // Minsk → Vilnius is still Minsk → Vilnius, wherever it sits in the list.
    const moved = await resolveRouteGeometry([MINSK, VILNIUS], existing);
    expect(calls).toHaveLength(0);
    expect(moved[1].geometry).toBe(existing[2].geometry);
  });

  it("leaves every leg drawn when routing is switched off", async () => {
    const calls = stubService();
    const points = await resolveRouteGeometry([MINSK, VILNIUS, RIGA], []);
    expect(calls).toHaveLength(0);
    expect(points.every((point) => point.geometry === null)).toBe(true);
  });
});
