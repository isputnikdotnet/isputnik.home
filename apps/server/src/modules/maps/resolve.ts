// The cache policy: when a map asset is served from disk, when it is fetched,
// and what happens when the internet is not there.
//
// Offline is the point, so a failed fetch never costs a map that is on disk: an
// expired asset is refetched when possible and served STALE when not. The only
// thing that fails is an asset this server has never had.
//
// And a map is only a map: however hard someone zooms, what it fetches must never
// take the rest of the server with it. On Unraid it did — a zoom asked for a
// hundred uncached tiles at once, each its own DNS lookup, TCP connect and TLS
// handshake, and the lookups filled the threadpool every file read in the server
// waits on. So upstream is asked a few at a time over kept-alive connections
// (UPSTREAM_SLOTS, one SafeFetchSession), a tile nobody is waiting for any more
// leaves the queue, and an upstream that keeps failing is left alone for a while
// (the breaker) instead of being asked again for every tile on the screen.
//
// Provider-independent. `provider.ts` says where things live; this says how long
// to keep them and would read the same for any provider.
import { gunzipSync, gzipSync } from "node:zlib";
import { SafeFetchSession, fetchSafely } from "../../core/safe-fetch.js";
import { upstreamUrl, vectorTemplateOf, type MapAsset } from "./provider.js";
import { isStoredGzipped, readCached, writeCached } from "./storage.js";
import { sweepSoon } from "./sweep.js";

const DAY = 24 * 60 * 60 * 1000;

/** How old a copy may get before it is refetched. Tiles change slowly and the
 *  family looks at the same places; styles and the TileJSON are small and are
 *  what carry a provider's changes, so they are checked daily. */
const MAX_AGE: Record<MapAsset["kind"], number> = {
  style: DAY,
  tilejson: DAY,
  vector: 30 * DAY,
  raster: 365 * DAY,
  font: 365 * DAY,
  sprite: 365 * DAY
};

/** Far above anything real — the largest asset is a ~190 KB hillshade PNG — and
 *  a hard stop on an upstream that answers with something that is not a map. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** A tile that has not arrived in this long is not arriving: the map shows a gap
 *  and asks again when it next draws. Counted from the request leaving, not from
 *  joining the queue. */
const FETCH_TIMEOUT_MS = 6_000;

/** Upstream requests running at once, whatever the browser asks for. The same
 *  number of kept-alive connections, so a slot always has one. */
const UPSTREAM_SLOTS = 6;

/** Failures in a row, not counting a 404, that open the breaker; how long it
 *  stays open. While open, nothing is asked upstream: what is on disk is served,
 *  stale if need be, and everything else fails at once. */
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;

/** A network failure is tried once more after this long — a kept-alive socket the
 *  far end has just closed fails the first request sent on it. */
const RETRY_DELAY_MS = 250;

export class MapAssetNotFound extends Error {}

/** Upstream is being left alone after failing repeatedly. */
export class MapServiceUnavailable extends Error {}

/** The request that wanted this went away before upstream was asked. */
export class MapRequestAbandoned extends Error {}

export interface ResolvedAsset {
  /** As stored: gzipped when isStoredGzipped(asset). An empty body is a real
   *  answer — upstream sends one for open ocean — and is stored as empty. */
  body: Buffer;
  /** Served from an expired copy because the upstream could not be reached. */
  stale: boolean;
}

// --- Upstream: slots, breaker, connections ---------------------------------------

const session = new SafeFetchSession({ connections: UPSTREAM_SLOTS, addressTtlMs: 5 * 60 * 1000 });

let running = 0;
const waiting: { start: () => void; signal: AbortSignal; onAbort: () => void }[] = [];

function releaseSlot(): void {
  running -= 1;
  const next = waiting.shift();
  if (next) {
    next.signal.removeEventListener("abort", next.onAbort);
    running += 1;
    next.start();
  }
}

/** Wait for a slot; rejects when `signal` aborts first. Newest first would suit a
 *  map better (what is on screen now), but abandoned requests leave the queue, so
 *  what remains in it is what is still wanted. */
function acquireSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new MapRequestAbandoned());
  if (running < UPSTREAM_SLOTS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = {
      start: resolve,
      signal,
      onAbort: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new MapRequestAbandoned());
      }
    };
    signal.addEventListener("abort", entry.onAbort, { once: true });
    waiting.push(entry);
  });
}

const breaker = { failures: 0, openUntil: 0 };

function breakerOpen(): boolean {
  return Date.now() < breaker.openUntil;
}

/** How the map service has been behaving, for the Maps page. Kept here because
 *  this is where every upstream request ends, and held in memory only: it
 *  describes this run of the server, not something worth a table. */
const health = {
  lastSuccessAt: null as number | null,
  lastFailureAt: null as number | null,
  lastFailure: null as string | null
};

export interface MapServiceHealth {
  /** True since the last answer, false since the last failure, null if this
   *  server has not needed the map service yet (everything came from disk). */
  reachable: boolean | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Why the last failure failed, in the words the fetch used. */
  lastFailure: string | null;
  /** While the breaker is open: when it next tries the service again. */
  pausedUntil: string | null;
}

export function mapServiceHealth(): MapServiceHealth {
  const reachable = health.lastSuccessAt === null && health.lastFailureAt === null
    ? null
    : (health.lastSuccessAt ?? 0) >= (health.lastFailureAt ?? 0);
  return {
    reachable,
    lastSuccessAt: health.lastSuccessAt === null ? null : new Date(health.lastSuccessAt).toISOString(),
    lastFailureAt: health.lastFailureAt === null ? null : new Date(health.lastFailureAt).toISOString(),
    lastFailure: health.lastFailure,
    pausedUntil: breakerOpen() ? new Date(breaker.openUntil).toISOString() : null
  };
}

function recordOutcome(err: unknown): void {
  if (err === undefined || err instanceof MapAssetNotFound) {
    // A 404 is the service answering, so it counts as reached.
    health.lastSuccessAt = Date.now();
    breaker.failures = 0;
    return;
  }
  health.lastFailureAt = Date.now();
  health.lastFailure = err instanceof Error ? err.message : String(err);
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    breaker.failures = 0;
  }
}

/** An answer from upstream, as opposed to not reaching it. Only these are not tried again. */
class UpstreamAnswered extends Error {}

async function fetchUpstreamOnce(url: string): Promise<Buffer> {
  return fetchSafely(
    url,
    { timeoutMs: FETCH_TIMEOUT_MS, failureMessage: "The map service could not be reached.", session },
    async (response) => {
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        throw new MapAssetNotFound("Not found upstream.");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new UpstreamAnswered(`The map service answered ${response.status}.`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_ASSET_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new UpstreamAnswered("The map service sent something far too large to be a map.");
      }
      // undici's fetch has already undone any Content-Encoding, so these are
      // the real bytes whatever the upstream sent them as.
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ASSET_BYTES) {
        throw new UpstreamAnswered("The map service sent something far too large to be a map.");
      }
      return bytes;
    }
  );
}

/** One upstream request, in a slot, through the breaker. */
async function fetchUpstream(url: string, signal: AbortSignal): Promise<Buffer> {
  if (breakerOpen()) throw new MapServiceUnavailable("The map service is not answering; trying again shortly.");
  await acquireSlot(signal);
  try {
    // Checked again: it may have opened while this waited.
    if (breakerOpen()) throw new MapServiceUnavailable("The map service is not answering; trying again shortly.");
    let bytes: Buffer;
    try {
      bytes = await fetchUpstreamOnce(url);
    } catch (err) {
      if (err instanceof MapAssetNotFound || err instanceof UpstreamAnswered) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      bytes = await fetchUpstreamOnce(url);
    }
    recordOutcome(undefined);
    return bytes;
  } catch (err) {
    if (!(err instanceof MapServiceUnavailable)) recordOutcome(err);
    throw err;
  } finally {
    releaseSlot();
  }
}

// --- Stored form -------------------------------------------------------------------

/** Store in the asset's on-disk form. */
function toStored(asset: MapAsset, raw: Buffer): Buffer {
  return isStoredGzipped(asset) && raw.length > 0 ? gzipSync(raw, { level: 6 }) : raw;
}

