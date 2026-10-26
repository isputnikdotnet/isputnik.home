// Video — TV shows and movies, kept by the video engine (isputnik.video) and
// managed here (docs/video-architecture.md). Home owns the screens, the library
// list and who may see what; the engine scans, describes and (later) plays.
//
//   - the gateway to /video (modules/apps/gateway.ts), telling the engine which
//     of its libraries the person may see in X-Isputnik-Libraries;
//   - video libraries as rows here, created, changed and deleted through the
//     same calls on the engine (libraries.ts, engine.ts);
//   - the engine's folders for Add library's picker;
//   - a sync now and then, so a library deleted here while the engine was down
//     is detached there (kept 30 days) rather than left as if it still existed.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../../config.js";
import { getSections } from "../../../core/sections.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { appRole } from "../../apps/access.js";
import { registerAppGateway } from "../../apps/gateway.js";
import { resolveAppSecret } from "../../apps/pairing.js";
import { appConfigured, appDefinition, urlProblem } from "../../apps/registry.js";
import { accessibleLibraryIds, canUserAccessLibrary } from "../shared/library-access.js";
import { EngineError, engineClient, type EngineTarget } from "./engine.js";
import {
  VideoLibraryError,
  deleteVideoLibraryRow,
  engineBody,
  getVideoLibrary,
  insertVideoLibrary,
  listVideoLibraries,
  noteVideoLibrary,
  publicVideoLibrary,
  restoreVideoLibrary,
  updateVideoLibrary,
  videoLibraryCreateSchema,
  videoLibraryUpdateSchema,
  VIDEO_LIBRARY_TYPE,
  type EngineLibrary
} from "./libraries.js";

const VIDEO = appDefinition("video");

/** Often enough that a library deleted here while the engine was down is
 *  detached there the same day; rarely enough to cost nothing. */
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

const listQuerySchema = z.object({ manage: z.string().optional() });
const foldersQuerySchema = z.object({ path: z.string().max(1000).default("") });

export interface VideoPluginOptions {
  /** Overrides for tests, which run without VIDEO_URL and point at a stand-in. */
  upstream?: string;
  secret?: string;
}

