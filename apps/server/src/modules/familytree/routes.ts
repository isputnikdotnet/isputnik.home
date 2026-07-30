// Family-tree API. Read endpoints are open to every signed-in user. Mutations
// are admin-only by default, with a tag-scoped exception: a user granted edit
// rights on a family tag (see access.ts) may edit tagged persons and add
// relatives to them. Destructive restructuring (deleting people, removing
// relationships), GEDCOM import, sources, and tag assignment stay admin-only.
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
import {
  attachFamilyPhotos, detachFamilyPhoto, getFamilyPersonPhotos,
  attachFamilyEventPhotos, detachFamilyEventPhoto, getFamilyEventPhotos
} from "./photos.js";
import {
  FAMILY_TAG_OBJECT_TYPE,
  canEditAnyPerson, canEditPerson, canEditTree, decoratePersons, getEditableTags, listFamilyTags
} from "./access.js";
import { normalizeText } from "../library/audiobook/categorize.js";
import { getFamilyUploadLibrary, setFamilyTreeSettings } from "./settings.js";
import { can, parsePolicy } from "../../core/permissions.js";
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

const tagsSchema = z.array(z.string().trim().min(1).max(120)).max(50);
const createPersonSchema = z.object({ ...personFields, tags: tagsSchema.optional() });
const updatePersonSchema = z.object({
  ...personFields,
  name: personFields.name.optional(),
  galleryPersonId: z.string().trim().min(1).nullable().optional(),
  portraitItemId: z.string().trim().min(1).nullable().optional(),
  tags: tagsSchema.optional()
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

  // `access` tells the client what to offer: admins see everything, branch
  // editors see edit affordances on their tagged persons plus "Add person".
  const accessFor = (user: { id: string; role: string }) => ({
    isAdmin: user.role === "admin",
    canAdd: canEditTree(user)
  });

  app.get("/api/family-tree/tree", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const tree = getFamilyTree();
    return { ...tree, persons: decoratePersons(user, tree.persons), access: accessFor(user) };
  });

  app.get("/api/family-tree/persons", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const q = String((request.query as { q?: string }).q ?? "").trim();
    return { persons: decoratePersons(user, listFamilyPersons(q || undefined)), access: accessFor(user) };
  });

  app.get("/api/family-tree/persons/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const profile = getFamilyPersonProfile((request.params as { id: string }).id);
    if (!profile) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    // Decorate the nested person summaries too, so every person object the
    // client sees carries tags/canEdit. Event photos are viewer-scoped to
    // accessible gallery libraries, like the person photo wall.
    const user = request.user!;
    const eventPhotos = getFamilyEventPhotos(user, profile.id);
    reply.send({
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

  // ── Settings ──
  // Read is open: the photo picker needs to know where uploads go (and whether
  // the viewer may upload there at all) before it offers the option.
  app.get("/api/family-tree/settings", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const library = getFamilyUploadLibrary();
    let canUpload = false;
    if (library) {
      const row = db.prepare("SELECT id, policy_json FROM libraries WHERE id = ?")
        .get(library.id) as { id: string; policy_json: string } | undefined;
      if (row) {
        canUpload = can(user, { objectType: "library", objectId: row.id, policy: parsePolicy(row.policy_json) }, "upload");
      }
    }
    return {
      galleryLibrary: library,
      canUpload,
      isAdmin: user.role === "admin"
    };
  });

  const settingsSchema = z.object({
    galleryLibraryId: z.string().trim().min(1).nullable()
  });

  app.put("/api/family-tree/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid settings", details: parsed.error });
      return;
    }
    const { galleryLibraryId } = parsed.data;
    if (galleryLibraryId) {
      const exists = db.prepare("SELECT 1 FROM libraries WHERE id = ? AND type = 'gallery'").get(galleryLibraryId);
      if (!exists) {
        reply.code(404).send({ error: "Gallery library not found" });
        return;
      }
    }
    setFamilyTreeSettings({ galleryLibraryId }, request.user!.id);
    logActivity({
      event: "familytree.settings.updated",
      actorUserId: request.user!.id,
      targetType: "family_tree",
      detail: galleryLibraryId
        ? "Set the gallery library family-tree uploads are added to."
        : "Cleared the gallery library for family-tree uploads.",
      ipAddress: request.ip
    });
    reply.send({ galleryLibrary: getFamilyUploadLibrary() });
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

  // ── Persons (admin or branch editor) ──

  app.post("/api/family-tree/persons", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createPersonSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid person", details: parsed.error });
      return;
    }
    let tags = parsed.data.tags;
    if (user.role !== "admin") {
      const editable = getEditableTags(user);
      if (editable === "all" || editable.length === 0) {
        reply.code(403).send({ error: "You don't have permission to add family members." });
        return;
      }
      // A branch editor's new person must carry a tag they can edit through —
      // otherwise it would be immediately un-editable for them. They may pick a
      // subset of their editable tags; anything else is rejected.
      const editableByKey = new Map(editable.map((t) => [t.key, t.name]));
      if (tags !== undefined) {
        const keys = tags.map(normalizeText);
        if (keys.length === 0 || keys.some((key) => !editableByKey.has(key))) {
          reply.code(403).send({ error: "New family members can only carry tags you have edit rights on." });
          return;
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
    reply.code(201).send({ person: decoratePersons(user, [person])[0] });
  });

  app.patch("/api/family-tree/persons/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(updatePersonSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    if (user.role !== "admin") {
      // Tags are the permission boundary and the gallery link bridges to face
      // clusters — both stay admin-only even inside an editable branch.
      if (parsed.data.tags !== undefined || parsed.data.galleryPersonId !== undefined) {
        reply.code(403).send({ error: "Only admins can change tags or gallery links." });
        return;
      }
      if (!canEditPerson(user, personId)) {
        reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
        return;
      }
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
    reply.send({ person: decoratePersons(user, [person])[0] });
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

  // ── Portrait upload (admin or branch editor) ──

  app.put("/api/family-tree/persons/:id/portrait", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    if (!canEditPerson(request.user!, personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
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

  app.delete("/api/family-tree/persons/:id/portrait", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    if (!canEditPerson(request.user!, personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
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

  // ── Unions (admin or branch editor) ──
  // A branch editor may create or edit a union when at least one involved
  // person is theirs to edit — that is how a spouse from another (or no)
  // branch marries into the family.

  app.post("/api/family-tree/unions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createUnionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid union", details: parsed.error });
      return;
    }
    const { person1Id, person2Id, ...fields } = parsed.data;
    if (!canEditAnyPerson(request.user!, [person1Id, person2Id])) {
      reply.code(403).send({ error: "You can only add relationships for family members in a branch you have edit rights on." });
      return;
    }
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
  app.patch("/api/family-tree/unions/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(updateUnionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const unionId = (request.params as { id: string }).id;
    const { person2Id, ...fields } = parsed.data;
    const existing = getUnion(unionId);
    if (!existing) {
      reply.code(404).send({ error: "Union not found" });
      return;
    }
    if (!canEditAnyPerson(request.user!, [existing.person1Id, existing.person2Id, person2Id])) {
      reply.code(403).send({ error: "You can only edit relationships of family members in a branch you have edit rights on." });
      return;
    }
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

  // ── Children (admin or branch editor) ──

  app.post("/api/family-tree/unions/:id/children", { preHandler: app.authenticate }, async (request, reply) => {
    const unionId = (request.params as { id: string }).id;
    const parsed = parseBody(addChildSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid child link", details: parsed.error });
      return;
    }
    const union = getUnion(unionId);
    if (!union) {
      reply.code(404).send({ error: "Union not found" });
      return;
    }
    if (!canEditAnyPerson(request.user!, [union.person1Id, union.person2Id, parsed.data.childId])) {
      reply.code(403).send({ error: "You can only add relationships for family members in a branch you have edit rights on." });
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

  // ── Life events (admin or branch editor) ──

  app.post("/api/family-tree/persons/:id/events", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createEventSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid event", details: parsed.error });
      return;
    }
    const personId = (request.params as { id: string }).id;
    if (!canEditPerson(request.user!, personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    const event = createFamilyEvent(personId, parsed.data);
    if (!event) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }
    reply.code(201).send({ event });
  });

  app.patch("/api/family-tree/events/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(updateEventSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const existing = getFamilyEvent((request.params as { id: string }).id);
    if (!existing) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    if (!canEditPerson(request.user!, existing.personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    const event = updateFamilyEvent(existing.id, parsed.data);
    reply.send({ event });
  });

  app.delete("/api/family-tree/events/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const existing = getFamilyEvent((request.params as { id: string }).id);
    if (!existing) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    if (!canEditPerson(request.user!, existing.personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    deleteFamilyEvent(existing.id);
    reply.send({ deleted: true });
  });

  // ── Event photo attachments (admin or branch editor, via the event's person) ──

  app.post("/api/family-tree/events/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const event = getFamilyEvent((request.params as { id: string }).id);
    if (!event) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    const parsed = parseBody(attachPhotosSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid photo selection", details: parsed.error });
      return;
    }
    if (!canEditPerson(request.user!, event.personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    const result = attachFamilyEventPhotos(event.id, parsed.data.itemIds, request.user!.id);
    if ("error" in result) {
      reply.code(404).send({ error: result.error === "event_not_found" ? "Event not found" : "Gallery item not found" });
      return;
    }
    reply.send({ attached: result.attached });
  });

  app.delete("/api/family-tree/events/:id/photos/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: eventId, itemId } = request.params as { id: string; itemId: string };
    const event = getFamilyEvent(eventId);
    if (!event) {
      reply.code(404).send({ error: "Event not found" });
      return;
    }
    if (!canEditPerson(request.user!, event.personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    if (!detachFamilyEventPhoto(eventId, itemId)) {
      reply.code(404).send({ error: "Attachment not found" });
      return;
    }
    reply.send({ removed: true });
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
      reply.code(400).send({ error: "Invalid citation", details: parsed.error });
      return;
    }
    if (!canEditCitationTarget(request.user!, parsed.data)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
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

  app.patch("/api/family-tree/citations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(updateCitationSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid changes", details: parsed.error });
      return;
    }
    const existing = getFamilyCitation((request.params as { id: string }).id);
    if (!existing) {
      reply.code(404).send({ error: "Citation not found" });
      return;
    }
    if (!canEditCitationTarget(request.user!, existing)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    const citation = updateFamilyCitation(existing.id, parsed.data);
    reply.send({ citation });
  });

  app.delete("/api/family-tree/citations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const existing = getFamilyCitation((request.params as { id: string }).id);
    if (!existing) {
      reply.code(404).send({ error: "Citation not found" });
      return;
    }
    if (!canEditCitationTarget(request.user!, existing)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    deleteFamilyCitation(existing.id);
    reply.send({ deleted: true });
  });

  // ── Photo attachments (admin or branch editor) ──

  app.post("/api/family-tree/persons/:id/photos", { preHandler: app.authenticate }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(attachPhotosSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid photo selection", details: parsed.error });
      return;
    }
    if (!canEditPerson(request.user!, personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
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

  app.delete("/api/family-tree/persons/:id/photos/:itemId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: personId, itemId } = request.params as { id: string; itemId: string };
    if (!canEditPerson(request.user!, personId)) {
      reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
      return;
    }
    if (!detachFamilyPhoto(personId, itemId)) {
      reply.code(404).send({ error: "Attachment not found" });
      return;
    }
    reply.send({ removed: true });
  });

  // ── Branch access (admin) ──
  // Assignments with object_type 'family_tree_tag' grant a user or group edit
  // rights over every person carrying the tag. Same pattern as library members.

  const editorGrantSchema = z.object({
    subjectType: z.enum(["user", "group"]),
    subjectId: z.string().trim().min(1),
    role: z.enum(["contributor", "deny"])
  });

  const getTag = (tagId: string) =>
    db.prepare("SELECT id, display_name AS name FROM tags WHERE id = ?").get(tagId) as { id: string; name: string } | undefined;

  app.get("/api/family-tree/tags/:tagId/editors", { preHandler: app.requireAdmin }, async (request, reply) => {
    const tag = getTag((request.params as { tagId: string }).tagId);
    if (!tag) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }
    const editors = db.prepare(`
      SELECT a.subject_type AS subjectType, a.subject_id AS subjectId, a.role, a.created_at AS createdAt,
        COALESCE(u.display_name, g.name) AS name,
        u.email AS email,
        ((a.subject_type = 'user' AND u.id IS NULL) OR (a.subject_type = 'group' AND g.id IS NULL)) AS missing
      FROM assignments a
      LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
      LEFT JOIN user_groups g ON a.subject_type = 'group' AND g.id = a.subject_id
      WHERE a.object_type = '${FAMILY_TAG_OBJECT_TYPE}' AND a.object_id = ?
      ORDER BY a.subject_type, name COLLATE NOCASE
    `).all(tag.id);
    reply.send({ tag, editors });
  });

  app.post("/api/family-tree/tags/:tagId/editors", { preHandler: app.requireAdmin }, async (request, reply) => {
    const tag = getTag((request.params as { tagId: string }).tagId);
    if (!tag) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }
    const parsed = parseBody(editorGrantSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid grant", details: parsed.error });
      return;
    }
    const { subjectType, subjectId, role } = parsed.data;
    const subjectTable = subjectType === "user" ? "users" : "user_groups";
    if (!db.prepare(`SELECT 1 FROM ${subjectTable} WHERE id = ?`).get(subjectId)) {
      reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });
      return;
    }
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, '${FAMILY_TAG_OBJECT_TYPE}', ?, ?, ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role, created_by = excluded.created_by
    `).run(subjectType, subjectId, tag.id, role, request.user!.id);
    logActivity({
      event: "familytree.editor.granted",
      actorUserId: request.user!.id,
      targetType: "family_tree_tag",
      targetId: tag.id,
      detail: `Granted ${role === "deny" ? "an edit block" : "edit rights"} on family tag "${tag.name}" to a ${subjectType}.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ granted: true });
  });

  app.delete("/api/family-tree/tags/:tagId/editors/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { tagId, subjectType, subjectId } = request.params as { tagId: string; subjectType: string; subjectId: string };
    const tag = getTag(tagId);
    if (!tag || (subjectType !== "user" && subjectType !== "group")) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }
    const res = db.prepare(
      `DELETE FROM assignments WHERE object_type = '${FAMILY_TAG_OBJECT_TYPE}' AND object_id = ? AND subject_type = ? AND subject_id = ?`
    ).run(tag.id, subjectType, subjectId);
    if (res.changes === 0) {
      reply.code(404).send({ error: "Grant not found" });
      return;
    }
    logActivity({
      event: "familytree.editor.revoked",
      actorUserId: request.user!.id,
      targetType: "family_tree_tag",
      targetId: tag.id,
      detail: `Revoked edit rights on family tag "${tag.name}" from a ${subjectType}.`,
      ipAddress: request.ip
    });
    reply.send({ revoked: true });
  });
}
