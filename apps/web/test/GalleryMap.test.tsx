import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryMapPoint } from "../src/features/gallery/types";

// The map is built once and then left alone — tearing it down would throw away
// wherever the reader had panned to — so a marker's click handler outlives the
// render that made it and reaches today's `onOpen` through a ref. That ref is
// written in an effect, and an effect with the wrong deps (or none) would freeze
// the handler on the callback the map happened to be built with. This is the test
// that would notice.
//
// Leaflet is stubbed rather than driven: jsdom has no layout, and what is being
// checked is which callback the handler reaches, not what the tiles look like.

interface FakeMarker { point: [number, number]; title?: string; click?: () => void }

const built: {
  markers: FakeMarker[];
  attributions: string[];
  fitBounds: number;
} = { markers: [], attributions: [], fitBounds: 0 };

vi.mock("leaflet.markercluster", () => ({}));
vi.mock("leaflet", () => {
  const map = {
    addLayer: vi.fn(),
    remove: vi.fn(),
    invalidateSize: vi.fn(),
    fitBounds: vi.fn(() => { built.fitBounds += 1; })
  };
  const L = {
    map: vi.fn(() => ({ setView: vi.fn(() => map) })),
    tileLayer: vi.fn((_url: string, options: { attribution: string }) => {
      built.attributions.push(options.attribution);
      return { addTo: vi.fn() };
    }),
    markerClusterGroup: vi.fn(() => ({ clearLayers: vi.fn(), addLayer: vi.fn() })),
    divIcon: vi.fn((options: unknown) => options),
    marker: vi.fn((point: [number, number], options: { title?: string }) => {
      const marker: FakeMarker = { point, title: options.title };
      built.markers.push(marker);
      return { on: (event: string, handler: () => void) => { if (event === "click") marker.click = handler; } };
    }),
    latLngBounds: vi.fn(() => ({ pad: vi.fn(() => ({})) }))
  };
  return { default: L };
});

const { GalleryMap } = await import("../src/features/gallery/GalleryMap");

const point = (id: string): GalleryMapPoint => ({
  id,
  lat: 53.9,
  lng: 27.56,
  title: id,
  kind: "photo",
  coverUrl: null
} as GalleryMapPoint);

beforeEach(() => {
  built.markers = [];
  built.attributions = [];
  built.fitBounds = 0;
});

describe("GalleryMap", () => {
  it("opens the asset a marker stands for", () => {
    const onOpen = vi.fn();
    render(<GalleryMap points={[point("a1")]} onOpen={onOpen} />);
    act(() => { built.markers[0].click!(); });
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("calls the newest onOpen after the prop changes, not the one the map was built with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<GalleryMap points={[point("a1")]} onOpen={first} />);
    act(() => { built.markers[0].click!(); });
    expect(first).toHaveBeenCalledTimes(1);

    // A props-only re-render: the map is NOT rebuilt (the same marker is still the
    // one on screen), so the only way the new callback can be reached is the ref.
    rerender(<GalleryMap points={[point("a1")]} onOpen={second} />);
    act(() => { built.markers[0].click!(); });
    expect(second).toHaveBeenCalledWith("a1");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("credits the tiles in the language the map was built in", () => {
    render(<GalleryMap points={[]} onOpen={vi.fn()} />);
    // Seeded from `t` when the ref was created, so the create-once effect has real
    // wording to hand the layer rather than the empty string a later effect fills in.
    expect(built.attributions).toHaveLength(1);
    expect(built.attributions[0]).toMatch(/OpenStreetMap/);
  });
});
