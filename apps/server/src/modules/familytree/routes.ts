// Family-tree API. Read endpoints are open to every signed-in user; every
// mutation is admin-only — the tree is shared family data, so curation is
// centralised rather than per-library like gallery write access.
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "../library/shared/thumbnail.js";
import {
  partialDateSchema, GENDERS,
  listFamilyPersons, getFamilyPerson, getFamilyPersonProfile, getFamilyTree,
  createFamilyPerson, updateFamilyPerson, deleteFamilyPerson,
  getPortraitStorageKey, setUploadedPortrait
} from "./persons.js";
import {
  UNION_STATUSES, CHILD_RELATIONS, type RelationError,
  getUnion, createUnion, updateUnion, setUnionPartner, deleteUnion, addChild, removeChild
} from "./relations.js";
import { attachFamilyPhotos, detachFamilyPhoto, getFamilyPersonPhotos } from "./photos.js";
import { exportGedcom, importGedcom } from "./gedcom.js";
import { EVENT_TYPES, createFamilyEvent, updateFamilyEvent, deleteFamilyEvent, getFamilyEvent } from "./events.js";
import {
  CITATION_FACTS, type CitationError,
  listFamilySources, getFamilySource, createFamilySource, updateFamilySource, deleteFamilySource,
  createFamilyCitation, updateFamilyCitation, deleteFamilyCitation, getFamilyCitation
} from "./sources.js";

const RELATION_ERRORS: Record<RelationError, { code: number; message: string }> = {
  person_not_found: { code: 404, message: "Person not found" },
  union_not_found: { code: 404, message: "Union not found" },
  same_person: { code: 400, message: "A union needs two different people." },
  child_is_partner: { code: 400, message: "A person can't be a child of their own union." },
  child_has_parents: { code: 409, message: "This person already has parents. Remove them from their current family first." },
  union_has_partner: { code: 409, message: "This family already has two parents." },
  would_create_cycle: { code: 400, message: "This link would make someone their own ancestor." }
};

const optionalDate = partialDateSchema.nullable().optional();

const personFields = {
  name: z.string().trim().min(1).max(120),
  maidenName: z.string().trim().max(120).nullable().optional(),
  gender: z.enum(GENDERS).optional(),
  birthDate: optionalDate,
  deathDate: optionalDate,
  birthplace: z.string().trim().max(200).nullable().optional(),
  deathPlace: z.string().trim().max(200).nullable().optional(),
  bio: z.string().trim().max(4000).nullable().optional()
};

const createPersonSchema = z.object(personFields);
const updatePersonSchema = z.object({
  ...personFields,
  name: personFields.name.optional(),
  galleryPersonId: z.string().trim().min(1).nullable().optional(),
  portraitItemId: z.string().trim().min(1).nullable().optional()
});

const unionFieldsSchema = z.object({
  status: z.enum(UNION_STATUSES).optional(),
  marriedDate: optionalDate,
  marriedPlace: z.string().trim().max(200).nullable().optional(),
  divorcedDate: optionalDate,
  note: z.string().trim().max(1000).nullable().optional()
});
const createUnionSchema = unionFieldsSchema.extend({
  person1Id: z.string().trim().min(1),
  person2Id: z.string().trim().min(1).nullable().optional()
});
const updateUnionSchema = unionFieldsSchema.extend({
  person2Id: z.string().trim().min(1).optional()
});
const addChildSchema = z.object({
  childId: z.string().trim().min(1),
  relation: z.enum(CHILD_RELATIONS).optional()
});
const attachPhotosSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(500)
});
const importGedcomSchema = z.object({
  gedcom: z.string().min(1),
  mode: z.enum(["add", "replace"]).optional()
});
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

