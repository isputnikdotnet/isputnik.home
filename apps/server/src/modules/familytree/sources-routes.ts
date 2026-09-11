import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import { getUnion } from "./relations.js";
import { canEditAnyPerson, canEditPerson } from "./access.js";
import { getFamilyEvent } from "./events.js";
import {
  CITATION_FACTS, type CitationError,
  listFamilySources, getFamilySource, createFamilySource, updateFamilySource, deleteFamilySource,
  createFamilyCitation, updateFamilyCitation, deleteFamilyCitation, getFamilyCitation
} from "./sources.js";

const sourceFields = {
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  url: z.string().trim().pipe(z.url().max(1000)).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
};
const createSourceSchema = z.object(sourceFields);
const updateSourceSchema = z.object({ ...sourceFields, title: sourceFields.title.optional() });
const citationAnnotation = {
  fact: z.enum(CITATION_FACTS).nullable().optional(),
  detail: z.string().trim().max(500).nullable().optional(),
  url: z.string().trim().pipe(z.url().max(1000)).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
};
const createCitationSchema = z.object({
  sourceId: z.string().trim().min(1),
  personId: z.string().trim().min(1).nullable().optional(),
  eventId: z.string().trim().min(1).nullable().optional(),
  unionId: z.string().trim().min(1).nullable().optional(),
  ...citationAnnotation
});
const updateCitationSchema = z.object(citationAnnotation);

const CITATION_ERRORS: Record<CitationError, { code: number; message: string }> = {
  source_not_found: { code: 404, message: "Source not found" },
  target_not_found: { code: 404, message: "The person, event, or union to cite was not found." },
  bad_target: { code: 400, message: "A citation needs exactly one target: a person, an event, or a union." }
};

export function registerSourceRoutes(app: FastifyInstance) {
  // ── Sources & citations ──

  app.get("/api/family-tree/sources", { preHandler: app.authenticate }, async () => ({
    sources: listFamilySources()
  }));

  app.post("/api/family-tree/sources", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createSourceSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid source", details: parsed.error });
    }
    return reply.code(201).send({ source: createFamilySource(parsed.data) });
  });

  app.patch("/api/family-tree/sources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(updateSourceSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    const source = updateFamilySource((request.params as { id: string }).id, parsed.data);
    if (!source) {
      return reply.code(404).send({ error: "Source not found" });
    }
    return reply.send({ source });
  });

  app.delete("/api/family-tree/sources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!getFamilySource((request.params as { id: string }).id)) {
      return reply.code(404).send({ error: "Source not found" });
    }
    deleteFamilySource((request.params as { id: string }).id);
    return reply.send({ deleted: true });
  });

  // A citation is editable through the person it documents: the cited person,
  // the event's person, or (for a union) either partner. Editors may cite
  // existing sources; creating sources themselves stays admin-only.
  const canEditCitationTarget = (
    user: { id: string; role: string },
    target: { personId?: string | null; eventId?: string | null; unionId?: string | null }
  ): boolean => {
    if (user.role === "admin") return true;
    if (target.personId) return canEditPerson(user, target.personId);
    if (target.eventId) {
      const event = getFamilyEvent(target.eventId);
      return event != null && canEditPerson(user, event.personId);
    }
    if (target.unionId) {
      const union = getUnion(target.unionId);
      return union != null && canEditAnyPerson(user, [union.person1Id, union.person2Id]);
    }
    return false;
  };

  app.post("/api/family-tree/citations", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createCitationSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid citation", details: parsed.error });
    }
    if (!canEditCitationTarget(request.user!, parsed.data)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const result = createFamilyCitation(parsed.data);
    if ("error" in result) {
      const err = CITATION_ERRORS[result.error];
      return reply.code(err.code).send({ error: err.message });
    }
    return reply.code(201).send({ citation: result.citation });
  });

  app.patch("/api/family-tree/citations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(updateCitationSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    const existing = getFamilyCitation((request.params as { id: string }).id);
    if (!existing) {
      return reply.code(404).send({ error: "Citation not found" });
    }
    if (!canEditCitationTarget(request.user!, existing)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const citation = updateFamilyCitation(existing.id, parsed.data);
    return reply.send({ citation });
  });

  app.delete("/api/family-tree/citations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const existing = getFamilyCitation((request.params as { id: string }).id);
    if (!existing) {
      return reply.code(404).send({ error: "Citation not found" });
    }
    if (!canEditCitationTarget(request.user!, existing)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    deleteFamilyCitation(existing.id);
    return reply.send({ deleted: true });
  });
}
