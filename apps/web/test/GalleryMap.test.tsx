import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapHandlers, MapOptions, MapShapes } from "../src/shared/map";
import type { GalleryMapPoint } from "../src/features/gallery/types";

// The map is built once and then left alone — tearing it down would throw away
// wherever the reader had panned to — so a marker's click handler outlives the
// render that made it and reaches today's `onOpen` through a ref. That ref is
// written in an effect, and an effect with the wrong deps (or none) would freeze
// the handler on the callback the map happened to be built with. This is the test
// that would notice.
//
// Stubbed at the RENDERER seam rather than at Leaflet: what is being checked is
// which callback a marker click reaches and what the map was asked to draw, and
// neither is a fact about any particular map library. A test that mocked Leaflet
// would have to be rewritten the day the renderer changes; this one will not.

const built: {
  options: MapOptions | null;
  handlers: MapHandlers;
  shapes: MapShapes;
} = { options: null, handlers: {}, shapes: {} };

vi.mock("../src/shared/map/renderer", () => ({
  createRenderer: () => ({
    mount: (_container: HTMLElement, options: MapOptions, handlers: MapHandlers) => {
      built.options = options;
      built.handlers = handlers;
    },
    setShapes: (shapes: MapShapes) => { built.shapes = shapes; },
    applyView: vi.fn(),
    addAttribution: vi.fn(),
    destroy: vi.fn()
  })
}));

const { GalleryMap } = await import("../src/features/gallery/GalleryMap");

const point = (id: string, kind: "photo" | "video" = "photo"): GalleryMapPoint => ({
  id,
  lat: 53.9,
  lng: 27.56,
  title: id,
  kind,
  coverUrl: null
} as GalleryMapPoint);

beforeEach(() => {
  built.options = null;
  built.handlers = {};
  built.shapes = {};
});

describe("GalleryMap", () => {
  it("opens the asset a marker stands for", () => {
    const onOpen = vi.fn();
    render(<GalleryMap points={[point("a1")]} onOpen={onOpen} />);
    act(() => { built.handlers.onMarkerClick?.("a1"); });
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("calls the newest onOpen after the prop changes, not the one the map was built with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<GalleryMap points={[point("a1")]} onOpen={first} />);
    act(() => { built.handlers.onMarkerClick?.("a1"); });
    expect(first).toHaveBeenCalledTimes(1);

    // A props-only re-render: the map is NOT rebuilt (the same marker is still the
    // one on screen), so the only way the new callback can be reached is the ref.
    rerender(<GalleryMap points={[point("a1")]} onOpen={second} />);
    act(() => { built.handlers.onMarkerClick?.("a1"); });
    expect(second).toHaveBeenCalledWith("a1");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("draws one clustered marker per point, and marks the videos", () => {
    render(<GalleryMap points={[point("a1"), point("v1", "video")]} onOpen={vi.fn()} />);
    expect(built.options?.cluster).toBe(true);
    expect(built.shapes.markers?.map((marker) => marker.id)).toEqual(["a1", "v1"]);
    expect(built.shapes.markers?.[0].html).not.toMatch(/is-video/);
    expect(built.shapes.markers?.[1].html).toMatch(/is-video/);
  });
});
