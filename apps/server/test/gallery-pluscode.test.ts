import { describe, expect, it } from "vitest";
import { decodePlusCode, parsePlusCode, recoverPlusCode } from "../src/modules/library/gallery/pluscode.js";

// The vectors come from Google's own open-location-code test data, and the values
// here were checked against the reference JavaScript implementation. They are the
// point of this suite: the arithmetic is transcribed, so it is only worth anything
// while it still agrees with the source it was transcribed from.
describe("plus code decoding", () => {
  it("decodes codes of every length to the centre of their square", () => {
    const cases: [string, number, number][] = [
      ["8FVC2222+22", 47.0000625, 8.0000625],
      ["7FG49QCJ+2VX", 20.3701125, 2.782234375],
      ["4VCPPQGP+Q9", -41.2730625, 174.7859375],
      ["62G20000+", 0.5, -179.5],
      ["22220000+", -89.5, -179.5],
      ["7FG40000+", 20.5, 2.5]
    ];
    for (const [code, lat, lng] of cases) {
      const point = decodePlusCode(code);
      expect(point, code).not.toBeNull();
      expect(point!.lat, code).toBeCloseTo(lat, 9);
      expect(point!.lng, code).toBeCloseTo(lng, 9);
    }
  });

  it("refuses codes that aren't codes", () => {
    expect(decodePlusCode("8FVC2222+2")).toBeNull();   // half a pair
    expect(decodePlusCode("8FVC2A22+22")).toBeNull();  // 'A' is not in the alphabet
    expect(decodePlusCode("+")).toBeNull();
  });

  it("recovers a short code against a nearby reference point", () => {
    // Reference implementation: recoverNearest("9QCJ+2VX", 51.3701125, -1.217765625)
    // is "9C3W9QCJ+2VX".
    const point = recoverPlusCode("9QCJ+2VX", { lat: 51.3701125, lng: -1.217765625 });
    expect(point!.lat).toBeCloseTo(decodePlusCode("9C3W9QCJ+2VX")!.lat, 9);
    expect(point!.lng).toBeCloseTo(decodePlusCode("9C3W9QCJ+2VX")!.lng, 9);
  });

  // The reason recovery isn't just "borrow the reference's leading characters":
  // a reference sitting near the edge of its square would otherwise resolve the
  // code to a point a whole square away from the nearest real match.
  it("steps to the neighbouring square when that one is nearer", () => {
    const near = recoverPlusCode("9QCJ+2VX", { lat: 51.3701125, lng: -1.217765625 })!;
    const acrossTheEdge = recoverPlusCode("9QCJ+2VX", { lat: 51.3701125, lng: -1.9 })!;
    expect(acrossTheEdge.lng).toBeCloseTo(near.lng - 1, 9);
  });

  it("resolves the Google Maps form of a Jamaican address", () => {
    const parsed = parsePlusCode("8MW8+4JV, Norman Manley Blvd, Negril, Jamaica")!;
    expect(parsed).toMatchObject({ code: "8MW8+4JV", full: false, rest: "Norman Manley Blvd, Negril, Jamaica" });

    // Anchored on Negril, "8MW8+4JV" is 77C38MW8+4JV — the same answer the
    // reference implementation gives from either the street or the town.
    const point = recoverPlusCode(parsed.code, { lat: 18.2779531, lng: -78.3494771 })!;
    expect(point.lat).toBeCloseTo(18.3453625, 6);
    expect(point.lng).toBeCloseTo(-78.333453125, 6);
  });
});

describe("plus code parsing", () => {
  it("finds a code at either end of an address and keeps the rest", () => {
    expect(parsePlusCode("Negril, Jamaica 8MW8+4JV")).toMatchObject({
      code: "8MW8+4JV", full: false, rest: "Negril, Jamaica"
    });
    expect(parsePlusCode("77C38MW8+4JV")).toMatchObject({ code: "77C38MW8+4JV", full: true, rest: "" });
    expect(parsePlusCode("7FG40000+ somewhere")).toMatchObject({ code: "7FG40000+", full: true, rest: "somewhere" });
  });

  it("is lower-case tolerant, the way a paste is", () => {
    expect(parsePlusCode("8mw8+4jv, negril")).toMatchObject({ code: "8MW8+4JV", rest: "negril" });
  });

  it("leaves ordinary addresses to the geocoder", () => {
    expect(parsePlusCode("Norman Manley Blvd, Negril, Jamaica")).toBeNull();
    expect(parsePlusCode("Minsk")).toBeNull();
    expect(parsePlusCode("53.9, 27.56")).toBeNull();
    // A '+' in a place name is not a code.
    expect(parsePlusCode("Ben & Jerry's + Co, Vermont")).toBeNull();
    // Padding only ever sits at the end of a full code.
    expect(parsePlusCode("8M0W+4JV, Negril")).toBeNull();
    // A single character after the '+' is not a real code.
    expect(parsePlusCode("8MW8+4, Negril")).toBeNull();
  });
});