export async function videoPlugin(app: FastifyInstance, opts: VideoPluginOptions = {}) {
  const target = (): EngineTarget => ({
    upstream: opts.upstream ?? config.videoUrl,
    secret: opts.secret ?? resolveAppSecret("video").secret
  });
  const configured = () => appConfigured(VIDEO, target().upstream, target().secret).enabled;
  // Switched off by the admin = not there, as for the games.
  const available = () => configured() && getSections().video;
  const engine = engineClient(target);

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof EngineError || err instanceof VideoLibraryError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  /** Home's video libraries, so the engine detaches any it still has that are gone here. */
  const sync = async () => {
    if (!configured()) return;
    try {
      await engine.call("POST", "/admin/libraries/sync", { body: { ids: listVideoLibraries().map((row) => row.id) } });
    } catch (err) {
      app.log.warn({ err }, "Video: could not sync the library list with the video app");
    }
  };

  // The menu asks this once: the engine set up, the Video section on, and this
  // person let in by Apps → Access.
  app.get("/api/video/status", { preHandler: app.authenticate }, async (request) => ({
    enabled: available() && appRole("video", request.user!) !== null
  }));

  // ── Add library → Video: the engine's own folders ───────────────────────
  app.get("/api/library/video-folders", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseQuery(foldersQuerySchema, request.query);
    if (parsed.error) return reply.code(400).send({ error: "Invalid folder", details: parsed.error });
    try {
      return await engine.call("GET", `/admin/folders?path=${encodeURIComponent(parsed.data.path ?? "")}`, { actor: request.user, requestId: String(request.id) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── The libraries ───────────────────────────────────────────────────────

  /** The engine's counts by library id; null when it did not answer. */
  const engineCounts = async (request: FastifyRequest): Promise<Map<string, EngineLibrary> | null> => {
    if (!configured()) return null;
    try {
      const answer = await engine.call<{ libraries: EngineLibrary[] }>("GET", "/admin/libraries", { requestId: String(request.id) });
      return new Map(answer.libraries.map((library) => [library.id, library]));
    } catch {
      return null;
    }
  };

  app.get("/api/library/video-libraries", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseQuery(listQuerySchema, request.query);
    if (parsed.error) return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    const manage = parsed.data.manage != null && user.role === "admin";
    const rows = listVideoLibraries().filter((row) => manage || canUserAccessLibrary(row, user.id, user.role));
    // The counts are the engine's; a member's list needs none.
    const counts = manage && rows.length > 0 ? await engineCounts(request) : undefined;
    return {
      libraries: rows.map((row) => publicVideoLibrary(row, user, counts === undefined ? undefined : counts?.get(row.id) ?? null, manage)),
      engineOnline: counts === undefined ? null : counts !== null
    };
  });

  app.post("/api/library/video-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(videoLibraryCreateSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid video library details", details: parsed.error });
    const data = videoLibraryCreateSchema.parse(parsed.data);
    let row;
    try {
      row = insertVideoLibrary(data, request.user!.id);
    } catch (err) {
      return fail(reply, err);
    }
    try {
      await engine.call("PUT", `/admin/libraries/${row.id}`, { body: engineBody(row), actor: request.user, requestId: String(request.id) });
    } catch (err) {
      // The engine refused it (no such folder, engine down): it is not a library.
      deleteVideoLibraryRow(row.id);
      return fail(reply, err);
    }
    noteVideoLibrary("created", row, request.user!.id, request.ip, `Created video library "${row.name}" (${data.kind}) on the video app's "${data.folder}"; it is being scanned there.`);
    return reply.code(201).send({ library: publicVideoLibrary(row, request.user!, undefined, true) });
  });

  app.patch("/api/library/video-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(videoLibraryUpdateSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid video library details", details: parsed.error });
    const data = videoLibraryUpdateSchema.parse(parsed.data);
    let change;
    try {
      change = updateVideoLibrary(id, data, request.user!.id);
    } catch (err) {
      return fail(reply, err);
    }
    try {
      await engine.call("PUT", `/admin/libraries/${id}`, { body: engineBody(change.after), actor: request.user, requestId: String(request.id) });
    } catch (err) {
      restoreVideoLibrary(change.before);
      return fail(reply, err);
    }
    noteVideoLibrary("updated", change.after, request.user!.id, request.ip, `Updated video library "${change.after.name}".`);
    return { library: publicVideoLibrary(change.after, request.user!, undefined, true) };
  });

  app.delete("/api/library/video-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = getVideoLibrary(id);
    if (!row) return reply.code(404).send({ error: "Video library not found" });
    deleteVideoLibraryRow(id);
    // The engine drops its catalog too. If it is down now, the next sync
    // detaches the library there, and it goes after 30 days.
    let engineNote = "the video app removed its catalog";
    try {
      await engine.call("DELETE", `/admin/libraries/${id}`, { actor: request.user, requestId: String(request.id) });
    } catch (err) {
      engineNote = err instanceof EngineError && err.status === 404
        ? "the video app had no catalog for it"
        : "the video app did not answer; it will let the library go on its next sync";
    }
    noteVideoLibrary("deleted", row, request.user!.id, request.ip, `Deleted video library "${row.name}"; ${engineNote}. The video files were not touched.`);
    return { deleted: true };
  });

  app.post("/api/library/video-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = getVideoLibrary(id);
    if (!row) return reply.code(404).send({ error: "Video library not found" });
    try {
      await engine.call("POST", `/admin/libraries/${id}/scan`, { actor: request.user, requestId: String(request.id) });
    } catch (err) {
      return fail(reply, err);
    }
    noteVideoLibrary("rescan", row, request.user!.id, request.ip, `Asked the video app to rescan "${row.name}".`);
    return reply.code(202).send({ queued: true });
  });

  // ── The gateway to the engine ───────────────────────────────────────────
  // Registered for any usable address, secret or not, as the games' is.
  const upstream = target().upstream;
  if (upstream && !urlProblem(VIDEO, upstream)) {
    await registerAppGateway(app, {
      app: VIDEO,
      upstream,
      secret: () => target().secret,
      available,
      // An engine has no pages: a signed-out page load gets this server's 401.
      hasPages: false,
      hooks: {
        // The only permission model the engine has: which of its libraries this
        // person may see, worked out from each library's own access.
        extraHeaders: (request) => ({
          "x-isputnik-libraries": [...accessibleLibraryIds(request.user!.id, request.user!.role, VIDEO_LIBRARY_TYPE)].join(",")
        })
      }
    });
    app.log.info(`Video: proxying /video to ${upstream}`);
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
    app.addHook("onReady", async () => {
      void sync();
    });
  }
}
