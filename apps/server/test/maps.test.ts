// The map proxy (docs/map-approach-proposal.md, phase 1b, server half).
//
// What these pin, in order of how badly it would hurt to get wrong:
//
//  1. A rewritten style names no host at all: everything MapLibre fetches from
//     it is root-relative, because this server cannot know the browser's
//     origin (a proxy rewriting Host once pointed maps at 127.0.0.1:4000).
//  2. Nobody without a session or a live share link can use this server as a
//     map proxy — an internet-facing install would otherwise fill its own disk
//     for strangers.
//  3. Coordinates that cannot exist are refused here, because upstream happily
//     answers 200 for them and the cache would fill with junk keys.
//  4. A map on disk survives the internet going away (stale-on-error), and a
//     tile is fetched once however many tabs ask for it at the same moment.
//  5. Off costs no disk: caching off refuses to proxy, and turning it off
//     deletes what was kept.
//
// The upstream is stubbed at fetchSafely, the app's one door to the internet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { futureIso, makeUser, pastIso, resetDb } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

// --- Upstream stub -----------------------------------------------------------

const UPSTREAM = "https://tiles.openfreemap.org";
const TEMPLATE = `${UPSTREAM}/planet/20260906_080001_pt/{z}/{x}/{y}.pbf`;

interface Stubbed { status: number; body: Buffer }
const upstream = {
  calls: [] as string[],
  answer: (_url: string): Stubbed | Error => ({ status: 404, body: Buffer.alloc(0) })
};

vi.mock("../src/core/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/safe-fetch.js")>();
  return {
    ...actual,
    fetchSafely: async <T>(url: string, _opts: unknown, consume: (response: never) => Promise<T>): Promise<T> => {
      upstream.calls.push(url);
      const answer = upstream.answer(url);
      if (answer instanceof Error) throw answer;
      const response = {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: new Headers({ "content-length": String(answer.body.length) }),
        body: { cancel: async () => {} },
        arrayBuffer: async () => answer.body.buffer.slice(answer.body.byteOffset, answer.body.byteOffset + answer.body.length)
      };
      return consume(response as never);
    }
  };
});

const { mapsPlugin } = await import("../src/modules/maps/index.js");
const { rewriteStyle, proxyUrls, OPENFREEMAP_ATTRIBUTION } = await import("../src/modules/maps/provider.js");
const { saveMapSettings } = await import("../src/modules/maps/settings.js");

const TILEJSON = { tilejson: "3.0.0", tiles: [TEMPLATE], minzoom: 0, maxzoom: 14 };
const STYLE = {
  version: 8,
  sources: {
    ne2_shaded: { type: "raster", tiles: [`${UPSTREAM}/natural_earth/ne2sr/{z}/{x}/{y}.png`], maxzoom: 6 },
    openmaptiles: { type: "vector", url: `${UPSTREAM}/planet` }
  },
  glyphs: `${UPSTREAM}/fonts/{fontstack}/{range}.pbf`,
  sprite: `${UPSTREAM}/sprites/ofm_f384/ofm`,
  layers: [
    { id: "background", type: "background" },
    { id: "hillshade", type: "raster", source: "ne2_shaded" },
    { id: "water", type: "fill", source: "openmaptiles" }
  ]
};
const TILE = Buffer.from("a vector tile, honestly".repeat(20));

/** The default world: a TileJSON, a style, one real tile, one open-ocean tile. */
function standardUpstream(url: string): Stubbed | Error {
  if (url === `${UPSTREAM}/planet`) return { status: 200, body: Buffer.from(JSON.stringify(TILEJSON)) };
  if (url === `${UPSTREAM}/styles/liberty`) return { status: 200, body: Buffer.from(JSON.stringify(STYLE)) };
  if (url === TEMPLATE.replace("{z}", "14").replace("{x}", "9401").replace("{y}", "5288")) return { status: 200, body: TILE };
  if (url === TEMPLATE.replace("{z}", "3").replace("{x}", "1").replace("{y}", "1")) return { status: 200, body: Buffer.alloc(0) };
  return { status: 404, body: Buffer.alloc(0) };
}

