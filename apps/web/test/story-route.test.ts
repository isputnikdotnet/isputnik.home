import { describe, expect, it } from "vitest";
import { decodePolyline, greatCircle, legStyle, routeLegs } from "../src/features/stories/story-route";
import type { StoryMapPoint } from "../src/features/stories/types";

// The geometry a route is drawn from. All of it is arithmetic on numbers the
// server sent, so it is worth pinning down: a wrong decode puts a family's
// holiday in the sea.

function stop(lat: number, lng: number, extra: Partial<StoryMapPoint> = {}): StoryMapPoint {
  return { lat, lng, label: null, mode: null, geometry: null, ...extra };
}

describe("decoding an encoded polyline", () => {
  it("reads Google's own worked example", () => {
    // The example from the format's specification: three points in California.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453]
    ]);
  });

  it("gives back nothing for an empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("stops cleanly at a truncated string rather than looping", () => {
    expect(decodePolyline("_p~iF~ps|U_ulL").length).toBeGreaterThanOrEqual(1);
  });
});

describe("a flight's arc", () => {
  it("bends: its middle is not the midpoint of the straight line", () => {
    // London to New York. On a flat map the great circle runs well north of the
    // straight line between them, which is why it has to be drawn and not
    // simply joined up.
    const arc = greatCircle([51.5, -0.13], [40.71, -74.01]);
    const middle = arc[Math.floor(arc.length / 2)];
    expect(middle[0]).toBeGreaterThan((51.5 + 40.71) / 2);
  });

  it("starts and ends exactly where it was told to", () => {
    const arc = greatCircle([51.5, -0.13], [40.71, -74.01]);
    expect(arc[0][0]).toBeCloseTo(51.5, 6);
    expect(arc[arc.length - 1][1]).toBeCloseTo(-74.01, 6);
  });

  it("survives two stops in the same place", () => {
    expect(greatCircle([10, 10], [10, 10])).toHaveLength(2);
  });
});

describe("building a route's legs", () => {
  it("draws a straight line when nothing was followed", () => {
    const legs = routeLegs([stop(53.9, 27.56), stop(54.69, 25.28, { mode: "drive" })]);
    expect(legs).toHaveLength(1);
    expect(legs[0].routed).toBe(false);
    expect(legs[0].coords).toEqual([[53.9, 27.56], [54.69, 25.28]]);
    expect(legStyle(legs[0]).dashArray).toBe("6 6");
  });

  it("follows the stored line when there is one", () => {
    const legs = routeLegs([
      stop(38.5, -120.2),
      stop(43.252, -126.453, { mode: "drive", geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" })
    ]);
    expect(legs[0].routed).toBe(true);
    expect(legs[0].coords).toHaveLength(3);
    // A real road earns a solid stroke; a drawn line does not.
    expect(legStyle(legs[0]).dashArray).toBeUndefined();
  });

  it("arcs a flight instead of cutting across", () => {
    const legs = routeLegs([stop(51.5, -0.13), stop(40.71, -74.01, { mode: "plane" })]);
    expect(legs[0].routed).toBe(false);
    expect(legs[0].coords.length).toBeGreaterThan(2);
  });

  it("has no leg at all for a single stop", () => {
    expect(routeLegs([stop(53.9, 27.56)])).toEqual([]);
  });

  it("falls back to a straight line when the stored line is unreadable", () => {
    const legs = routeLegs([stop(1, 1), stop(2, 2, { mode: "drive", geometry: "?" })]);
    expect(legs[0].coords).toEqual([[1, 1], [2, 2]]);
  });
});
