// Managing photos shared by person (docs/people-sharing-plan.md, phase 1): grant
// or withdraw a person for a user or group, the recipient's "Show where photos
// were taken", reviewing a person's automatic matches before they share (D6), and
// "Don't share this photo". The Access dialog (phase 2) is built on these.
//
// Admins only, except the exclusion, which a manager of the photo's library may
// set too. Every change is an activity event, so the log says who shared what.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { canUserManageLibraryMembers, getLibraryForBook } from "../shared/library-access.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog-asset.js";
import { confirmPersonPhotos, getGalleryPersonRow } from "./people.js";
import {
  accessSettingsOf, directPersonGrants, isShareExcluded, personGrantSubjects, personReviewItemIds,
  personShareCounts, setPersonGrant, setShareExcluded, setShowLocation, sharedPeopleFor, sharedPhotoCount
} from "./people-access.js";
import type { GroupMemberRow, UserGroupRow, UserRow } from "../../../db/rows.js";

type SubjectType = "user" | "group";

const subjectParams = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64)
});

/** The subject's display name, or null when it does not exist (or is deleted). */
function subjectName(subjectType: SubjectType, subjectId: string): string | null {
  if (subjectType === "user") {
    const row = db.prepare("SELECT display_name FROM users WHERE id = ? AND deleted_at IS NULL").get(subjectId) as Pick<UserRow, "display_name"> | undefined;
    return row?.display_name ?? null;
  }
  const row = db.prepare("SELECT name FROM user_groups WHERE id = ?").get(subjectId) as Pick<UserGroupRow, "name"> | undefined;
  return row?.name ?? null;
}

function personName(personId: string): string {
  return (db.prepare("SELECT name FROM gallery_people WHERE id = ?").get(personId) as { name: string } | undefined)?.name ?? "";
}

