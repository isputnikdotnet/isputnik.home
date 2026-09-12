import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { geoipStatus } from "../../core/geoip.js";
import { resolveShareLink } from "../library/shared/share-access.js";
import {
  MAP_STYLES,
  OPENFREEMAP_ATTRIBUTION,
  RASTER_MAX_ZOOM,
  SPRITE_FILES,
  VECTOR_MAX_ZOOM,
  proxyUrls,
  rewriteStyle,
  upstreamBase,
  type MapAsset,
  type MapStyleName,
  type SpriteFile
} from "./provider.js";
import { MapAssetNotFound, fromStored, resolveAsset } from "./resolve.js";
import { getMapSettings, saveMapSettings } from "./settings.js";
import { clearTileCache, folderBytes, isStoredGzipped, mapDataDir, tileCacheDir } from "./storage.js";

// Map routes. Two audiences, one rule each:
//
//  - /api/map/config and the asset routes are for anyone allowed to SEE a map:
//    a signed-in member, or a guest holding a live share link — a shared story
//    draws maps too, and its guest has no session. Nobody else. Unauthenticated,
//    an internet-facing install would be an open map proxy filling its own disk.
//  - /api/map/settings is the admin's.
//
// A map opening fires a hundred-odd requests, and panning fires more, all of
// which used to go to the provider and none of which touched this server. They
// get a ceiling of their own rather than eating the global one.
const MAP_ASSET_LIMIT = { config: { rateLimit: { max: 3000, timeWindow: "1 minute" } } };

/** Assets carry the share link that lets a guest in; see proxyUrls(). */
function shareParam(request: FastifyRequest): string | undefined {
  const share = (request.query as Record<string, unknown> | undefined)?.share;
  return typeof share === "string" && share.length > 0 ? share : undefined;
}

function mapAccess(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const share = shareParam(request);
    if (share !== undefined) {
      // resolveShareLink flags a token that never existed, so guessing costs the
      // guesser — the same protection every other share route gets.
      if (share.length > 200 || !resolveShareLink(share, request)) {
        return reply.code(404).send({ error: "Share not found or expired" });
      }
      return;
    }
    return app.authenticate(request, reply);
  };
}

function cachingOff(reply: FastifyReply) {
  return reply.code(404).send({ error: "Map caching is not turned on." });
}

// --- Validation ------------------------------------------------------------
//
// Upstream answers 200 for coordinates that cannot exist (x=99999 at z14), so
// these checks are the only thing between a scripted client and a cache full of
// junk keys. Every accepted value is also safe as a path segment on disk.

function tileCoordinates(zRaw: string, xRaw: string, file: string, ext: "pbf" | "png", maxZoom: number) {
  const match = new RegExp(`^(\\d{1,7})\\.${ext}$`).exec(file);
  if (!/^\d{1,2}$/.test(zRaw) || !/^\d{1,7}$/.test(xRaw) || !match) return null;
  const z = Number(zRaw);
  const x = Number(xRaw);
  const y = Number(match[1]);
  if (z > maxZoom) return null;
  const span = 2 ** z;
  return x < span && y < span ? { z, x, y } : null;
}

/** "Noto Sans Regular" — MapLibre sends a stack as comma-joined names. No dots
 *  or slashes, so it can never be more than one path segment. */
const FONTSTACK = /^[A-Za-z0-9 ,_-]{1,100}$/;

function glyphRange(file: string): string | null {
  const match = /^(\d{1,5})-(\d{1,5})\.pbf$/.exec(file);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  // Glyph ranges come in fixed blocks of 256; anything else is not a request
  // MapLibre makes.
  return start % 256 === 0 && end === start + 255 && end <= 65535 ? `${start}-${end}` : null;
}

// --- Sending ----------------------------------------------------------------

const CONTENT_TYPES: Record<MapAsset["kind"], string> = {
  style: "application/json",
  tilejson: "application/json",
  vector: "application/vnd.mapbox-vector-tile",
  raster: "image/png",
  font: "application/x-protobuf",
  sprite: "application/json"
};

