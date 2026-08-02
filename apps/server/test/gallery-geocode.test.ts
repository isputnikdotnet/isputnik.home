import { afterEach, describe, expect, it, vi } from "vitest";
import { searchPlaces } from "../src/modules/library/gallery/geocode.js";

// The lookup is a thin proxy over Nominatim; the network is stubbed so the suite
// never leaves the machine. Each test uses a distinct query — the module caches
// by query text for the life of the process.
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gallery place lookup", () => {
  it("maps rows to points and drops malformed ones", async () => {
    stubFetch(200, [
      { display_name: "Minsk, Belarus", lat: "53.9006", lon: "27.5590" },
      { display_name: "No coordinates" },
      { lat: "1", lon: "2" } // no label
    ]);

    expect(await searchPlaces("minsk")).toEqual([{ label: "Minsk, Belarus", lat: 53.9006, lng: 27.559 }]);
  });

  it("serves a repeat query from cache without calling out again", async () => {
    const spy = stubFetch(200, [{ display_name: "Vilnius, Lithuania", lat: "54.687", lon: "25.28" }]);

    const first = await searchPlaces("vilnius");
    const second = await searchPlaces("  VILNIUS  "); // same query, different casing/padding
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips the network for an empty query", async () => {
    const spy = stubFetch(200, []);
    expect(await searchPlaces("   ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("turns a rate-limit or failure into a readable error", async () => {
    stubFetch(429, []);
    await expect(searchPlaces("rate limited place")).rejects.toThrow(/rate-limiting/i);

    stubFetch(500, []);
    await expect(searchPlaces("broken place")).rejects.toThrow(/lookup failed/i);
  });

  it("reports a network failure instead of throwing raw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    await expect(searchPlaces("offline place")).rejects.toThrow(/isn’t responding/);
  });
});