// --- Harness -----------------------------------------------------------------

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;
let dataDir = "";

function shareLink(token: string, opts: { expired?: boolean; revoked?: boolean } = {}) {
  db.prepare(
    `INSERT INTO share_links (id, module, resource_id, token_hash, expires_at, created_by, revoked_at)
     VALUES (?, 'story', 'some-story', ?, ?, 'dad', ?)`
  ).run(`link-${token}`, sha256(token), opts.expired ? pastIso() : futureIso(), opts.revoked ? new Date().toISOString() : null);
}

const vectorFile = () => path.join(dataDir, "Tiles", "vector", "14", "9401", "5288.pbf.gz");

beforeEach(async () => {
  resetDb();
  makeUser("dad", "admin");
  makeUser("kid");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-maps-"));
  process.env.MAP_DATA_PATH = dataDir;
  upstream.calls = [];
  upstream.answer = standardUpstream;
  ({ app, signIn } = await bootApp({ plugins: [mapsPlugin] }));
});

afterEach(async () => {
  await app.close();
  delete process.env.MAP_DATA_PATH;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { "accept-encoding": "gzip", ...headers } });

// --- 1. Rewriting ------------------------------------------------------------

describe("rewriting a style", () => {
  const urls = proxyUrls("tok");

  /** Every URL MapLibre will FETCH from a style: source pointers, tile
   *  templates, glyphs, sprite. Attribution links are shown, never fetched. */
  function fetchedUrls(style: Record<string, unknown>): string[] {
    const found: string[] = [];
    for (const source of Object.values((style.sources ?? {}) as Record<string, { url?: string; tiles?: string[] }>)) {
      if (source.url) found.push(source.url);
      for (const tile of source.tiles ?? []) found.push(tile);
    }
    if (typeof style.glyphs === "string") found.push(style.glyphs);
    if (typeof style.sprite === "string") found.push(style.sprite);
    return found;
  }

  it("points everything MapLibre fetches at this server, root-relative, carrying the share link", () => {
    const { style, dropped } = rewriteStyle(STYLE, urls, TILEJSON);
    expect(dropped).toEqual([]);
    // The invariant: nothing fetched names a host at all — the browser supplies
    // its own origin, because this server cannot know it.
    expect(fetchedUrls(style)).not.toHaveLength(0);
    expect(fetchedUrls(style).every((url) => url.startsWith("/api/map/"))).toBe(true);
    expect(style.sources?.ne2_shaded.tiles).toEqual(["/api/map/raster/{z}/{x}/{y}.png?share=tok"]);
    expect(style.glyphs).toBe("/api/map/fonts/{fontstack}/{range}.pbf?share=tok");
    expect(style.sprite).toBe("/api/map/sprites/ofm_f384/ofm?share=tok");
  });

  it("inlines the tile set, so MapLibre never fetches a TileJSON", () => {
    const { style } = rewriteStyle(STYLE, urls, { ...TILEJSON, bounds: [-180, -85, 180, 85] });
    const vector = style.sources?.openmaptiles as Record<string, unknown>;
    expect(vector.url).toBeUndefined();
    expect(vector).toMatchObject({
      type: "vector",
      tiles: ["/api/map/tiles/{z}/{x}/{y}.pbf?share=tok"],
      minzoom: 0,
      maxzoom: 14,
      bounds: [-180, -85, 180, 85]
    });
  });

  it("credits the map in its own words, never with HTML taken from the provider", () => {
    // MapLibre writes a source's attribution into the page as HTML.
    const hostile = { ...TILEJSON, attribution: '<img src=x onerror="alert(1)">' };
    const { style } = rewriteStyle(STYLE, urls, hostile);
    expect((style.sources?.openmaptiles as Record<string, unknown>).attribution).toBe(OPENFREEMAP_ATTRIBUTION);
    expect(JSON.stringify(style)).not.toContain("onerror");
  });

  it("drops a source it does not recognise, and the layers drawn from it", () => {
    const withStranger = {
      ...STYLE,
      sources: { ...STYLE.sources, elsewhere: { type: "vector", url: "https://tracker.example/tiles" } },
      layers: [...STYLE.layers, { id: "spy", type: "fill", source: "elsewhere" }]
    };
    const { style, dropped } = rewriteStyle(withStranger, urls, TILEJSON);
    expect(dropped).toEqual(["elsewhere"]);
    expect(style.layers?.map((layer) => layer.id)).toEqual(["background", "hillshade", "water"]);
    expect(JSON.stringify(style)).not.toContain("tracker.example");
  });

  it("refuses a style whose fonts or icons live somewhere unexpected — no labels is not a map", () => {
    expect(() => rewriteStyle({ ...STYLE, glyphs: "https://fonts.example/{fontstack}/{range}.pbf" }, urls, TILEJSON)).toThrow();
    expect(() => rewriteStyle({ ...STYLE, sprite: "https://icons.example/sprite" }, urls, TILEJSON)).toThrow();
  });

  it("refuses a tile set on another host", () => {
    expect(() => rewriteStyle(STYLE, urls, { ...TILEJSON, tiles: ["https://evil.example/{z}/{x}/{y}.pbf"] })).toThrow();
    expect(() => rewriteStyle(STYLE, urls, {})).toThrow();
  });

  it("does not change the documents it was handed", () => {
    const before = JSON.stringify([STYLE, TILEJSON]);
    rewriteStyle(STYLE, urls, TILEJSON);
    expect(JSON.stringify([STYLE, TILEJSON])).toBe(before);
  });
});

