// The cache policy: when a map asset is served from disk, when it is fetched,
// and what happens when the internet is not there.
//
// Offline is the point, so a failed fetch never costs a map that is on disk: an
// expired asset is refetched when possible and served STALE when not. The only
// thing that fails is an asset this server has never had.
//
// Provider-independent. `provider.ts` says where things live; this says how long
// to keep them and would read the same for any provider.
import { gunzipSync, gzipSync } from "node:zlib";
import { fetchSafely } from "../../core/safe-fetch.js";
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

const FETCH_TIMEOUT_MS = 10_000;

export class MapAssetNotFound extends Error {}

export interface ResolvedAsset {
  /** As stored: gzipped when isStoredGzipped(asset). An empty body is a real
   *  answer — upstream sends one for open ocean — and is stored as empty. */
  body: Buffer;
  /** Served from an expired copy because the upstream could not be reached. */
  stale: boolean;
}

// One upstream fetch per asset at a time. A map opening in two tabs asks for the
// same tiles at once; without this both fetch, and both write the same file.
const inFlight = new Map<string, Promise<Buffer>>();

function flightKey(asset: MapAsset): string {
  return JSON.stringify(asset);
}

async function fetchUpstream(url: string): Promise<Buffer> {
  return fetchSafely(
    url,
    { timeoutMs: FETCH_TIMEOUT_MS, failureMessage: "The map service could not be reached." },
    async (response) => {
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        throw new MapAssetNotFound("Not found upstream.");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`The map service answered ${response.status}.`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_ASSET_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error("The map service sent something far too large to be a map.");
      }
      // undici's fetch has already undone any Content-Encoding, so these are
      // the real bytes whatever the upstream sent them as.
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ASSET_BYTES) {
        throw new Error("The map service sent something far too large to be a map.");
      }
      return bytes;
    }
  );
}

/** Store in the asset's on-disk form. */
function toStored(asset: MapAsset, raw: Buffer): Buffer {
  return isStoredGzipped(asset) && raw.length > 0 ? gzipSync(raw, { level: 6 }) : raw;
}

/** The raw bytes of a stored body, for the JSON this server has to read. */
export function fromStored(asset: MapAsset, stored: Buffer): Buffer {
  return isStoredGzipped(asset) && stored.length > 0 ? gunzipSync(stored) : stored;
}

async function fetchAndStore(asset: MapAsset): Promise<Buffer> {
  const key = flightKey(asset);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    let template: string | undefined;
    if (asset.kind === "vector") {
      const tilejson = await resolveAsset({ kind: "tilejson" });
      template = vectorTemplateOf(JSON.parse(fromStored({ kind: "tilejson" }, tilejson.body).toString("utf8"))) ?? undefined;
      if (!template) throw new Error("The map's tile set is not in a shape this version understands.");
    }
    const raw = await fetchUpstream(upstreamUrl(asset, template));
    const stored = toStored(asset, raw);
    writeCached(asset, stored);
    // The cache only grows here, so this is the only place it needs checking.
    sweepSoon();
    return stored;
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * The asset, from disk when fresh, from upstream when not, and from an expired
 * copy when upstream is unreachable. Throws MapAssetNotFound when upstream says
 * there is no such thing and nothing is on disk; throws the fetch error when
 * upstream cannot be reached and nothing is on disk.
 */
export async function resolveAsset(asset: MapAsset): Promise<ResolvedAsset> {
  const cached = readCached(asset);
  if (cached && cached.ageMs < MAX_AGE[asset.kind]) {
    return { body: cached.body, stale: false };
  }
  try {
    return { body: await fetchAndStore(asset), stale: false };
  } catch (err) {
    // A 404 is an answer, not an outage: an asset upstream no longer has must
    // not be kept alive by an old copy.
    if (cached && !(err instanceof MapAssetNotFound)) return { body: cached.body, stale: true };
    throw err;
  }
}
