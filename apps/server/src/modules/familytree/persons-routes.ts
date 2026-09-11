import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody, parseQuery } from "../../core/shared.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "../library/shared/thumbnail.js";
import {
  partialDateSchema, GENDERS,
  listFamilyPersons, getFamilyPerson, getFamilyPersonProfile, getFamilyTree,
  createFamilyPerson, updateFamilyPerson, deleteFamilyPerson,
  getPortraitStorageKey, setUploadedPortrait,
  expandToRelatives, applyFamilyPersonTags
} from "./persons.js";
import { getFamilyEventPhotos } from "./photos.js";
import { canEditPerson, canEditTree, decoratePersons, getEditableTags, listFamilyTags } from "./access.js";
import { normalizeText } from "../library/shared/tagging.js";
import { getFamilyDefaultPerson } from "./settings.js";

export const optionalDate = partialDateSchema.nullable().optional();

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

const tagsSchema = z.array(z.string().trim().min(1).max(120)).max(50);
const createPersonSchema = z.object({ ...personFields, tags: tagsSchema.optional() });
const updatePersonSchema = z.object({
  ...personFields,
  name: personFields.name.optional(),
  galleryPersonId: z.string().trim().min(1).nullable().optional(),
  portraitItemId: z.string().trim().min(1).nullable().optional(),
  tags: tagsSchema.optional()
});