const sourceFields = {
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  url: z.string().trim().url().max(1000).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
};
const createSourceSchema = z.object(sourceFields);
const updateSourceSchema = z.object({ ...sourceFields, title: sourceFields.title.optional() });
const citationAnnotation = {
  fact: z.enum(CITATION_FACTS).nullable().optional(),
  detail: z.string().trim().max(500).nullable().optional(),
  url: z.string().trim().url().max(1000).nullable().optional(),
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

export async function familyTreeRoutesPlugin(app: FastifyInstance) {
  // Raw image bodies for the portrait upload (parsers are plugin-scoped).
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  // ── Browse (any signed-in user) ──

  app.get("/api/family-tree/tree", { preHandler: app.authenticate }, async () => getFamilyTree());

  app.get("/api/family-tree/persons", { preHandler: app.authenticate }, async (request) => {
    const q = String((request.query as { q?: string }).q ?? "").trim();
    return { persons: listFamilyPersons(q || undefined) };
  });

  app.get("/api/family-tree/persons/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const profile = getFamilyPersonProfile((request.params as { id: string }).id);
    if (!profile) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.send({ person: profile });
  });

  app.get("/api/family-tree/persons/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const qp = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const result = getFamilyPersonPhotos(request.user!, (request.params as { id: string }).id, limit, offset);
    if (!result) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.send(result);
  });

  // ── GEDCOM import/export ──

  // A read like the rest of the browse endpoints — any signed-in user already
  // sees all of this data, so any of them may download it.
  app.get("/api/family-tree/export", { preHandler: app.authenticate }, async (_request, reply) => {
    const filename = `family-tree-${new Date().toISOString().slice(0, 10)}.ged`;
    reply
      .header("Content-Type", "text/x-gedcom; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(exportGedcom());
  });

  // The client sends the file's text as JSON. Fastify's default 1 MiB body
  // limit is too small for big trees, hence the per-route override.
  app.post("/api/family-tree/import", { preHandler: app.requireAdmin, bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const parsed = parseBody(importGedcomSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid import request", details: parsed.error });
      return;
    }
    const outcome = importGedcom(parsed.data.gedcom, parsed.data.mode ?? "add", request.user!.id);
    if ("error" in outcome) {
      reply.code(400).send({ error: "No people (INDI records) found — is this a GEDCOM file?" });
      return;
    }
    // Uploaded portrait files of replaced persons, removed after the commit.
    for (const key of outcome.removedPortraitKeys) {
      await fs.rm(thumbnailAbsolutePath(key), { force: true }).catch(() => {});
    }
    const { result } = outcome;
    logActivity({
      event: "familytree.imported",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      detail: `Imported ${result.personsCreated} people and ${result.unionsCreated} families from a GEDCOM file`
        + (result.personsRemoved > 0 ? `, replacing ${result.personsRemoved} existing people.` : "."),
      ipAddress: request.ip
    });
    reply.send(result);
  });

  // ── Persons (admin) ──

  app.post("/api/family-tree/persons", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createPersonSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid person", details: parsed.error });
      return;
    }
    const person = createFamilyPerson(parsed.data, request.user!.id);
    logActivity({
      event: "familytree.person.created",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      targetId: person.id,
      detail: `Added "${person.name}" to the family tree.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ person });
  });

  app.patch("/api/family-tree/persons/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(updatePersonSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    if (parsed.data.galleryPersonId) {
      const exists = db.prepare("SELECT 1 FROM gallery_people WHERE id = ?").get(parsed.data.galleryPersonId);
      if (!exists) {
        reply.code(404).send({ error: "Gallery person not found" });
        return;
      }
    }
    if (parsed.data.portraitItemId) {
      const item = db.prepare(`
        SELECT 1 FROM library_items
        JOIN gallery_details ON gallery_details.item_id = library_items.id
        WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      `).get(parsed.data.portraitItemId);
      if (!item) {
        reply.code(404).send({ error: "Gallery item not found" });
        return;
      }
    }
    // Switching to a gallery portrait replaces an uploaded one; remove the file.
    const oldPortraitKey = parsed.data.portraitItemId ? getPortraitStorageKey(personId) : null;
    const person = updateFamilyPerson(personId, parsed.data);
    if (!person) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    if (oldPortraitKey) {
      await fs.rm(thumbnailAbsolutePath(oldPortraitKey), { force: true }).catch(() => {});
    }
    reply.send({ person });
  });

  app.delete("/api/family-tree/persons/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const person = getFamilyPerson(personId);
    if (!person) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    const { portraitKey } = deleteFamilyPerson(personId);
    if (portraitKey) {
      await fs.rm(thumbnailAbsolutePath(portraitKey), { force: true }).catch(() => {});
    }
    logActivity({
      event: "familytree.person.deleted",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      targetId: personId,
      detail: `Removed "${person.name}" from the family tree. Relatives and photos were kept.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });

  // ── Portrait upload (admin) ──

  app.put("/api/family-tree/persons/:id/portrait", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Portrait image is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Portrait is too large (max 10 MB)." });
      return;
    }
    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    // Versioned file name so a replaced portrait isn't masked by browser cache.
    const storageKey = thumbnailStorageKey("familytree", personId, `${personId}-portrait-${Date.now()}${ext}`);
    const absolutePath = thumbnailAbsolutePath(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body);

    const oldKey = getPortraitStorageKey(personId);
    setUploadedPortrait(personId, storageKey);
    if (oldKey && oldKey !== storageKey) {
      await fs.rm(thumbnailAbsolutePath(oldKey), { force: true }).catch(() => {});
    }
    reply.send({ person: getFamilyPerson(personId) });
  });

  app.delete("/api/family-tree/persons/:id/portrait", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    const oldKey = getPortraitStorageKey(personId);
    // Clears both portrait sources (uploaded file and gallery item).
    setUploadedPortrait(personId, null);
    if (oldKey) {
      await fs.rm(thumbnailAbsolutePath(oldKey), { force: true }).catch(() => {});
    }
    reply.send({ person: getFamilyPerson(personId) });
  });

  // ── Unions (admin) ──

  app.post("/api/family-tree/unions", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createUnionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid union", details: parsed.error });
      return;
    }
    const { person1Id, person2Id, ...fields } = parsed.data;
    const result = createUnion(person1Id, person2Id ?? null, fields);
    if ("error" in result) {
      const err = RELATION_ERRORS[result.error];
      reply.code(err.code).send({ error: err.message });
      return;
    }
    reply.code(201).send({ union: result.union });
  });

  // `person2Id` fills the empty partner slot of a single-parent union (the
  // "add the other parent" flow); the field updates apply in the same request.
  app.patch("/api/family-tree/unions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(updateUnionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const unionId = (request.params as { id: string }).id;
    const { person2Id, ...fields } = parsed.data;
    if (person2Id) {
      const result = setUnionPartner(unionId, person2Id);
      if ("error" in result) {
        const err = RELATION_ERRORS[result.error];
        reply.code(err.code).send({ error: err.message });
        return;
      }
    }
    const union = updateUnion(unionId, fields);
    if (!union) {
      reply.code(404).send({ error: "Union not found" });
      return;
    }
    reply.send({ union });
  });

  app.delete("/api/family-tree/unions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!deleteUnion((request.params as { id: string }).id)) {
      reply.code(404).send({ error: "Union not found" });
      return;
    }
    reply.send({ deleted: true });
  });

  // ── Children (admin) ──

  app.post("/api/family-tree/unions/:id/children", { preHandler: app.requireAdmin }, async (request, reply) => {
    const unionId = (request.params as { id: string }).id;
    const parsed = parseBody(addChildSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid child link", details: parsed.error });
      return;
    }
    const result = addChild(unionId, parsed.data.childId, parsed.data.relation ?? "biological");
    if ("error" in result) {
      const err = RELATION_ERRORS[result.error];
      reply.code(err.code).send({ error: err.message });
      return;
    }
    reply.code(201).send({ union: getUnion(unionId) });
  });

  app.delete("/api/family-tree/unions/:id/children/:childId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id: unionId, childId } = request.params as { id: string; childId: string };
    if (!removeChild(unionId, childId)) {
      reply.code(404).send({ error: "Child link not found" });
      return;
    }
    reply.send({ removed: true });
  });

  // ── Life events (admin) ──

  app.post("/api/family-tree/persons/:id/events", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createEventSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid event", details: parsed.error });
      return;
    }
    const event = createFamilyEvent((request.params as { id: string }).id, parsed.data);
    if (!event) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.code(201).send({ event });
  });

  app.patch("/api/family-tree/events/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(updateEventSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const event = updateFamilyEvent((request.params as { id: string }).id, parsed.data);
    if (!event) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    reply.send({ event });
  });

  app.delete("/api/family-tree/events/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!getFamilyEvent((request.params as { id: string }).id)) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    deleteFamilyEvent((request.params as { id: string }).id);
    reply.send({ deleted: true });
  });

  // ── Sources & citations ──

  app.get("/api/family-tree/sources", { preHandler: app.authenticate }, async () => ({
    sources: listFamilySources()
  }));

  app.post("/api/family-tree/sources", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createSourceSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid source", details: parsed.error });
      return;
    }
    reply.code(201).send({ source: createFamilySource(parsed.data) });
  });

  app.patch("/api/family-tree/sources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(updateSourceSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const source = updateFamilySource((request.params as { id: string }).id, parsed.data);
    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    reply.send({ source });
  });

  app.delete("/api/family-tree/sources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!getFamilySource((request.params as { id: string }).id)) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    deleteFamilySource((request.params as { id: string }).id);
    reply.send({ deleted: true });
  });

  app.post("/api/family-tree/citations", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createCitationSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid citation", details: parsed.error });
      return;
    }
    const result = createFamilyCitation(parsed.data);
    if ("error" in result) {
      const err = CITATION_ERRORS[result.error];
      reply.code(err.code).send({ error: err.message });
      return;
    }
    reply.code(201).send({ citation: result.citation });
  });

  app.patch("/api/family-tree/citations/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(updateCitationSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const citation = updateFamilyCitation((request.params as { id: string }).id, parsed.data);
    if (!citation) {
      reply.code(404).send({ error: "Citation not found" });
      return;
    }
    reply.send({ citation });
  });

  app.delete("/api/family-tree/citations/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!getFamilyCitation((request.params as { id: string }).id)) {
      reply.code(404).send({ error: "Citation not found" });
      return;
    }
    deleteFamilyCitation((request.params as { id: string }).id);
    reply.send({ deleted: true });
  });

  // ── Photo attachments (admin) ──

  app.post("/api/family-tree/persons/:id/photos", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(attachPhotosSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid photo selection", details: parsed.error });
      return;
    }
    const result = attachFamilyPhotos(personId, parsed.data.itemIds, request.user!.id);
    if ("error" in result) {
      const message = result.error === "person_not_found" ? "Person not found" : "Gallery item not found";
      reply.code(404).send({ error: message });
      return;
    }
    logActivity({
      event: "familytree.photos.attached",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      targetId: personId,
      detail: `Attached ${result.attached} photo${result.attached === 1 ? "" : "s"} to a family member.`,
      ipAddress: request.ip
    });
    reply.send({ attached: result.attached });
  });

  app.delete("/api/family-tree/persons/:id/photos/:itemId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id: personId, itemId } = request.params as { id: string; itemId: string };
    if (!detachFamilyPhoto(personId, itemId)) {
      reply.code(404).send({ error: "Attachment not found" });
      return;
    }
    reply.send({ removed: true });
  });
}
