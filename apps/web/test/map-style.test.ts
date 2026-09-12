import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absolutizeStyle,
  forgetMapConfig,
  loadMapConfig,
  loadMapStyle,
  localizeLabels,
  styleNameFor,
  type MapConfig
} from "../src/shared/map/map-style";

// Preparing a style for MapLibre. The two rewrites are the point of the file:
//  - a proxied style is root-relative (the server cannot know this page's
//    origin), and MapLibre loads tiles in a worker where relative URLs resolve
//    to nothing — so every fetched URL must leave here absolute;
//  - labels follow the interface language, but a road number stays a road number.

afterEach(() => {
  forgetMapConfig();
  vi.mocked(globalThis.fetch).mockReset?.();
});

const relativeStyle = () => ({
  sources: {
    openmaptiles: { type: "vector", tiles: ["/api/map/tiles/{z}/{x}/{y}.pbf?share=tok"] },
    ne2_shaded: { type: "raster", tiles: ["/api/map/raster/{z}/{x}/{y}.png?share=tok"] },
    elsewhere: { type: "vector", url: "https://tiles.openfreemap.org/planet" }
  },
  glyphs: "/api/map/fonts/{fontstack}/{range}.pbf?share=tok",
  sprite: "/api/map/sprites/ofm_f384/ofm?share=tok",
  layers: [
    { id: "place", type: "symbol", layout: { "text-field": ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], " ", ["get", "name:nonlatin"]], ["coalesce", ["get", "name_en"], ["get", "name"]]] } },
    { id: "legacy", type: "symbol", layout: { "text-field": "{name:latin}\n{name:nonlatin}" } },
    { id: "road-shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "ref"]] } },
    { id: "water", type: "fill", layout: {} }
  ]
});

describe("absolutizeStyle", () => {
  it("makes every root-relative URL absolute on this page's origin, and leaves absolute ones alone", () => {
    const style = absolutizeStyle(relativeStyle(), "http://192.168.1.20:4000");
    expect(style.sources!.openmaptiles.tiles).toEqual(["http://192.168.1.20:4000/api/map/tiles/{z}/{x}/{y}.pbf?share=tok"]);
    expect(style.sources!.ne2_shaded.tiles).toEqual(["http://192.168.1.20:4000/api/map/raster/{z}/{x}/{y}.png?share=tok"]);
    expect(style.glyphs).toBe("http://192.168.1.20:4000/api/map/fonts/{fontstack}/{range}.pbf?share=tok");
    expect(style.sprite).toBe("http://192.168.1.20:4000/api/map/sprites/ofm_f384/ofm?share=tok");
    expect(style.sources!.elsewhere.url).toBe("https://tiles.openfreemap.org/planet");
  });

  it("handles a sprite given as a list of sheets", () => {
    const style = absolutizeStyle({ sprite: [{ id: "default", url: "/api/map/sprites/v1/ofm" }] }, "https://home.example");
    expect(style.sprite).toEqual([{ id: "default", url: "https://home.example/api/map/sprites/v1/ofm" }]);
  });
});

describe("localizeLabels", () => {
  const fieldOf = (style: ReturnType<typeof relativeStyle>, id: string) =>
    style.layers.find((layer) => layer.id === id)!.layout["text-field"];

  it("shows place names in Russian for a Russian interface, falling back to the local name", () => {
    const style = localizeLabels(relativeStyle(), "ru") as ReturnType<typeof relativeStyle>;
    expect(fieldOf(style, "place")).toEqual(["coalesce", ["get", "name:ru"], ["get", "name"]]);
    // The older token form of a name label is recognised too.
    expect(fieldOf(style, "legacy")).toEqual(["coalesce", ["get", "name:ru"], ["get", "name"]]);
  });

  it("shows English names for any other interface language", () => {
    const style = localizeLabels(relativeStyle(), "en-GB") as ReturnType<typeof relativeStyle>;
    expect(fieldOf(style, "place")).toEqual(["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]]);
  });

  it("leaves labels that are not names alone — a road number is not translated", () => {
    const style = localizeLabels(relativeStyle(), "ru") as ReturnType<typeof relativeStyle>;
    expect(fieldOf(style, "road-shield")).toEqual(["to-string", ["get", "ref"]]);
  });
});

describe("loading", () => {
  const CONFIG: MapConfig = {
    mode: "proxied",
    styles: { liberty: "/api/map/styles/liberty?share=tok", positron: "", bright: "", dark: "/api/map/styles/dark?share=tok" },
    attribution: ""
  };

  it("asks for the config with the share link, once per page, and not again after a failure", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(CONFIG), { status: 200 }));
    await loadMapConfig("tok");
    await loadMapConfig("tok");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/map/config?share=tok"]);

    forgetMapConfig();
    fetchMock.mockImplementationOnce(async () => new Response("nope", { status: 502 }));
    await expect(loadMapConfig("tok")).rejects.toThrow(/502/);
    // The failure is not cached: the next map tries again.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(CONFIG), { status: 200 }));
    await expect(loadMapConfig("tok")).resolves.toEqual(CONFIG);
  });

  it("picks the dark style on a dark theme, prepares it, and hands out copies", async () => {
    expect(styleNameFor(true)).toBe("dark");
    expect(styleNameFor(false)).toBe("liberty");
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input) => {
      expect(String(input)).toBe("/api/map/styles/dark?share=tok");
      return new Response(JSON.stringify(relativeStyle()), { status: 200 });
    });
    const first = await loadMapStyle(CONFIG, true);
    expect((first.sources as Record<string, { tiles?: string[] }>).openmaptiles.tiles![0]).toBe(
      `${window.location.origin}/api/map/tiles/{z}/{x}/{y}.pbf?share=tok`
    );
    // Our own server gets the session cookie.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });

    // Mutating what MapLibre was handed must not reach the next map.
    (first as { glyphs?: string }).glyphs = "changed";
    const second = await loadMapStyle(CONFIG, true);
    expect(second.glyphs).not.toBe("changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the provider no cookies when maps come straight from it", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(relativeStyle()), { status: 200 }));
    await loadMapStyle({ ...CONFIG, mode: "direct", styles: { ...CONFIG.styles, liberty: "https://tiles.openfreemap.org/styles/liberty" } }, false);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
  });
});
