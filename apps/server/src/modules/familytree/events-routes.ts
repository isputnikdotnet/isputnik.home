import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import { canEditPerson } from "./access.js";
import { EVENT_TYPES, createFamilyEvent, updateFamilyEvent, deleteFamilyEvent, getFamilyEvent } from "./events.js";
import { optionalDate } from "./persons-routes.js";

// A custom event needs a label ("what happened"); typed events can rely on the
// type name alone.
const eventFields = {
  type: z.enum(EVENT_TYPES),
  label: z.string().trim().max(120).nullable().optional(),
  date: optionalDate,
  endDate: optionalDate,
  place: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
};
const eventRefine = (data: { type?: string; label?: string | null }) =>
  data.type !== "custom" || (data.label ?? "").trim().length > 0;
const createEventSchema = z.object(eventFields).refine(eventRefine, {
  message: "A custom event needs a label", path: ["label"]
});
const updateEventSchema = z.object({ ...eventFields, type: eventFields.type.optional() });

export function registerEventRoutes(app: FastifyInstance) {
  // ── Life events (admin or branch editor) ──

  app.post("/api/family-tree/persons/:id/events", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createEventSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid event", details: parsed.error });
    }
    const personId = (request.params as { id: string }).id;
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const event = createFamilyEvent(personId, parsed.data);
    if (!event) {
      return reply.code(404).send({ error: "Person not found" });
    }
    return reply.code(201).send({ event });
  });

  app.patch("/api/family-tree/events/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(updateEventSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    const existing = getFamilyEvent((request.params as { id: string }).id);
    if (!existing) {
      return reply.code(404).send({ error: "Event not found" });
    }
    if (!canEditPerson(request.user!, existing.personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const event = updateFamilyEvent(existing.id, parsed.data);
    return reply.send({ event });
  });

  app.delete("/api/family-tree/events/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const existing = getFamilyEvent((request.params as { id: string }).id);
    if (!existing) {
      return reply.code(404).send({ error: "Event not found" });
    }
    if (!canEditPerson(request.user!, existing.personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    deleteFamilyEvent(existing.id);
    return reply.send({ deleted: true });
  });
}
