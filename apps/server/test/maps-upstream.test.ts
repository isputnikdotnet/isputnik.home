// How the map cache asks its upstream, when a map asks for a lot at once.
//
// On an Unraid box, zooming a map froze the whole server: every uncached tile was
// its own upstream request, all at once, with nothing to stop a hundred of them
// or to give up on an upstream that was not answering. What must hold now:
//
//  1. Upstream is asked a few at a time, however many tiles the browser wants.
//  2. A tile the browser stopped wanting (MapLibre cancels on zoom) leaves the
//     queue before upstream is asked — unless another request still wants it.
//  3. An upstream failing again and again is left alone for a while: kept copies
//     are served stale, and the rest fails at once rather than queueing.
//  4. A network failure is tried once more; an answer (404, 500) is not.
//
// The upstream is stubbed at fetchSafely with requests the test answers by hand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers/seed.js";

interface Pending {
  url: string;
  answer: (status: number, body?: Buffer) => void;
  fail: (err: Error) => void;
}

const upstream = { pending: [] as Pending[], calls: 0 };

vi.mock("../src/core/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/safe-fetch.js")>();
  return {
    ...actual,
    fetchSafely: <T>(url: string, _opts: unknown, consume: (response: never) => Promise<T>): Promise<T> => {
      upstream.calls += 1;
      return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        upstream.pending.push({
          url,
          answer: (status, body = Buffer.from("tile")) => resolve({ status, body }),
          fail: reject
        });
      }).then(({ status, body }) =>
        consume({
          status,
          ok: status >= 200 && status < 300,
          headers: new Headers({ "content-length": String(body.length) }),
          body: { cancel: async () => {} },
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
        } as never)
      );
    }
  };
});

vi.mock("../src/modules/maps/settings.js", () => ({
  getMapSettings: () => ({ cache: true, cacheLimitMb: 200, villageCountries: [] })
}));

const { MapRequestAbandoned, MapServiceUnavailable, mapServiceHealth, resetUpstreamState, resolveAsset } = await import("../src/modules/maps/resolve.js");
const { assetPath } = await import("../src/modules/maps/storage.js");

/** A hillshade tile: needs no TileJSON first, so one tile is one upstream call. */
const tile = (x: number, y = 0) => ({ kind: "raster" as const, z: 6, x, y });

/** Let queued promise work run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Six tiles holding every upstream slot, so what is asked next has to queue. */
async function fillSlots() {
  for (let i = 0; i < 6; i += 1) void resolveAsset(tile(i), new AbortController().signal);
  await settle();
  expect(upstream.pending).toHaveLength(6);
}

let dataDir = "";

beforeEach(() => {
  resetDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-map-upstream-"));
  process.env.MAP_DATA_PATH = dataDir;
  upstream.pending = [];
  upstream.calls = 0;
  resetUpstreamState();
});