export function registerPersonRoutes(app: FastifyInstance) {
  // ── Browse (any signed-in user) ──

  // `access` tells the client what to offer: admins see everything, branch
  // editors see edit affordances on their tagged persons plus "Add person".
  const accessFor = (user: { id: string; role: string }) => ({
    isAdmin: user.role === "admin",
    canAdd: canEditTree(user)
  });

  app.get("/api/family-tree/tree", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const tree = getFamilyTree();
    return {
      ...tree,
      persons: decoratePersons(user, tree.persons),
      access: accessFor(user),
      // Ships with the tree so the chart can centre on the right person in its
      // first render — a second round-trip would show the fallback, then jump.
      defaultPersonId: getFamilyDefaultPerson()?.id ?? null
    };
  });

  const personsQuerySchema = z.object({ q: z.string().optional() });

  app.get("/api/family-tree/persons", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseQuery(personsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const q = (parsed.data.q ?? "").trim();
    return { persons: decoratePersons(user, listFamilyPersons(q || undefined)), access: accessFor(user) };
  });

  app.get("/api/family-tree/persons/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const profile = getFamilyPersonProfile((request.params as { id: string }).id);
    if (!profile) {
      return reply.code(404).send({ error: "Person not found" });
    }
    // Decorate the nested person summaries too, so every person object the
    // client sees carries tags/canEdit. Event photos are viewer-scoped to
    // accessible gallery libraries, like the person photo wall.
    const user = request.user!;
    const eventPhotos = getFamilyEventPhotos(user, profile.id);
    return reply.send({
      person: {
        ...decoratePersons(user, [profile])[0],
        parents: decoratePersons(user, profile.parents),
        unions: profile.unions.map((union) => ({
          ...union,
          partner: union.partner ? decoratePersons(user, [union.partner])[0] : null,
          children: decoratePersons(user, union.children)
        })),
        events: profile.events.map((event) => ({ ...event, photos: eventPhotos.get(event.id) ?? [] }))
      }
    });
  });

  // Family-tag listing: feeds the person-edit autocomplete, the people-page
  // filter, and the admin branch-access modal (editorCount). The library tag
  // browse counts only library_item taggables, so family tags need their own.
  app.get("/api/family-tree/tags", { preHandler: app.authenticate }, async () => ({
    tags: listFamilyTags()
  }));

  // ── Persons (admin or branch editor) ──

  app.post("/api/family-tree/persons", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createPersonSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid person", details: parsed.error });
    }
    let tags = parsed.data.tags;
    if (user.role !== "admin") {
      const editable = getEditableTags(user);
      if (editable === "all" || editable.length === 0) {
        return reply.code(403).send({ error: "You don't have permission to add family members." });
      }
      // A branch editor's new person must carry a tag they can edit through —
      // otherwise it would be immediately un-editable for them. They may pick a
      // subset of their editable tags; anything else is rejected.
      const editableByKey = new Map(editable.map((t) => [t.key, t.name]));
      if (tags !== undefined) {
        const keys = tags.map(normalizeText);
        if (keys.length === 0 || keys.some((key) => !editableByKey.has(key))) {
          return reply.code(403).send({ error: "New family members can only carry tags you have edit rights on." });
        }
        tags = keys.map((key) => editableByKey.get(key)!);
      } else {
        tags = [...editableByKey.values()];
      }
    }
    const { tags: _ignored, ...fields } = parsed.data;
    const person = createFamilyPerson(fields, user.id, tags);
    logActivity({
      event: "familytree.person.created",
      actorUserId: user.id,
      targetType: "family_tree_person",
      targetId: person.id,
      detail: `Added "${person.name}" to the family tree.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ person: decoratePersons(user, [person])[0] });
  });

  app.patch("/api/family-tree/persons/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(updatePersonSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    if (user.role !== "admin") {
      // Tags are the permission boundary and the gallery link bridges to face
      // clusters — both stay admin-only even inside an editable branch.
      if (parsed.data.tags !== undefined || parsed.data.galleryPersonId !== undefined) {
        return reply.code(403).send({ error: "Only admins can change tags or gallery links." });
      }
      if (!canEditPerson(user, personId)) {
        return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      }
    }
    if (parsed.data.galleryPersonId) {
      const exists = db.prepare("SELECT 1 FROM gallery_people WHERE id = ?").get(parsed.data.galleryPersonId);
      if (!exists) {
        return reply.code(404).send({ error: "Gallery person not found" });
      }
    }
    if (parsed.data.portraitItemId) {
      const item = db.prepare(`
        SELECT 1 FROM library_items
        JOIN gallery_details ON gallery_details.item_id = library_items.id
        WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      `).get(parsed.data.portraitItemId);
      if (!item) {
        return reply.code(404).send({ error: "Gallery item not found" });
      }
    }
    // Switching to a gallery portrait replaces an uploaded one; remove the file.
    const oldPortraitKey = parsed.data.portraitItemId ? getPortraitStorageKey(personId) : null;
    const person = updateFamilyPerson(personId, parsed.data);
    if (!person) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (oldPortraitKey) {
      await fs.rm(thumbnailAbsolutePath(oldPortraitKey), { force: true }).catch(() => {});
    }
    return reply.send({ person: decoratePersons(user, [person])[0] });
  });

  // ── Bulk tagging (admin) ──
  //
  // Tags are the permission boundary, so scoping a branch means tagging every
  // person in it — one profile at a time does not scale past a handful. These
  // two endpoints back the People page selection and the Families page:
  // /relatives turns a seed into the whole connected family, /tags applies the
  // change. Additive by design: a person may carry several branch tags.

  const relativesSchema = z.object({
    personIds: z.array(z.string().trim().min(1)).min(1).max(2000)
  });

  app.post("/api/family-tree/persons/relatives", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(relativesSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid selection", details: parsed.error });
    }
    return reply.send({ personIds: expandToRelatives(parsed.data.personIds) });
  });

  const bulkTagsSchema = z.object({
    personIds: z.array(z.string().trim().min(1)).min(1).max(2000),
    add: tagsSchema.optional(),
    remove: tagsSchema.optional()
  });

  app.post("/api/family-tree/persons/tags", { preHandler: app.requireAdmin }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(bulkTagsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    const add = parsed.data.add ?? [];
    const remove = parsed.data.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      return reply.code(400).send({ error: "Choose at least one tag to add or remove." });
    }
    // Unknown ids are dropped rather than failing the batch — a stale selection
    // (someone deleted in another tab) should still tag everyone who is left.
    const persons = parsed.data.personIds
      .map((id) => getFamilyPerson(id))
      .filter((person): person is NonNullable<typeof person> => person != null);
    if (persons.length === 0) {
      return reply.code(404).send({ error: "None of those family members exist any more." });
    }
    applyFamilyPersonTags(persons.map((person) => person.id), add, remove);
    const changes = [
      add.length > 0 ? `added ${add.join(", ")}` : "",
      remove.length > 0 ? `removed ${remove.join(", ")}` : ""
    ].filter(Boolean).join(" and ");
    logActivity({
      event: "familytree.persons.tagged",
      actorUserId: user.id,
      targetType: "family_tree_person",
      detail: `Family tags on ${persons.length} ${persons.length === 1 ? "person" : "people"}: ${changes}.`,
      ipAddress: request.ip
    });
    const updated = persons
      .map((person) => getFamilyPerson(person.id))
      .filter((person): person is NonNullable<typeof person> => person != null);
    return reply.send({ persons: decoratePersons(user, updated) });
  });

  app.delete("/api/family-tree/persons/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const person = getFamilyPerson(personId);
    if (!person) {
      return reply.code(404).send({ error: "Person not found" });
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
    return reply.send({ deleted: true });
  });

  // ── Portrait upload (admin or branch editor) ──

  app.put("/api/family-tree/persons/:id/portrait", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      return reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      return reply.code(400).send({ error: "Portrait image is required." });
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      return reply.code(400).send({ error: "Portrait is too large (max 10 MB)." });
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
    return reply.send({ person: getFamilyPerson(personId) });
  });

  app.delete("/api/family-tree/persons/:id/portrait", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    const oldKey = getPortraitStorageKey(personId);
    // Clears both portrait sources (uploaded file and gallery item).
    setUploadedPortrait(personId, null);
    if (oldKey) {
      await fs.rm(thumbnailAbsolutePath(oldKey), { force: true }).catch(() => {});
    }
    return reply.send({ person: getFamilyPerson(personId) });
  });
}
