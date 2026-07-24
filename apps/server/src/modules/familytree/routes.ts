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
  getUnion, createUnion, updateUnion, deleteUnion, addChild, removeChild
} from "./relations.js";
import { attachFamilyPhotos, detachFamilyPhoto, getFamilyPersonPhotos } from "./photos.js";

const RELATION_ERRORS: Record<RelationError, { code: number; message: string }> = {
  person_not_found: { code: 404, message: "Person not found" },
  union_not_found: { code: 404, message: "Union not found" },
  same_person: { code: 400, message: "A union needs two different people." },
  child_is_partner: { code: 400, message: "A person can't be a child of their own union." },
  child_has_parents: { code: 409, message: "This person already has parents. Remove them from their current family first." },
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
  divorcedDate: optionalDate,
  note: z.string().trim().max(1000).nullable().optional()
});
const createUnionSchema = unionFieldsSchema.extend({
  person1Id: z.string().trim().min(1),
  person2Id: z.string().trim().min(1).nullable().optional()
});
const addChildSchema = z.object({
  childId: z.string().trim().min(1),
  relation: z.enum(CHILD_RELATIONS).optional()
});
const attachPhotosSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(500)
});

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

  app.patch("/api/family-tree/unions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(unionFieldsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const union = updateUnion((request.params as { id: string }).id, parsed.data);
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