// --- 2. Access ---------------------------------------------------------------

describe("who may use the map routes", () => {
  beforeEach(() => saveMapSettings({ cache: true }, "dad"));

  it("refuses a caller with neither a session nor a share link", async () => {
    expect((await get("/api/map/config")).statusCode).toBe(401);
    expect((await get("/api/map/tiles/14/9401/5288.pbf")).statusCode).toBe(401);
    expect(upstream.calls).toEqual([]);
  });

  it("lets a guest in with a live share link, and threads it through the config and the style", async () => {
    shareLink("guest-token");
    const res = await get("/api/map/config?share=guest-token");
    expect(res.statusCode).toBe(200);
    expect(res.json().styles.liberty).toBe("/api/map/styles/liberty?share=guest-token");
    const style = (await get(res.json().styles.liberty)).json();
    expect(style.sources.openmaptiles.tiles).toEqual(["/api/map/tiles/{z}/{x}/{y}.pbf?share=guest-token"]);
    expect((await get("/api/map/tiles/14/9401/5288.pbf?share=guest-token")).statusCode).toBe(200);
  });

  it("turns away an expired or revoked link, and one that never existed", async () => {
    shareLink("old", { expired: true });
    shareLink("pulled", { revoked: true });
    for (const token of ["old", "pulled", "made-up"]) {
      expect((await get(`/api/map/tiles/14/9401/5288.pbf?share=${token}`)).statusCode).toBe(404);
    }
    expect(upstream.calls).toEqual([]);
  });

  it("keeps the settings to admins", async () => {
    expect((await get("/api/map/settings", { cookie: await signIn("kid") })).statusCode).toBe(403);
    expect((await get("/api/map/settings", { cookie: await signIn("dad") })).statusCode).toBe(200);
  });
});

// --- 3. Validation -----------------------------------------------------------

