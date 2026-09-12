import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapShapes, MapViewCommand } from "../src/shared/map";

// What the Locations map asks to be DRAWN, which is the whole of its logic: a
// country bubble stands for the sign-ins its own towns didn't account for, towns
// are drawn biggest-first so a small one inside a big one stays clickable, and
// the selection is a class on a shape rather than a redraw.
//
// Stubbed at the renderer seam, so none of this depends on a map library — and
// none of it has to change the day the renderer does. The dev database has only
// localhost sign-ins, so these branches cannot be reached in the running app at
// all; this is the only place they are exercised.

const drawn: { shapes: MapShapes; views: MapViewCommand[]; circleClick?: (id: string) => void } = {
  shapes: {},
  views: []
};

vi.mock("../src/shared/map/renderer", () => ({
  createRenderer: () => ({
    mount: (_el: HTMLElement, _options: unknown, handlers: { onCircleClick?: (id: string) => void }) => {
      drawn.circleClick = handlers.onCircleClick;
    },
    setShapes: (shapes: MapShapes) => { drawn.shapes = shapes; },
    applyView: (view: MapViewCommand) => { drawn.views.push(view); },
    addAttribution: vi.fn(),
    destroy: vi.fn()
  })
}));

const { LocationsMap } = await import("../src/features/control/sections/dashboard/LocationsMap");

beforeEach(() => {
  drawn.shapes = {};
  drawn.views = [];
  drawn.circleClick = undefined;
});

const props = {
  countries: [{ code: "by", name: "Belarus", connections: 10 }],
  selected: null,
  onSelect: vi.fn()
};

describe("LocationsMap", () => {
  it("draws a country bubble for the connections its towns did not cover", () => {
    render(
      <LocationsMap
        {...props}
        places={[{ code: "by", city: "Minsk", region: null, country: "Belarus", latitude: 53.9, longitude: 27.56, connections: 4 }]}
      />
    );
    const country = drawn.shapes.circles?.find((circle) => circle.className.includes("locations-map-country"));
    const town = drawn.shapes.circles?.find((circle) => circle.className.includes("locations-map-town"));
    // 10 total, 4 of them in Minsk: the bubble stands for the remaining 6, and
    // says so rather than double-counting the town underneath it.
    expect(country?.tooltip).toBe("Belarus, elsewhere: 6 connections");
    expect(town?.tooltip).toBe("Minsk, Belarus: 4 connections");
  });

  it("drops the country bubble when its towns account for everything", () => {
    render(
      <LocationsMap
        {...props}
        places={[{ code: "by", city: "Minsk", region: null, country: "Belarus", latitude: 53.9, longitude: 27.56, connections: 10 }]}
      />
    );
    expect(drawn.shapes.circles?.filter((circle) => circle.className.includes("locations-map-country"))).toHaveLength(0);
  });

  it("marks the selected country's shapes, and flies to them", () => {
    render(<LocationsMap {...props} selected="by" />);
    expect(drawn.shapes.circles?.[0].selected).toBe(true);
    // The fit comes first, then the selection overrides it — a selection made in
    // the same commit must win, or the map frames the world and stays there.
    expect(drawn.views.at(-1)).toMatchObject({ kind: "fly", minZoom: 5, maxZoom: 9 });
  });

  it("selects the country a town belongs to, and toggles it off again", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <LocationsMap
        {...props}
        onSelect={onSelect}
        places={[{ code: "by", city: "Minsk", region: null, country: "Belarus", latitude: 53.9, longitude: 27.56, connections: 4 }]}
      />
    );
    const town = drawn.shapes.circles?.find((circle) => circle.className.includes("locations-map-town"));
    // The id carries the row as well, so two towns of one country stay distinct;
    // what a click SELECTS is still the country.
    drawn.circleClick?.(town!.id);
    expect(onSelect).toHaveBeenCalledWith("by");

    rerender(
      <LocationsMap
        {...props}
        selected="by"
        onSelect={onSelect}
        places={[{ code: "by", city: "Minsk", region: null, country: "Belarus", latitude: 53.9, longitude: 27.56, connections: 4 }]}
      />
    );
    drawn.circleClick?.(town!.id);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("opens on the world when there is nothing to show", () => {
    render(<LocationsMap countries={[]} selected={null} onSelect={vi.fn()} />);
    expect(drawn.shapes.circles).toHaveLength(0);
    expect(drawn.views.at(-1)).toMatchObject({ kind: "fit", points: [], empty: { center: [25, 10], zoom: 2 } });
  });
});