function contentTypeOf(asset: MapAsset): string {
  if (asset.kind === "sprite") return asset.file.endsWith(".png") ? "image/png" : "application/json";
  return CONTENT_TYPES[asset.kind];
}

function acceptsGzip(request: FastifyRequest): boolean {
  const accept = String(request.headers["accept-encoding"] ?? "").toLowerCase();
  return accept.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return (name.trim() === "gzip" || name.trim() === "*") && (q ? Number(q.slice(2)) > 0 : true);
  });
}

async function serveAsset(request: FastifyRequest, reply: FastifyReply, asset: MapAsset) {
  if (!getMapSettings().cache) return cachingOff(reply);
  let resolved;
  try {
    resolved = await resolveAsset(asset);
  } catch (err) {
    if (err instanceof MapAssetNotFound) return reply.code(404).send({ error: "No such map asset." });
    request.log.warn({ err, asset }, "map asset unavailable");
    return reply.code(502).send({ error: "The map service could not be reached." });
  }

  // `private`: every one of these is behind a session or a share link, so no
  // shared cache may keep one. A day in the browser keeps panning cheap.
  reply.header("cache-control", "private, max-age=86400");
  reply.header("vary", "accept-encoding");
  if (resolved.stale) reply.header("x-map-cache", "stale");
  reply.type(contentTypeOf(asset));

  const body = resolved.body;
  // Open ocean is an empty tile; an empty body carries no encoding.
  if (body.length === 0 || !isStoredGzipped(asset)) return reply.send(body);
  // Stored gzipped. Setting the header ourselves is what keeps the compression
  // hook from compressing it a second time (it passes anything already encoded).
  if (acceptsGzip(request)) {
    reply.header("content-encoding", "gzip");
    return reply.send(body);
  }
  return reply.send(gunzipSync(body));
}

/** A JSON asset, parsed from its stored form. */
async function readJson(asset: MapAsset & { kind: "style" | "tilejson" }): Promise<{ doc: Record<string, unknown>; stale: boolean }> {
  const resolved = await resolveAsset(asset);
  return { doc: JSON.parse(fromStored(asset, resolved.body).toString("utf8")) as Record<string, unknown>, stale: resolved.stale };
}

async function serveStyle(request: FastifyRequest, reply: FastifyReply, style: MapStyleName) {
  if (!getMapSettings().cache) return cachingOff(reply);
  let upstreamStyle: Record<string, unknown>;
  let tilejson: Record<string, unknown>;
  try {
    // The style names a TileJSON for its tiles; both are needed to inline them.
    const [styleDoc, tilejsonDoc] = await Promise.all([readJson({ kind: "style", style }), readJson({ kind: "tilejson" })]);
    if (styleDoc.stale || tilejsonDoc.stale) reply.header("x-map-cache", "stale");
    upstreamStyle = styleDoc.doc;
    tilejson = tilejsonDoc.doc;
  } catch (err) {
    if (err instanceof MapAssetNotFound) return reply.code(404).send({ error: "No such map style." });
    request.log.warn({ err, style }, "map style unavailable");
    return reply.code(502).send({ error: "The map service could not be reached." });
  }
  try {
    // Rewritten per request, never cached rewritten: the share link belongs to
    // the request, not to the document.
    const { style: rewritten, dropped } = rewriteStyle(upstreamStyle, proxyUrls(shareParam(request)), tilejson);
    if (dropped.length > 0) request.log.warn({ style, dropped }, "map style sources dropped");
    reply.header("cache-control", "private, max-age=300");
    return reply.send(rewritten);
  } catch (err) {
    request.log.error({ err, style }, "map style in an unrecognised shape");
    return reply.code(502).send({ error: err instanceof Error ? err.message : "The map could not be prepared." });
  }
}

// --- Routes ------------------------------------------------------------------

const settingsBody = z.object({ cache: z.boolean() });

