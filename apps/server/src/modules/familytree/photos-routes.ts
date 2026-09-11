import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { parseBody, parseQuery } from "../../core/shared.js";
import {
  attachFamilyPhotos, detachFamilyPhoto, getFamilyPersonPhotos,
  attachFamilyEventPhotos, detachFamilyEventPhoto
} from "./photos.js";
import { canEditPerson } from "./access.js";
import { getFamilyEvent } from "./events.js";

const attachPhotosSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(500)
});

export function registerPhotoRoutes(app: FastifyInstance) {
  // Strings, not numbers: junk falls back to the defaults below.
  const photosQuerySchema = z.object({ limit: z.string().optional(), offset: z.string().optional() });

  app.get("/api/family-tree/persons/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(photosQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const result = getFamilyPersonPhotos(request.user!, (request.params as { id: string }).id, limit, offset);
    if (!result) {
      return reply.code(404).send({ error: "Person not found" });
    }
    return reply.send(result);
  });

  // ── Event photo attachments (admin or branch editor, via the event's person) ──

  app.post("/api/family-tree/events/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const event = getFamilyEvent((request.params as { id: string }).id);
    if (!event) {
      return reply.code(404).send({ error: "Event not found" });
    }
    const parsed = parseBody(attachPhotosSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid photo selection", details: parsed.error });
    }
    if (!canEditPerson(request.user!, event.personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const result = attachFamilyEventPhotos(event.id, parsed.data.itemIds, request.user!.id);
    if ("error" in result) {
      return reply.code(404).send({ error: result.error === "event_not_found" ? "Event not found" : "Gallery item not found" });
    }
    return reply.send({ attached: result.attached });
  });

  app.delete("/api/family-tree/events/:id/photos/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: eventId, itemId } = request.params as { id: string; itemId: string };
    const event = getFamilyEvent(eventId);
    if (!event) {
      return reply.code(404).send({ error: "Event not found" });
    }
    if (!canEditPerson(request.user!, event.personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    if (!detachFamilyEventPhoto(eventId, itemId)) {
      return reply.code(404).send({ error: "Attachment not found" });
    }
    return reply.send({ removed: true });
  });

  // ── Photo attachments (admin or branch editor) ──

  app.post("/api/family-tree/persons/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(attachPhotosSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid photo selection", details: parsed.error });
    }
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const result = attachFamilyPhotos(personId, parsed.data.itemIds, request.user!.id);
    if ("error" in result) {
      const message = result.error === "person_not_found" ? "Person not found" : "Gallery item not found";
      return reply.code(404).send({ error: message });
    }
    logActivity({
      event: "familytree.photos.attached",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      targetId: personId,
      detail: `Attached ${result.attached} photo${result.attached === 1 ? "" : "s"} to a family member.`,
      ipAddress: request.ip
    });
    return reply.send({ attached: result.attached });
  });

  app.delete("/api/family-tree/persons/:id/photos/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: personId, itemId } = request.params as { id: string; itemId: string };
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    if (!detachFamilyPhoto(personId, itemId)) {
      return reply.code(404).send({ error: "Attachment not found" });
    }
    return reply.send({ removed: true });
  });
}
