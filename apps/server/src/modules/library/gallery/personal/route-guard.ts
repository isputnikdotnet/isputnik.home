// The routes that name a library by id — its settings, members, scan rules, folder
// locks, layout, folders, rescan, delete, folder moves — are admin routes, and an
// admin may not reach into a personal library (docs/photo-sync-plan.md, decision 3).
// Rather than teach each of them, one onRoute hook appends this check to every route
// under the two library-id prefixes, after its own authentication has run:
//
//   • someone else's personal library answers 404, as if it did not exist — the
//     only exception is deleting an ORPHANED one (decision 11), which an admin may;
//   • a folder move may not take a folder INTO someone else's personal library;
//   • on their own personal library the owner may do what the route lets them,
//     except grant access to it: a personal library has no grants, so the members
//     route refuses writes and a library edit cannot make it public or give it away.
//
// Item routes (assets, streams, albums) need nothing from here: they ask the access
// override (system-library-access.ts), which already answers "nothing" for anyone
// but the owner.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { personalMarkerOf } from "./personal-libraries.js";

const GUARDED = /^\/api\/library\/(libraries|gallery-libraries)\/:id(\/|$)/;

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function asArray(value: RouteOptions["preHandler"]): Handler[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]) as Handler[];
}

function guardFor(route: RouteOptions): Handler {
  const method = (Array.isArray(route.method) ? route.method : [route.method]).map((m) => m.toUpperCase());
  const isDelete = method.includes("DELETE") && route.url === "/api/library/gallery-libraries/:id";
  const isMembers = /\/members(\/|$)/.test(route.url);
  const isTakeOwnership = route.url.endsWith("/take-ownership");
  const isLibraryEdit = method.includes("PATCH") && route.url === "/api/library/gallery-libraries/:id";
  const isFolderMove = route.url.endsWith("/folders/move");

  return async (request, reply) => {
    if (reply.sent) return;
    const user = request.user;
    const id = (request.params as { id?: string }).id;
    if (!user || !id) return;

    const marker = personalMarkerOf(id);
    if (marker) {
      const isOwner = !marker.personal_orphaned_at && marker.personal_user_id === user.id && request.previewBy == null;
      if (!isOwner) {
        if (isDelete && marker.personal_orphaned_at && user.role === "admin") return;
        return reply.code(404).send({ error: "Library not found" });
      }
      if (isTakeOwnership || (isMembers && request.method !== "GET")) {
        return reply.code(409).send({ error: "A personal library is only its owner's, so it has no access to give." });
      }
      if (isLibraryEdit && request.body && typeof request.body === "object") {
        const body = request.body as Record<string, unknown>;
        body.visibility = "private";
        delete body.ownerId;
        delete body.ownerType;
        delete body.publicRole;
      }
    }

    if (isFolderMove) {
      const target = (request.body as { targetLibraryId?: unknown } | undefined)?.targetLibraryId;
      if (typeof target === "string") {
        const targetMarker = personalMarkerOf(target);
        if (targetMarker && (targetMarker.personal_orphaned_at || targetMarker.personal_user_id !== user.id)) {
          return reply.code(404).send({ error: "Library not found" });
        }
      }
    }
  };
}

export function registerPersonalLibraryRouteGuard(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (!GUARDED.test(route.url)) return;
    route.preHandler = [...asArray(route.preHandler), guardFor(route)] as RouteOptions["preHandler"];
  });
}
