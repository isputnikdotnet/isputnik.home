// My list, and the titles of a Collection row (docs/video-home-rows-plan.md, R4).
// Both are home's own lists of the engine's titles, read through video_refs
// (refs.ts) so each person only ever gets the titles of libraries they may see.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../db.js";
import { currentProfileOf } from "../../profiles/store.js";
import type { EngineClient } from "./engine.js";
import { getHouseholdLayout } from "./home-layout.js";
import { VIDEO_ENTITY_TYPES, kindOfEntityType, refreshVideoRefs, visibleVideoRefs, type VideoRef, type VideoRefKind } from "./refs.js";

const titleParams = z.object({
  kind: z.enum(["movies", "shows"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
});

/** A title as a row's card needs it. */
const card = (ref: VideoRef) => ({ kind: ref.kind, id: ref.id, title: ref.title, year: ref.year, poster: ref.poster });

/** Titles in a list's order, minus those this person may not see. */
function visibleInOrder(entries: { kind: VideoRefKind; id: string }[], user: { id: string; role: string }) {
  const seen = {
    movies: visibleVideoRefs("movies", entries.filter((entry) => entry.kind === "movies").map((entry) => entry.id), user),
    shows: visibleVideoRefs("shows", entries.filter((entry) => entry.kind === "shows").map((entry) => entry.id), user)
  };
  return entries.flatMap((entry) => {
    const ref = seen[entry.kind].get(entry.id);
    return ref ? [card(ref)] : [];
  });
}

/** Whether a person may read a collection as a row: their own, or one an admin
 *  put on everyone's page — putting it there is showing it to the household,
 *  each person still seeing only the titles of their own libraries. */
export function canReadCollectionRow(collectionId: string, userId: string): boolean {
  const owned = db.prepare("SELECT 1 FROM collections WHERE id = ? AND user_id = ?").get(collectionId, userId);
  if (owned) return true;
  return getHouseholdLayout().rows.some((row) => row.type === "collection" && row.collectionId === collectionId);
}

/** Whose My list a request reads and writes: the viewing profile's while the session
 *  wears one (docs/tv-profiles-plan.md, P3), else the person's. */
function myList(request: FastifyRequest) {
  const profile = currentProfileOf(request);
  const [table, column, owner] = profile
    ? ["video_profile_my_list", "profile_id", profile.id]
    : ["video_my_list", "user_id", request.user!.id];
  return {
    entries: () => db.prepare(`SELECT kind, entity_id AS id FROM ${table} WHERE ${column} = ? ORDER BY added_at DESC, rowid DESC`)
      .all(owner) as { kind: VideoRefKind; id: string }[],
    has: (kind: VideoRefKind, id: string) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? AND kind = ? AND entity_id = ?`).get(owner, kind, id)),
    add: (kind: VideoRefKind, id: string) => db.prepare(`INSERT OR IGNORE INTO ${table} (${column}, kind, entity_id) VALUES (?, ?, ?)`).run(owner, kind, id),
    remove: (kind: VideoRefKind, id: string) => db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND kind = ? AND entity_id = ?`).run(owner, kind, id)
  };
}

export function registerVideoListRoutes(
  app: FastifyInstance,
  engine: EngineClient,
  gate: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | null
) {
  app.get("/api/video/my-list", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    return { items: visibleInOrder(myList(request).entries(), request.user!) };
  });

  app.get("/api/video/my-list/:kind/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    const { kind, id } = titleParams.parse(request.params);
    return { inList: myList(request).has(kind, id) };
  });

  app.put("/api/video/my-list/:kind/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    const { kind, id } = titleParams.parse(request.params);
    await refreshVideoRefs(engine, kind, [id]);
    // Never a way to a title of a library this person may not see.
    if (!visibleVideoRefs(kind, [id], request.user!).has(id)) return reply.code(404).send({ error: "No such title" });
    myList(request).add(kind, id);
    return { inList: true };
  });

  app.delete("/api/video/my-list/:kind/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    const { kind, id } = titleParams.parse(request.params);
    myList(request).remove(kind, id);
    return { inList: false };
  });

  // A Collection row's titles: the collection's films and shows, in its order.
  app.get("/api/video/home/collections/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = gate(request, reply);
    if (refused) return refused;
    const id = z.string().min(1).max(64).parse((request.params as { id: string }).id);
    const collection = db.prepare("SELECT name FROM collections WHERE id = ?").get(id) as { name: string } | undefined;
    if (!collection || !canReadCollectionRow(id, request.user!.id)) return reply.code(404).send({ error: "Collection not found" });
    const members = db.prepare(`
      SELECT entity_type, entity_id FROM collection_items
      WHERE collection_id = ? AND entity_type IN (?, ?) ORDER BY position
    `).all(id, VIDEO_ENTITY_TYPES.movies, VIDEO_ENTITY_TYPES.shows) as { entity_type: string; entity_id: string }[];
    const entries = members.map((member) => ({ kind: kindOfEntityType(member.entity_type)!, id: member.entity_id }));
    return { name: collection.name, items: visibleInOrder(entries, request.user!) };
  });
}
