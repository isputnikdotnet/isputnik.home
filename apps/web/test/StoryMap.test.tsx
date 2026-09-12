import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapShapes, MapViewCommand } from "../src/shared/map";
import type { StoryMapPoint } from "../src/features/stories/types";

// A story map's route: one line per leg, the mode's icon riding the middle of
// its own line, and the frame drawn around the LINES rather than just the stops
// — a road that loops north of both ends belongs inside the picture.
//
// Stubbed at the renderer seam. `story-route-shapes.ts` used to draw straight
// onto a Leaflet layer, so none of this could be asserted without mocking a map
// library; now the shapes are just values.

const drawn: { shapes: MapShapes; views: MapViewCommand[]; credits: string[] } = {
  shapes: {},
  views: [],
  credits: []
};

vi.mock("../src/shared/map/renderer", () => ({
  createRenderer: () => ({
    mount: vi.fn(),
    setShapes: (shapes: MapShapes) => { drawn.shapes = shapes; },
    applyView: (view: MapViewCommand) => { drawn.views.push(view); },
    addAttribution: (html: string) => { drawn.credits.push(html); },
    destroy: vi.fn()
  })
}));

const { StoryMap } = await import("../src/features/stories/StoryMap");

beforeEach(() => {
  drawn.shapes = {};
  drawn.views = [];
  drawn.credits = [];
});

const pins = [
  { id: "a", lat: 53.9, lng: 27.56, label: "1", title: "Minsk" },
  { id: "b", lat: 54.69, lng: 25.28, label: "2", title: "Vilnius" }
];

describe("StoryMap", () => {
  it("draws pins without lines when it is not a route", () => {
    render(<StoryMap pins={pins} onOpen={vi.fn()} />);
    expect(drawn.shapes.lines).toHaveLength(0);
    expect(drawn.shapes.markers?.map((marker) => marker.id)).toEqual(["a", "b"]);
  });

  it("joins the stops with a dashed line when nothing was actually routed", () => {
    render(<StoryMap pins={pins} onOpen={vi.fn()} route />);
    expect(drawn.shapes.lines).toHaveLength(1);
    // Dashed is the honest stroke for a line this app drew rather than followed.
    expect(drawn.shapes.lines?.[0].dashArray).toBeDefined();
    expect(drawn.credits).toHaveLength(0);
  });

  it("credits the routing service only when a leg came back from it", () => {
    const stops: StoryMapPoint[] = [
      { lat: 53.9, lng: 27.56, label: "Minsk", mode: null, geometry: null },
      // An encoded polyline is what a followed road looks like in storage.
      { lat: 54.69, lng: 25.28, label: "Vilnius", mode: "drive", geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }
    ];
    render(<StoryMap pins={pins} onOpen={vi.fn()} route stops={stops} />);
    expect(drawn.credits[0]).toMatch(/openrouteservice/);
    expect(drawn.shapes.lines?.[0].dashArray).toBeUndefined();
    // The mode badge rides the line, under the numbered stops.
    const badge = drawn.shapes.markers?.find((marker) => marker.className === "story-map-mode");
    expect(badge?.interactive).toBe(false);
    expect(badge?.zIndex).toBe(-100);
  });

  it("frames the line, not just the stops", () => {
    const stops: StoryMapPoint[] = [
      { lat: 53.9, lng: 27.56, label: "Minsk", mode: null, geometry: null },
      { lat: 54.69, lng: 25.28, label: "Vilnius", mode: "plane", geometry: null }
    ];
    render(<StoryMap pins={pins} onOpen={vi.fn()} route stops={stops} />);
    const view = drawn.views.at(-1);
    // A flight is drawn as a great-circle arc, so the framed points far outnumber
    // the two stops — that is exactly what must be inside the picture.
    expect(view?.kind).toBe("fit");
    expect(view && "points" in view ? view.points.length : 0).toBeGreaterThan(pins.length);
  });

  it("escapes a label before it reaches the pin's markup", () => {
    render(<StoryMap pins={[{ ...pins[0], label: '<img src=x onerror="boom">' }]} onOpen={vi.fn()} />);
    expect(drawn.shapes.markers?.[0].html).not.toContain("<img");
    expect(drawn.shapes.markers?.[0].html).toContain("&lt;img");
  });
});
