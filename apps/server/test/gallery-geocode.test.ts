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

  // Nominatim answers a Plus Code with an empty list, so these never reach it.
  it("decodes a full Plus Code without asking the geocoder", async () => {
    const spy = stubFetch(200, []);
    const hits = await searchPlaces("77C38MW8+4JV");
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("77C38MW8+4JV");
    expect(hits[0].lat).toBeCloseTo(18.3453625, 9);
    expect(hits[0].lng).toBeCloseTo(-78.333453125, 9);
    expect(spy).not.toHaveBeenCalled();
  });

  // The form Google Maps hands out: a short code plus the address that locates it.
  // One lookup, for the address, and the code is recovered against the answer.
  it("anchors a short Plus Code on the address written beside it", async () => {
    const spy = stubFetch(200, [
      { display_name: "Norman Manley Boulevard, Negril, Westmoreland, Jamaica", lat: "18.2793802", lon: "-78.3460672" }
    ]);

    const hits = await searchPlaces("8MW8+4JV, Norman Manley Blvd, Negril, Jamaica");
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("8MW8+4JV, Norman Manley Boulevard, Negril, Westmoreland, Jamaica");
    expect(hits[0].lat).toBeCloseTo(18.3453625, 6);
    expect(hits[0].lng).toBeCloseTo(-78.333453125, 6);
    // The address went out; the code did not.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain("Norman+Manley");
  });

  it("says what a bare short code is missing", async () => {
    const spy = stubFetch(200, []);
    await expect(searchPlaces("8MW8+4JV")).rejects.toThrow(/needs the town or country/);
    expect(spy).not.toHaveBeenCalled();
  });

  // No anchor, no answer — but the search still falls through rather than failing,
  // so a query that merely looks like a code is handled by the geocoder as usual.
  it("falls back to the geocoder when the anchor can't be found", async () => {
    const spy = stubFetch(200, []);
    expect(await searchPlaces("8MW8+4JV, Nowhere At All")).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });
});
