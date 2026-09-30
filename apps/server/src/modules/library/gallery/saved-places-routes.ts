// The saved places list (saved-places.ts): read it, add to it, rename, delete.
// One list for the household, open to whoever may edit photos in a gallery
// library — anyone else reads an empty list rather than an error, since the
// location editor asks on every open and has nothing to say about a refusal.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { placeLanguage } from "./places.js";
import {
  SavedPlaceError,
  canUseSavedPlaces,
  createSavedPlace,
  deleteSavedPlace,
  listRecentPlaces,
  listSavedPlaces,
  renameSavedPlace
} from "./saved-places.js";

const nameSchema = z.string().trim().min(1).max(60);

const createSchema = z.object({
  name: nameSchema,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const renameSchema = z.object({ name: nameSchema });

export function registerGallerySavedPlaceRoutes(app: FastifyInstance) {
  /** Replies 403 and returns false for someone the list is not offered to. */
  const mayChange = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (canUseSavedPlaces(request.user!)) return true;
    void reply.code(403).send({ error: "Saved places are for people who can edit photos." });
    return false;
  };

  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SavedPlaceError) return reply.code(409).send({ error: err.message, code: err.code });
    throw err;
  };

  app.get("/api/library/gallery/saved-places", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    if (!canUseSavedPlaces(user)) return reply.send({ canSave: false, places: [], recent: [] });
    return reply.send({
      canSave: true,
      places: listSavedPlaces(),
      recent: listRecentPlaces(user.id, placeLanguage(request))
    });
  });

  app.post("/api/library/gallery/saved-places", { preHandler: app.authenticate }, async (request, reply) => {
    if (!mayChange(request, reply)) return reply;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid place", details: parsed.error });
    try {
      const place = createSavedPlace(parsed.data, request.user!.id);
      logActivity({
        event: "gallery.saved_place.created",
        actorUserId: request.user!.id,
        targetType: "gallery_saved_place",
        targetId: place.id,
        detail: `Saved the place "${place.name}".`,
        ipAddress: request.ip
      });
      return reply.code(201).send({ place });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.patch("/api/library/gallery/saved-places/:id", { preHandler: app.authenticate }, async (request, reply) => {
    if (!mayChange(request, reply)) return reply;
    const parsed = parseBody(renameSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid name", details: parsed.error });
    try {
      const place = renameSavedPlace((request.params as { id: string }).id, parsed.data.name);
      if (!place) return reply.code(404).send({ error: "That saved place is no longer there." });
      logActivity({
        event: "gallery.saved_place.renamed",
        actorUserId: request.user!.id,
        targetType: "gallery_saved_place",
        targetId: place.id,
        detail: `Renamed a saved place to "${place.name}".`,
        ipAddress: request.ip
      });
      return reply.send({ place });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // No photo and no pin goes with it, but the list is the household's: like any
  // DELETE it is refused from outside under deletion protection.
  app.delete(
    "/api/library/gallery/saved-places/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!mayChange(request, reply)) return reply;
      const place = deleteSavedPlace((request.params as { id: string }).id);
      if (!place) return reply.code(404).send({ error: "That saved place is no longer there." });
      logActivity({
        event: "gallery.saved_place.deleted",
        actorUserId: request.user!.id,
        targetType: "gallery_saved_place",
        targetId: place.id,
        detail: `Deleted the saved place "${place.name || "Home"}".`,
        ipAddress: request.ip
      });
      return reply.send({ deleted: true });
    }
  );
}