export function registerMapRoutes(app: FastifyInstance) {
  const access = { preHandler: mapAccess(app), ...MAP_ASSET_LIMIT };

  // What the web should draw with. Off, the styles are the provider's own and
  // the browser goes straight there, exactly as maps have always worked here.
  // Proxied, they are root-relative, and so is every URL inside them: the web
  // makes them absolute with location.origin (see proxyUrls for why the server
  // must not try).
  app.get("/api/map/config", access, async (request) => {
    const proxied = getMapSettings().cache;
    const share = shareParam(request);
    const q = share ? `?share=${encodeURIComponent(share)}` : "";
    const styles = Object.fromEntries(
      MAP_STYLES.map((name) => [
        name,
        proxied ? `/api/map/styles/${name}${q}` : `${upstreamBase()}/styles/${name}`
      ])
    ) as Record<MapStyleName, string>;
    return { mode: proxied ? "proxied" : "direct", styles, attribution: OPENFREEMAP_ATTRIBUTION };
  });

  app.get("/api/map/styles/:style", access, async (request, reply) => {
    const { style } = request.params as { style: string };
    if (!(MAP_STYLES as readonly string[]).includes(style)) {
      return reply.code(404).send({ error: "No such map style." });
    }
    return serveStyle(request, reply, style as MapStyleName);
  });

  app.get("/api/map/tiles/:z/:x/:file", access, async (request, reply) => {
    const { z: zRaw, x: xRaw, file } = request.params as { z: string; x: string; file: string };
    const at = tileCoordinates(zRaw, xRaw, file, "pbf", VECTOR_MAX_ZOOM);
    if (!at) return reply.code(400).send({ error: "Not a tile." });
    return serveAsset(request, reply, { kind: "vector", ...at });
  });

  app.get("/api/map/raster/:z/:x/:file", access, async (request, reply) => {
    const { z: zRaw, x: xRaw, file } = request.params as { z: string; x: string; file: string };
    const at = tileCoordinates(zRaw, xRaw, file, "png", RASTER_MAX_ZOOM);
    if (!at) return reply.code(400).send({ error: "Not a tile." });
    return serveAsset(request, reply, { kind: "raster", ...at });
  });

  app.get("/api/map/fonts/:fontstack/:file", access, async (request, reply) => {
    const { fontstack, file } = request.params as { fontstack: string; file: string };
    const range = glyphRange(file);
    if (!FONTSTACK.test(fontstack) || !range) return reply.code(400).send({ error: "Not a glyph range." });
    return serveAsset(request, reply, { kind: "font", fontstack, range });
  });

  app.get("/api/map/sprites/:version/:file", access, async (request, reply) => {
    const { version, file } = request.params as { version: string; file: string };
    if (!/^[A-Za-z0-9_]{1,40}$/.test(version) || !(SPRITE_FILES as readonly string[]).includes(file)) {
      return reply.code(404).send({ error: "No such sprite." });
    }
    return serveAsset(request, reply, { kind: "sprite", version, file: file as SpriteFile });
  });

  // Everything Maps › Setup shows, in one answer: the cache, and the sign-in
  // location databases (which live with core/geoip.ts, not here).
  app.get("/api/map/settings", { preHandler: app.requireAdmin }, async () => ({
    settings: getMapSettings(),
    // folder: the Map data room itself (what the Storage page moves); path: the
    // tile cache inside it (what turning caching off deletes).
    cache: { folder: mapDataDir(), path: tileCacheDir(), bytes: folderBytes(tileCacheDir()) },
    locations: geoipStatus()
  }));

  // Turning the cache off deletes it — it is all regenerable, and "off" was
  // promised to cost no disk. The reply says how much that freed.
  app.put("/api/map/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid map settings", details: parsed.error.issues });
    const before = getMapSettings();
    saveMapSettings(parsed.data, request.user!.id);
    const freedBytes = before.cache && !parsed.data.cache ? clearTileCache() : 0;
    if (before.cache !== parsed.data.cache) {
      logActivity({
        event: "maps.settings_updated",
        actorUserId: request.user!.id,
        detail: parsed.data.cache
          ? "Map caching turned on"
          : `Map caching turned off (${freedBytes} bytes freed)`,
        ipAddress: request.ip
      });
    }
    return { settings: getMapSettings(), freedBytes };
  });
}