// Photos by id, in the order asked, for the review grid. The caller is an admin,
// who reaches every library a grant can.
function assetsByIds(userId: string, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id IN (SELECT value FROM json_each(?)) AND library_items.deleted_at IS NULL
  `).all(userId, JSON.stringify(itemIds)) as GalleryAssetRow[];
  const byId = new Map(rows.map((row) => [row.id, mapAsset(row)]));
  return itemIds.map((id) => byId.get(id)).filter((asset): asset is NonNullable<typeof asset> => asset != null);
}

export async function galleryPeopleAccessRoutesPlugin(app: FastifyInstance) {
  // ── From the person's side: who can see photos of them ──

  app.get("/api/library/gallery/people/:id/sharing", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const person = getGalleryPersonRow(personId);
    if (!person) return reply.code(404).send({ error: "Person not found" });
    const subjects = personGrantSubjects(personId)
      .map((subject) => ({ ...subject, name: subjectName(subject.subjectType, subject.subjectId) }))
      .filter((subject): subject is typeof subject & { name: string } => subject.name != null);
    return reply.send({ person: { id: person.id, name: person.name }, counts: personShareCounts(personId), subjects });
  });

  const grantHandler = (granted: boolean) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const { id: personId, ...rest } = request.params as { id: string; subjectType: string; subjectId: string };
    const parsed = subjectParams.safeParse(rest);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subject" });
    const { subjectType, subjectId } = parsed.data;
    const name = subjectName(subjectType, subjectId);
    if (!name) return reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });
    if (!setPersonGrant({ subjectType, subjectId }, personId, granted, request.user!.id)) {
      return reply.code(404).send({ error: "Only a named person in the gallery can be shared." });
    }
    logActivity({
      event: granted ? "access.person.granted" : "access.person.revoked",
      actorUserId: request.user!.id,
      targetType: subjectType,
      targetId: subjectId,
      detail: granted
        ? `Shared photos of ${personName(personId)} with ${name}.`
        : `Stopped sharing photos of ${personName(personId)} with ${name}.`,
      ipAddress: request.ip
    });
    return reply.send({ subjects: personGrantSubjects(personId), counts: personShareCounts(personId) });
  };
  app.put("/api/library/gallery/people/:id/sharing/:subjectType/:subjectId", { preHandler: app.requireAdmin }, grantHandler(true));
  app.delete("/api/library/gallery/people/:id/sharing/:subjectType/:subjectId", { preHandler: app.requireAdmin }, grantHandler(false));

  // ── From the recipient's side: the people shared with a user or group ──

  app.get("/api/library/gallery/access/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = subjectParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subject" });
    const { subjectType, subjectId } = parsed.data;
    const name = subjectName(subjectType, subjectId);
    if (!name) return reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });

    // Direct grants, then — for a person — what each of their groups gives.
    const direct = new Set(directPersonGrants({ subjectType, subjectId }));
    const via = new Map<string, { id: string; name: string }[]>();
    if (subjectType === "user") {
      const groups = db.prepare(`
        SELECT g.id, g.name FROM group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.user_id = ?
      `).all(subjectId) as (Pick<GroupMemberRow, "group_id"> & Pick<UserGroupRow, "id" | "name">)[];
      for (const group of groups) {
        for (const personId of directPersonGrants({ subjectType: "group", subjectId: group.id })) {
          via.set(personId, [...(via.get(personId) ?? []), { id: group.id, name: group.name }]);
        }
      }
    }
    const personIds = [...new Set([...direct, ...via.keys()])];
    const people = personIds
      .map((personId) => ({
        id: personId,
        name: personName(personId),
        direct: direct.has(personId),
        viaGroups: via.get(personId) ?? [],
        counts: personShareCounts(personId)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // What they actually see: for a person, after denies and every group; for a
    // group, what its own grants reach.
    const effective = subjectType === "user"
      ? sharedPeopleFor({ id: subjectId, role: (db.prepare("SELECT role FROM users WHERE id = ?").get(subjectId) as Pick<UserRow, "role">).role })
      : [...direct];
    return reply.send({
      subject: { subjectType, subjectId, name },
      people,
      settings: accessSettingsOf({ subjectType, subjectId }),
      photoCount: sharedPhotoCount(effective)
    });
  });

  const settingsBody = z.object({ showLocation: z.boolean() });

  app.put("/api/library/gallery/access/:subjectType/:subjectId/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = subjectParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid subject" });
    const parsed = parseBody(settingsBody, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    const { subjectType, subjectId } = params.data;
    const name = subjectName(subjectType, subjectId);
    if (!name) return reply.code(404).send({ error: subjectType === "user" ? "User not found" : "Group not found" });
    setShowLocation({ subjectType, subjectId }, parsed.data.showLocation);
    logActivity({
      event: "access.settings.changed",
      actorUserId: request.user!.id,
      targetType: subjectType,
      targetId: subjectId,
      detail: parsed.data.showLocation
        ? `${name} now sees where shared photos were taken.`
        : `${name} no longer sees where shared photos were taken.`,
      ipAddress: request.ip
    });
    return reply.send({ settings: accessSettingsOf({ subjectType, subjectId }) });
  });

  // ── Review before sharing (D6) ──

  const pageQuery = z.object({ limit: z.string().optional(), offset: z.string().optional() });

  app.get("/api/library/gallery/people/:id/review", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    if (!getGalleryPersonRow(personId)) return reply.code(404).send({ error: "Person not found" });
    const parsed = parseQuery(pageQuery, request.query);
    if (parsed.error) return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    const limit = Math.min(Math.max(Number.parseInt(parsed.data.limit ?? "60", 10) || 60, 1), 200);
    const offset = Math.max(Number.parseInt(parsed.data.offset ?? "0", 10) || 0, 0);
    const { itemIds, total } = personReviewItemIds(personId, limit, offset);
    return reply.send({ assets: assetsByIds(request.user!.id, itemIds), total });
  });

  const confirmBody = z.object({
    confirm: z.array(z.string().trim().min(1)).max(500).default([]),
    reject: z.array(z.string().trim().min(1)).max(500).default([])
  });

  app.post("/api/library/gallery/people/:id/confirm", { preHandler: app.requireAdmin }, async (request, reply) => {
    const personId = (request.params as { id: string }).id;
    const parsed = parseBody(confirmBody, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid review", details: parsed.error });
    const result = confirmPersonPhotos(personId, parsed.data.confirm, parsed.data.reject);
    if (!result) return reply.code(404).send({ error: "Person not found" });
    if (result.confirmed + result.rejected > 0) {
      logActivity({
        event: "gallery.people.reviewed",
        actorUserId: request.user!.id,
        targetType: "gallery_person",
        targetId: personId,
        detail: `Reviewed photos of ${personName(personId)}: ${result.confirmed} confirmed, ${result.rejected} not them.`,
        ipAddress: request.ip
      });
    }
    return reply.send({ ...result, counts: personShareCounts(personId) });
  });

  // ── "Don't share this photo" ──

  const exclusionHandler = (excluded: boolean) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const itemId = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(itemId);
    if (!lib || lib.type !== "gallery") return reply.code(404).send({ error: "Photo not found" });
    if (!canUserManageLibraryMembers(lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Only an admin or a manager of this library can change who a photo is shared with." });
    }
    setShareExcluded(itemId, excluded, user.id);
    logActivity({
      event: excluded ? "gallery.share.excluded" : "gallery.share.included",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: itemId,
      detail: excluded ? "Kept a photo out of sharing by person." : "Let a photo be shared by person again.",
      ipAddress: request.ip
    });
    return reply.send({ excluded: isShareExcluded(itemId) });
  };
  app.put("/api/library/gallery/assets/:id/share-exclusion", { preHandler: app.authenticate }, exclusionHandler(true));
  app.delete("/api/library/gallery/assets/:id/share-exclusion", { preHandler: app.authenticate }, exclusionHandler(false));
}
