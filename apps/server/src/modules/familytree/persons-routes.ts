import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody, parseQuery } from "../../core/shared.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "../library/shared/thumbnail.js";
import {
  partialDateSchema, GENDERS,
  listFamilyPersons, listFamilyPlaces, getFamilyPerson, getFamilyPersonProfile, getFamilyTree,
  createFamilyPerson, updateFamilyPerson, deleteFamilyPerson,
  expandToRelatives, applyFamilyPersonTags
} from "./persons.js";
import { getFamilyEventPhotos } from "./photos.js";
import {
  canUsePortraitPhoto, discardPortraitFile, portraitCropSchema, portraitFileItemId, PortraitError, portraitSourcePhoto,
  setPortraitFromPhoto, setUploadedPortraitFile
} from "./portraits.js";
import { canEditPerson, canEditTree, decoratePersons, getEditableTags, listFamilyTags } from "./access.js";
import { myTreePersonId, requireTreeView, setMyTreePerson, setShowLivingDetails, setTreeBlocked, TREE_OBJECT_ID, TREE_OBJECT_TYPE } from "./tree-access.js";
import type { FamilyUnionSummary } from "./persons.js";
import { normalizeText } from "../library/shared/tagging.js";
import { getFamilyDefaultPerson } from "./settings.js";
import { pinSchema } from "./place-pins.js";
import { getFamilyMap } from "./map.js";
import { suggestPlaces } from "../maps/places/search.js";
import { placesStatus } from "../maps/places/dataset.js";
import { placeLanguage } from "../library/gallery/places.js";
import { searchPlaces } from "../library/gallery/geocode.js";

// A marriage between restricted living relatives keeps its shape (who married
// whom) and loses its facts (tree-access.ts, D15).
function redactUnion<T extends Pick<FamilyUnionSummary, "marriedDate" | "marriedPlace" | "marriedPin" | "divorcedDate" | "note">>(union: T): T {
  return { ...union, marriedDate: null, marriedPlace: null, marriedPin: null, divorcedDate: null, note: null };
}

export const optionalDate = partialDateSchema.nullable().optional();