/** The raw bytes of a stored body, for the JSON this server has to read. */
export function fromStored(asset: MapAsset, stored: Buffer): Buffer {
  return isStoredGzipped(asset) && stored.length > 0 ? gunzipSync(stored) : stored;
}

// --- One fetch per asset -------------------------------------------------------------

// One upstream fetch per asset at a time. A map opening in two tabs asks for the
// same tiles at once; without this both fetch, and both write the same file. The
// fetch is abandoned — while it still waits for a slot — only when every request
// that wanted it has gone.
interface Flight {
  promise: Promise<Buffer>;
  waiters: number;
  controller: AbortController;
}
const inFlight = new Map<string, Flight>();

function flightKey(asset: MapAsset): string {
  return JSON.stringify(asset);
}

function fetchAndStore(asset: MapAsset, signal?: AbortSignal): Promise<Buffer> {
  const key = flightKey(asset);
  let flight = inFlight.get(key);
  // Abandoned by everyone who wanted it: it is on its way to failing, so whoever
  // asks now starts a fetch of their own.
  if (flight?.controller.signal.aborted) flight = undefined;
  if (!flight) {
    const controller = new AbortController();
    const promise = (async () => {
      let template: string | undefined;
      if (asset.kind === "vector") {
        const tilejson = await resolveAsset({ kind: "tilejson" }, controller.signal);
        template = vectorTemplateOf(JSON.parse(fromStored({ kind: "tilejson" }, tilejson.body).toString("utf8"))) ?? undefined;
        if (!template) throw new Error("The map's tile set is not in a shape this version understands.");
      }
      const raw = await fetchUpstream(upstreamUrl(asset, template), controller.signal);
      const stored = toStored(asset, raw);
      // The cache only grows here, so this is the only place it needs checking.
      if (await writeCached(asset, stored)) sweepSoon();
      return stored;
    })();
    const created: Flight = { promise, waiters: 0, controller };
    flight = created;
    inFlight.set(key, created);
    const forget = () => {
      if (inFlight.get(key) === created) inFlight.delete(key);
    };
    void promise.then(forget, forget);
  }

  const joined = flight;
  if (!signal) {
    // Someone who cannot go away (a style being built): never abandoned.
    joined.waiters = Number.POSITIVE_INFINITY;
    return joined.promise;
  }
  joined.waiters += 1;
  return new Promise<Buffer>((resolve, reject) => {
    // Whoever leaves hears so at once, whether or not the fetch goes on for others.
    const leave = () => {
      joined.waiters -= 1;
      if (joined.waiters <= 0) joined.controller.abort();
      reject(new MapRequestAbandoned());
    };
    if (signal.aborted) return leave();
    signal.addEventListener("abort", leave, { once: true });
    void joined.promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", leave));
  });
}

/**
 * The asset, from disk when fresh, from upstream when not, and from an expired
 * copy when upstream is unreachable. Throws MapAssetNotFound when upstream says
 * there is no such thing and nothing is on disk; throws the fetch error when
 * upstream cannot be reached and nothing is on disk.
 *
 * `signal` is the request that wants it: when it aborts (the browser cancelled the
 * tile) before upstream is asked, the fetch is dropped from the queue.
 */
export async function resolveAsset(asset: MapAsset, signal?: AbortSignal): Promise<ResolvedAsset> {
  const cached = await readCached(asset);
  if (cached && cached.ageMs < MAX_AGE[asset.kind]) {
    return { body: cached.body, stale: false };
  }
  try {
    return { body: await fetchAndStore(asset, signal), stale: false };
  } catch (err) {
    // A 404 is an answer, not an outage: an asset upstream no longer has must
    // not be kept alive by an old copy.
    if (cached && !(err instanceof MapAssetNotFound)) return { body: cached.body, stale: true };
    throw err;
  }
}

/** For tests: close the breaker and forget how the service has been behaving. */
export function resetUpstreamState(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
  health.lastSuccessAt = null;
  health.lastFailureAt = null;
  health.lastFailure = null;
}

/** Close kept-alive upstream connections (server shutdown). */
export function closeUpstream(): Promise<void> {
  return session.close();
}