afterEach(async () => {
  // Nothing left hanging into the next test.
  for (const request of upstream.pending.splice(0)) request.answer(200);
  await settle();
  delete process.env.MAP_DATA_PATH;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("asking upstream", () => {
  it("does not hand a new request a fetch that everyone before it abandoned", async () => {
    await fillSlots();
    const first = new AbortController();
    const gone = resolveAsset(tile(100), first.signal);
    gone.catch(() => {});
    await settle();
    first.abort();
    // Asked again straight away, before the abandoned fetch has finished failing.
    const again = resolveAsset(tile(100), new AbortController().signal);
    await expect(gone).rejects.toBeInstanceOf(MapRequestAbandoned);
    await settle();

    for (const request of upstream.pending.splice(0)) request.answer(200);
    await settle();
    upstream.pending.shift()!.answer(200);
    await expect(again).resolves.toMatchObject({ stale: false });
  });

  it("asks at most six at a time, however many tiles are wanted", async () => {
    const wanted = Array.from({ length: 20 }, (_, i) => resolveAsset(tile(i), new AbortController().signal));
    await settle();
    expect(upstream.pending).toHaveLength(6);

    // Each answer lets exactly one more through.
    upstream.pending.shift()!.answer(200);
    await settle();
    expect(upstream.calls).toBe(7);
    expect(upstream.pending).toHaveLength(6);

    while (upstream.calls < 20 || upstream.pending.length > 0) {
      for (const request of upstream.pending.splice(0)) request.answer(200);
      await settle();
    }
    const results = await Promise.all(wanted);
    expect(results.every((result) => result.body.toString() === "tile")).toBe(true);
    expect(upstream.calls).toBe(20);
  });

  it("drops a tile from the queue when the browser stops wanting it", async () => {
    await fillSlots();
    const cancelled = new AbortController();
    const dropped = resolveAsset(tile(100), cancelled.signal);
    const kept = resolveAsset(tile(101), new AbortController().signal);
    await settle();

    cancelled.abort();
    await expect(dropped).rejects.toBeInstanceOf(MapRequestAbandoned);

    for (const request of upstream.pending.splice(0)) request.answer(200);
    await settle();
    // Tile 101 went up; tile 100 never did.
    expect(upstream.pending.map((request) => request.url)).toEqual([expect.stringContaining("/6/101/0.png")]);
    upstream.pending.shift()!.answer(200);
    await expect(kept).resolves.toMatchObject({ stale: false });
    expect(upstream.calls).toBe(7);
  });

  it("keeps a queued tile that another request still wants", async () => {
    await fillSlots();
    const first = new AbortController();
    const gone = resolveAsset(tile(100), first.signal);
    const stillWanted = resolveAsset(tile(100), new AbortController().signal);
    gone.catch(() => {});
    await settle();
    first.abort();
    await expect(gone).rejects.toBeInstanceOf(MapRequestAbandoned);

    for (const request of upstream.pending.splice(0)) request.answer(200);
    await settle();
    expect(upstream.pending.map((request) => request.url)).toEqual([expect.stringContaining("/6/100/0.png")]);
    upstream.pending.shift()!.answer(200);
    await expect(stillWanted).resolves.toMatchObject({ stale: false });
    expect(fs.existsSync(assetPath(tile(100))!)).toBe(true);
  });

  it("tries a network failure once more, but takes an upstream answer as it is", async () => {
    const retried = resolveAsset(tile(1), new AbortController().signal);
    await settle();
    upstream.pending.shift()!.fail(new Error("other side closed"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstream.pending).toHaveLength(1);
    upstream.pending.shift()!.answer(200);
    await expect(retried).resolves.toMatchObject({ stale: false });

    const answered = resolveAsset(tile(2), new AbortController().signal);
    await settle();
    upstream.pending.shift()!.answer(500);
    await expect(answered).rejects.toThrow("answered 500");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstream.calls).toBe(3);
  });
});

describe("an upstream that keeps failing", () => {
  it("is left alone after five failures in a row: kept copies go stale, the rest fails at once", async () => {
    // A tile kept long ago, and so due a refetch.
    const kept = assetPath(tile(50))!;
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, Buffer.from("old tile"));
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(kept, longAgo, longAgo);

    const failing = Array.from({ length: 5 }, (_, i) => resolveAsset(tile(i), new AbortController().signal));
    for (const outcome of failing) outcome.catch(() => {});
    for (let round = 0; round < 2; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, round === 0 ? 5 : 300));
      for (const request of upstream.pending.splice(0)) request.fail(new Error("connect ENETUNREACH 2606:4700:20::681a:717:443"));
    }
    for (const outcome of failing) await expect(outcome).rejects.toThrow("ENETUNREACH");
    const callsWhenOpened = upstream.calls;
    expect(callsWhenOpened).toBe(10);

    await expect(resolveAsset(tile(9), new AbortController().signal)).rejects.toBeInstanceOf(MapServiceUnavailable);
    const stale = await resolveAsset(tile(50), new AbortController().signal);
    expect(stale).toEqual({ body: Buffer.from("old tile"), stale: true });
    expect(upstream.calls).toBe(callsWhenOpened);
  });

  it("does not count a 404 as the upstream failing", async () => {
    for (let i = 0; i < 6; i += 1) {
      const missing = resolveAsset(tile(i), new AbortController().signal);
      await settle();
      upstream.pending.shift()!.answer(404);
      await expect(missing).rejects.toThrow("Not found upstream.");
    }
    const next = resolveAsset(tile(99), new AbortController().signal);
    await settle();
    expect(upstream.pending).toHaveLength(1);
    upstream.pending.shift()!.answer(200);
    await expect(next).resolves.toMatchObject({ stale: false });
  });
});

describe("how the service has been behaving", () => {
  it("says nothing until the server has had to ask it for something", () => {
    expect(mapServiceHealth()).toEqual({
      reachable: null, lastSuccessAt: null, lastFailureAt: null, lastFailure: null, pausedUntil: null
    });
  });

  it("remembers the last answer and the last failure, and says when it is pausing", async () => {
    const answered = resolveAsset(tile(1), new AbortController().signal);
    await settle();
    upstream.pending.shift()!.answer(200);
    await answered;
    const afterSuccess = mapServiceHealth();
    expect(afterSuccess.reachable).toBe(true);
    expect(afterSuccess.lastSuccessAt).toMatch(/^\d{4}-/);
    expect(afterSuccess.lastFailure).toBeNull();

    const failing = Array.from({ length: 5 }, (_, i) => resolveAsset(tile(10 + i), new AbortController().signal));
    for (const outcome of failing) outcome.catch(() => {});
    for (let round = 0; round < 2; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, round === 0 ? 5 : 300));
      for (const request of upstream.pending.splice(0)) request.fail(new Error("connect ENETUNREACH"));
    }
    for (const outcome of failing) await expect(outcome).rejects.toThrow();

    const afterFailures = mapServiceHealth();
    expect(afterFailures.reachable).toBe(false);
    expect(afterFailures.lastFailure).toContain("ENETUNREACH");
    // The breaker is open, so the page can say when it will be tried again.
    expect(Date.parse(afterFailures.pausedUntil!)).toBeGreaterThan(Date.now());
    expect(afterFailures.lastSuccessAt).toBe(afterSuccess.lastSuccessAt);
  });
});