const personFields = {
  name: z.string().trim().min(1).max(120),
  maidenName: z.string().trim().max(120).nullable().optional(),
  // BCP 47 language codes ("ru", "uk", "zh-Hant"); blank names are dropped on save.
  otherNames: z.array(z.object({
    language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language code such as ru"),
    name: z.string().trim().max(120)
  })).max(12).optional(),
  gender: z.enum(GENDERS).optional(),
  birthDate: optionalDate,
  deathDate: optionalDate,
  birthplace: z.string().trim().max(200).nullable().optional(),
  deathPlace: z.string().trim().max(200).nullable().optional(),
  birthPin: pinSchema,
  deathPin: pinSchema,
  bio: z.string().trim().max(4000).nullable().optional(),
  deceased: z.boolean().optional()
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
    canAdd: canEditTree(user),
    // Who they are in the tree (D12): the chart opens on them and says "You".
    meId: myTreePersonId(user.id)
  });

  // Link an account to its tree person (admin; the Access dialog). Grants nothing.
  const mePersonBody = z.object({ personId: z.string().trim().min(1).max(64).nullable() });
  app.put("/api/family-tree/users/:userId/person", { preHandler: app.requireAdmin }, async (request, reply) => {
    const userId = (request.params as { userId: string }).userId;
    const account = db.prepare("SELECT display_name FROM users WHERE id = ? AND deleted_at IS NULL").get(userId) as { display_name: string } | undefined;
    if (!account) return reply.code(404).send({ error: "User not found" });
    const parsed = parseBody(mePersonBody, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid person", details: parsed.error });
    const result = setMyTreePerson(userId, parsed.data.personId, request.user!.id);
    if (result === "no-person") return reply.code(404).send({ error: "Person not found" });
    if (result === "taken") return reply.code(409).send({ error: "That person is already linked to another account." });
    const person = parsed.data.personId
      ? db.prepare("SELECT name, gallery_person_id FROM family_tree_persons WHERE id = ?").get(parsed.data.personId) as { name: string; gallery_person_id: string | null }
      : null;
    logActivity({
      event: "familytree.account.linked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: userId,
      detail: person ? `${account.display_name} is ${person.name} in the family tree.` : `${account.display_name} is no longer linked to the family tree.`,
      ipAddress: request.ip
    });
    return reply.send({ me: person ? { personId: parsed.data.personId, name: person.name, galleryPersonId: person.gallery_person_id } : null });
  });

  app.get("/api/family-tree/tree", { preHandler: [app.authenticate, requireTreeView] }, async (request) => {
    const user = request.user!;
    const tree = getFamilyTree();
    const persons = decoratePersons(user, tree.persons);
    const restricted = new Set(persons.filter((p) => p.restricted).map((p) => p.id));
    return {
      ...tree,
      persons,
      unions: tree.unions.map((u) => (restricted.has(u.person1Id) || (u.person2Id != null && restricted.has(u.person2Id)) ? redactUnion(u) : u)),
      access: accessFor(user),
      // Ships with the tree so the chart can centre on the right person in its
      // first render — a second round-trip would show the fallback, then jump.
      defaultPersonId: getFamilyDefaultPerson()?.id ?? null
    };
  });

  const personsQuerySchema = z.object({ q: z.string().optional() });

  app.get("/api/family-tree/persons", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseQuery(personsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const q = (parsed.data.q ?? "").trim();
    return { persons: decoratePersons(user, listFamilyPersons(q || undefined)), access: accessFor(user) };
  });

  app.get("/api/family-tree/persons/:id", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const profile = getFamilyPersonProfile((request.params as { id: string }).id);
    if (!profile) {
      return reply.code(404).send({ error: "Person not found" });
    }
    // Decorate the nested person summaries too, so every person object the
    // client sees carries tags/canEdit. Event photos are viewer-scoped to
    // accessible gallery libraries, like the person photo wall.
    const user = request.user!;
    const person = decoratePersons(user, [profile])[0];
    // A living relative the viewer may not see the details of: their events,
    // sources and marriages' facts stay back too (tree-access.ts, D15).
    const eventPhotos = person.restricted ? new Map() : getFamilyEventPhotos(user, profile.id);
    const redactedUnionIds = new Set<string>();
    const unions = profile.unions.map((union) => {
      const partner = union.partner ? decoratePersons(user, [union.partner])[0] : null;
      const decorated = { ...union, partner, children: decoratePersons(user, union.children) };
      if (!person.restricted && !partner?.restricted) return decorated;
      redactedUnionIds.add(union.id);
      return redactUnion(decorated);
    });
    return reply.send({
      person: {
        ...person,
        parents: decoratePersons(user, profile.parents),
        unions,
        events: person.restricted ? [] : profile.events.map((event) => ({ ...event, photos: eventPhotos.get(event.id) ?? [] })),
        // A marriage's citations go with the marriage: redacted on the card,
        // redacted on the Sources tab of the other spouse too.
        citations: person.restricted
          ? []
          : profile.citations.filter((citation) => !citation.unionId || !redactedUnionIds.has(citation.unionId))
      }
    });
  });

  // Places for the person editor's place field — only real places, from the
  // offline places database (Maps → Named places): towns that match, and the
  // tree's own places that were picked from it before (they carry its pin). Words
  // typed by hand are never offered back as suggestions; the field still accepts
  // them. Without `q`: the tree's picked places (the field's dropdown). Nothing
  // leaves the server, so it can answer as she types. `available` says whether
  // there is a places database at all, so the field can say why nothing matched.
  const placesQuerySchema = z.object({ q: z.string().max(200).optional() });

  app.get("/api/family-tree/places", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const parsed = parseQuery(placesQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const q = (parsed.data.q ?? "").trim();
    const available = placesStatus().present;
    const known = listFamilyPlaces().filter((place) => place.pin);
    if (!q) {
      return reply.send({ available, known: known.slice(0, 50), towns: [] });
    }
    const folded = q.toLocaleLowerCase();
    return reply.send({
      available,
      known: known.filter((place) => place.label.toLocaleLowerCase().includes(folded)).slice(0, 5),
      towns: q.length >= 2 ? suggestPlaces(q, placeLanguage(request)) : []
    });
  });

  // The same lookup Review mode offers a photo, for a place the offline database
  // does not hold — a village, a parish, a street. Not search-as-you-type:
  // OpenStreetMap’s policy forbids that, and this is the moment what she typed
  // leaves the house, so it is one request per press of a button. Rate-limited
  // well below the global ceiling for the same reason the gallery’s is.
  app.get(
    "/api/family-tree/places/online",
    { preHandler: [app.authenticate, requireTreeView], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = parseQuery(placesQuerySchema, request.query);
      if (parsed.error) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }
      const q = (parsed.data.q ?? "").trim();
      if (q.length < 2) {
        return reply.code(400).send({ error: "Type at least two characters to search for a place." });
      }
      try {
        return reply.send({ results: await searchPlaces(q) });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "The place lookup failed." });
      }
    }
  );

  // The family map: every pinned birth, death, marriage and life event, plus how
  // many places have no pin yet. Read-only, like the tree.
  app.get("/api/family-tree/map", { preHandler: [app.authenticate, requireTreeView] }, async (request) => {
    // What happened to a restricted living relative is not the viewer's to see.
    const restricted = new Set(decoratePersons(request.user!, listFamilyPersons()).filter((p) => p.restricted).map((p) => p.id));
    const map = getFamilyMap();
    return restricted.size === 0 ? map : { ...map, entries: map.entries.filter((entry) => !entry.personIds.some((id) => restricted.has(id))) };
  });

  // ── Who sees the tree (admin; docs/people-sharing-plan.md, D14/D15) ──
  //
  // canSee: false blocks the tree for a user or group; true lifts it.
  // showLivingDetails: whether living relatives' details show for them.
  const viewerSettings = z.object({ canSee: z.boolean().optional(), showLivingDetails: z.boolean().optional() });
  app.put("/api/family-tree/viewers/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { subjectType, subjectId } = request.params as { subjectType: string; subjectId: string };
    if (subjectType !== "user" && subjectType !== "group") return reply.code(400).send({ error: "Invalid subject" });
    const parsed = parseBody(viewerSettings, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    const exists = subjectType === "user"
      ? db.prepare("SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL").get(subjectId)
      : db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(subjectId);
    if (!exists) return reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });
    const subject = { subjectType, subjectId } as const;
    if (parsed.data.canSee !== undefined) setTreeBlocked(subject, !parsed.data.canSee, request.user!.id);
    if (parsed.data.showLivingDetails !== undefined) setShowLivingDetails(subject, parsed.data.showLivingDetails);
    logActivity({
      event: "familytree.access.changed",
      actorUserId: request.user!.id,
      targetType: subjectType,
      targetId: subjectId,
      detail: [
        parsed.data.canSee === undefined ? "" : parsed.data.canSee ? "can see the family tree" : "can no longer see the family tree",
        parsed.data.showLivingDetails === undefined ? "" : parsed.data.showLivingDetails ? "sees living relatives' details" : "no longer sees living relatives' details"
      ].filter(Boolean).join("; "),
      ipAddress: request.ip
    });
    const blocked = db.prepare("SELECT 1 FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ? AND role = 'deny'")
      .get(subjectType, subjectId, TREE_OBJECT_TYPE, TREE_OBJECT_ID) != null;
    return reply.send({ canSee: !blocked });
  });

  // "Mark as deceased" for a selection (D16): the people with no dates at all are
  // the ones who need it, and there can be dozens.
  const deceasedSchema = z.object({ personIds: z.array(z.string().trim().min(1)).min(1).max(2000), deceased: z.boolean() });
  app.post("/api/family-tree/persons/deceased", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(deceasedSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid selection", details: parsed.error });
    const mark = db.prepare("UPDATE family_tree_persons SET deceased = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    let changed = 0;
    db.transaction(() => { for (const id of new Set(parsed.data.personIds)) changed += mark.run(parsed.data.deceased ? 1 : 0, id).changes; })();
    logActivity({
      event: "familytree.persons.deceased",
      actorUserId: request.user!.id,
      targetType: "family_tree_person",
      detail: `${parsed.data.deceased ? "Marked" : "Unmarked"} ${changed} family ${changed === 1 ? "member" : "members"} as deceased.`,
      ipAddress: request.ip
    });
    return reply.send({ changed, persons: decoratePersons(request.user!, parsed.data.personIds.map((id) => getFamilyPerson(id)).filter((p): p is NonNullable<typeof p> => p != null)) });
  });

  // Family-tag listing: feeds the person-edit autocomplete, the people-page
  // filter, and the admin branch-access modal (editorCount). The library tag
  // browse counts only library_item taggables, so family tags need their own.
  app.get("/api/family-tree/tags", { preHandler: [app.authenticate, requireTreeView] }, async () => ({
    tags: listFamilyTags()
  }));

  // ── Persons (admin or branch editor) ──

  app.post("/api/family-tree/persons", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
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

  app.patch("/api/family-tree/persons/:id", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
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
    const { portraitItemId, ...fields } = parsed.data;
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    // A gallery portrait is rendered into the tree's own storage (portraits.ts):
    // cut to the linked face when the photo shows it, else the whole photo.
    if (portraitItemId) {
      if (!canUsePortraitPhoto(user, portraitItemId)) {
        return reply.code(404).send({ error: "Gallery item not found" });
      }
      try {
        await setPortraitFromPhoto(personId, portraitItemId, null, user.id);
      } catch (err) {
        if (err instanceof PortraitError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    } else if (portraitItemId === null) {
      await setUploadedPortraitFile(personId, null, user.id);
    }
    const person = updateFamilyPerson(personId, fields);
    if (!person) {
      return reply.code(404).send({ error: "Person not found" });
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

  app.post("/api/family-tree/persons/relatives", { preHandler: [app.authenticate, requireTreeView], config: { previewSafe: true } }, async (request, reply) => {
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
    const fileItemId = portraitFileItemId(personId);
    const { portraitKey } = deleteFamilyPerson(personId);
    if (portraitKey) {
      await fs.rm(thumbnailAbsolutePath(portraitKey), { force: true }).catch(() => {});
    }
    if (fileItemId) discardPortraitFile(fileItemId, request.user!.id);
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

  // ── Portrait cut from a gallery photo (admin or branch editor) ──
  //
  // `crop` is a frame in fractions of the photo as shown (orientation and
  // rotation applied), the same frame face boxes come in. The cut portrait is
  // also kept in App files → Family tree → Portraits when App storage is on.

  const portraitCropBody = z.object({
    itemId: z.string().trim().min(1),
    crop: portraitCropSchema
  });

  app.post("/api/family-tree/persons/:id/portrait/crop", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const user = request.user!;
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(portraitCropBody, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid portrait", details: parsed.error });
    }
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (!canEditPerson(user, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    if (!canUsePortraitPhoto(user, parsed.data.itemId)) {
      return reply.code(404).send({ error: "Gallery item not found" });
    }
    try {
      const { keptInAppFiles } = await setPortraitFromPhoto(personId, parsed.data.itemId, parsed.data.crop, user.id);
      return reply.send({ person: decoratePersons(user, [getFamilyPerson(personId)!])[0], keptInAppFiles });
    } catch (err) {
      if (err instanceof PortraitError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // The photo a portrait is re-cut from. An uploaded portrait has none until its
  // image is kept in App files on the first Adjust (portraits.ts).
  app.post("/api/family-tree/persons/:id/portrait/source", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    try {
      return reply.send({ itemId: await portraitSourcePhoto(personId) });
    } catch (err) {
      if (err instanceof PortraitError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // ── Portrait upload (admin or branch editor) ──

  app.put("/api/family-tree/persons/:id/portrait", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
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

    await setUploadedPortraitFile(personId, storageKey, request.user!.id);
    return reply.send({ person: getFamilyPerson(personId) });
  });

  app.delete("/api/family-tree/persons/:id/portrait", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getFamilyPerson(personId)) {
      return reply.code(404).send({ error: "Person not found" });
    }
    if (!canEditPerson(request.user!, personId)) {
      return reply.code(403).send({ error: "You can only edit family members in a branch you have edit rights on." });
    }
    // Clears the portrait, its gallery source and its App files copy.
    await setUploadedPortraitFile(personId, null, request.user!.id);
    return reply.send({ person: getFamilyPerson(personId) });
  });
}