describe("what counts as a map asset", () => {
  let cookie = "";
  beforeEach(async () => {
    saveMapSettings({ cache: true }, "dad");
    cookie = await signIn("kid");
  });

  it.each([
    ["a zoom past the vector maximum", "/api/map/tiles/15/0/0.pbf"],
    ["an x that does not exist at that zoom", "/api/map/tiles/14/99999/1.pbf"],
    ["a y that does not exist at that zoom", "/api/map/tiles/2/0/4.pbf"],
    ["a tile with the wrong extension", "/api/map/tiles/2/0/0.png"],
    ["a negative coordinate", "/api/map/tiles/2/-1/0.pbf"],
    ["a hillshade past its maximum", "/api/map/raster/7/0/0.png"],
    ["a glyph range off the 256 grid", "/api/map/fonts/Noto%20Sans%20Regular/1-256.pbf"],
    ["a fontstack reaching for a parent folder", "/api/map/fonts/..%2F..%2Fetc/0-255.pbf"]
  ])("refuses %s, without asking upstream", async (_what, url) => {
    expect((await get(url, { cookie })).statusCode).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it("does not know styles or sprite files it does not offer", async () => {
    expect((await get("/api/map/styles/../../etc", { cookie })).statusCode).toBe(404);
    expect((await get("/api/map/styles/satellite", { cookie })).statusCode).toBe(404);
    expect((await get("/api/map/sprites/ofm_f384/secrets.json", { cookie })).statusCode).toBe(404);
    expect(upstream.calls).toEqual([]);
  });
});

// --- 4. Caching --------------------------------------------------------------

describe("the tile cache", () => {
  let cookie = "";
  beforeEach(async () => {
    saveMapSettings({ cache: true }, "dad");
    cookie = await signIn("kid");
  });

  it("fetches a tile once, keeps it gzipped, and serves it from disk after that", async () => {
    const first = await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.headers["cache-control"]).toBe("private, max-age=86400");
    expect(gunzipSync(first.rawPayload).equals(TILE)).toBe(true);
    expect(upstream.calls).toEqual([`${UPSTREAM}/planet`, TEMPLATE.replace("{z}", "14").replace("{x}", "9401").replace("{y}", "5288")]);
    // Keyed on z/x/y, not on the weekly build in the upstream URL.
    expect(gunzipSync(fs.readFileSync(vectorFile())).equals(TILE)).toBe(true);

    upstream.calls = [];
    const second = await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    expect(second.statusCode).toBe(200);
    expect(upstream.calls).toEqual([]);
  });

  it("hands the plain bytes to a client that does not take gzip", async () => {
    const res = await app.inject({ method: "GET", url: "/api/map/tiles/14/9401/5288.pbf", headers: { cookie } });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.rawPayload.equals(TILE)).toBe(true);
  });

  it("keeps an open-ocean tile as the empty answer it is", async () => {
    const res = await get("/api/map/tiles/3/1/1.pbf", { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers["content-encoding"]).toBeUndefined();
    upstream.calls = [];
    await get("/api/map/tiles/3/1/1.pbf", { cookie });
    expect(upstream.calls).toEqual([]);
  });

  it("serves an expired tile when the internet is gone, and says it is stale", async () => {
    await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(vectorFile(), longAgo, longAgo);
    upstream.answer = () => new Error("offline");

    const res = await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-map-cache"]).toBe("stale");
    expect(gunzipSync(res.rawPayload).equals(TILE)).toBe(true);
  });

  it("says so plainly when there is nothing on disk and no internet", async () => {
    upstream.answer = () => new Error("offline");
    const res = await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    expect(res.statusCode).toBe(502);
  });

  it("passes a 404 on without keeping anything", async () => {
    // Not in the standard world, so upstream says 404 for the tile itself.
    const res = await get("/api/map/tiles/14/1/1.pbf", { cookie });
    expect(res.statusCode).toBe(404);
    expect(fs.existsSync(path.join(dataDir, "Tiles", "vector", "14", "1", "1.pbf.gz"))).toBe(false);
  });

  it("asks upstream once when several tabs want the same tile at the same moment", async () => {
    await get("/api/map/styles/liberty", { cookie }); // settles the TileJSON first
    upstream.calls = [];
    const results = await Promise.all([1, 2, 3, 4].map(() => get("/api/map/tiles/14/9401/5288.pbf", { cookie })));
    expect(results.every((res) => res.statusCode === 200)).toBe(true);
    expect(upstream.calls).toHaveLength(1);
  });

  it("serves a style that names no host, whatever Host header a proxy sent", async () => {
    // The bug this replaced: Vite's dev proxy (and many reverse proxies) rewrite
    // Host, and a style built from it pointed the browser at 127.0.0.1:4000.
    const res = await get("/api/map/styles/liberty", { cookie, host: "127.0.0.1:4000" });
    expect(res.statusCode).toBe(200);
    const style = res.json();
    expect(style.sources.openmaptiles.tiles).toEqual(["/api/map/tiles/{z}/{x}/{y}.pbf"]);
    expect(JSON.stringify(style)).not.toContain("127.0.0.1");
    // There is no public TileJSON route any more: the tile set is inside the style.
    expect((await get("/api/map/tilejson", { cookie })).statusCode).toBe(404);
  });
});

// --- 5. Off ------------------------------------------------------------------

describe("with caching off", () => {
  it("is off until someone turns it on, and sends the browser straight to the provider", async () => {
    const res = await get("/api/map/config", { cookie: await signIn("kid") });
    expect(res.json().mode).toBe("direct");
    expect(res.json().styles.dark).toBe(`${UPSTREAM}/styles/dark`);
  });

  it("refuses to proxy, so nothing lands on disk", async () => {
    const res = await get("/api/map/tiles/14/9401/5288.pbf", { cookie: await signIn("kid") });
    expect(res.statusCode).toBe(404);
    expect(upstream.calls).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "Tiles"))).toBe(false);
  });

  it("deletes what was kept when an admin turns it off, and says how much that freed", async () => {
    const cookie = await signIn("dad");
    const on = await app.inject({ method: "PUT", url: "/api/map/settings", headers: { cookie }, payload: { cache: true } });
    expect(on.json().settings.cache).toBe(true);
    await get("/api/map/tiles/14/9401/5288.pbf", { cookie });
    expect(fs.existsSync(vectorFile())).toBe(true);

    const off = await app.inject({ method: "PUT", url: "/api/map/settings", headers: { cookie }, payload: { cache: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dataDir, "Tiles"))).toBe(false);

    const events = db.prepare("SELECT detail FROM activity_logs WHERE event = 'maps.settings_updated' ORDER BY created_at").all() as { detail: string }[];
    expect(events.map((event) => event.detail)).toEqual([
      "Map caching turned on",
      expect.stringMatching(/^Map caching turned off \(\d+ bytes freed\)$/)
    ]);
  });

  it("keeps the limit the owner chose, offers only the listed ones, and says what the limit is", async () => {
    const cookie = await signIn("dad");
    expect((await get("/api/map/settings", { cookie })).json().cache.limitBytes).toBe(200 * 1024 * 1024);

    const set = await app.inject({ method: "PUT", url: "/api/map/settings", headers: { cookie }, payload: { cacheLimitMb: 1000 } });
    expect(set.statusCode).toBe(200);
    // Only the limit changed: the cache stays as it was.
    expect(set.json().settings).toEqual({ cache: false, cacheLimitMb: 1000 });
    expect((await get("/api/map/settings", { cookie })).json().cache.limitBytes).toBe(1000 * 1024 * 1024);

    for (const payload of [{ cacheLimitMb: 750 }, { cacheLimitMb: 20000 }, {}]) {
      expect((await app.inject({ method: "PUT", url: "/api/map/settings", headers: { cookie }, payload })).statusCode).toBe(400);
    }
    const kid = await signIn("kid");
    expect((await app.inject({ method: "PUT", url: "/api/map/settings", headers: { cookie: kid }, payload: { cacheLimitMb: 100 } })).statusCode).toBe(403);
  });
});
