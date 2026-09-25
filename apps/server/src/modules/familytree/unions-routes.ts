import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import {
  UNION_STATUSES, CHILD_RELATIONS, type RelationError,
  getUnion, createUnion, updateUnion, setUnionPartner, deleteUnion, addChild, removeChild
} from "./relations.js";
import { canEditAnyPerson } from "./access.js";
import { optionalDate } from "./persons-routes.js";
import { pinSchema } from "./place-pins.js";
import { requireTreeView } from "./tree-access.js";
import { db } from "../../db.js";
import type { AuthUser } from "../../core/permissions.js";

// A family a branch editor may change: one with a partner or a child in their
// branch. "Add relatives to them" attaches people to the editor's own families;
// it never reaches into a family that has nobody of theirs in it.
function canEditUnion(user: AuthUser, union: { id: string; person1Id: string; person2Id: string | null }): boolean {
  if (user.role === "admin") return true;
  const childIds = (db.prepare("SELECT child_id FROM family_tree_children WHERE union_id = ?").all(union.id) as { child_id: string }[])
    .map((row) => row.child_id);
  return canEditAnyPerson(user, [union.person1Id, union.person2Id, ...childIds]);
}

const RELATION_ERRORS: Record<RelationError, { code: number; message: string }> = {
  person_not_found: { code: 404, message: "Person not found" },
  union_not_found: { code: 404, message: "Union not found" },
  same_person: { code: 400, message: "A union needs two different people." },
  child_is_partner: { code: 400, message: "A person can't be a child of their own union." },
  child_has_parents: { code: 409, message: "This person already has parents. Remove them from their current family first." },
  union_has_partner: { code: 409, message: "This family already has two parents." },
  already_partners: { code: 409, message: "These two are already recorded as a couple. Edit that relationship instead." },
  would_create_cycle: { code: 400, message: "This link would make someone their own ancestor." }
};

const unionFieldsSchema = z.object({
  status: z.enum(UNION_STATUSES).optional(),
  marriedDate: optionalDate,
  marriedPlace: z.string().trim().max(200).nullable().optional(),
  marriedPin: pinSchema,
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

export function registerUnionRoutes(app: FastifyInstance) {
  // ── Unions (admin or branch editor) ──
  // A branch editor may create or edit a union when at least one involved
  // person is theirs to edit — that is how a spouse from another (or no)
  // branch marries into the family.

  app.post("/api/family-tree/unions", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const parsed = parseBody(createUnionSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid union", details: parsed.error });
    }
    const { person1Id, person2Id, ...fields } = parsed.data;
    if (!canEditAnyPerson(request.user!, [person1Id, person2Id])) {
      return reply.code(403).send({ error: "You can only add relationships for family members in a branch you have edit rights on." });
    }
    const result = createUnion(person1Id, person2Id ?? null, fields);
    if ("error" in result) {
      const err = RELATION_ERRORS[result.error];
      return reply.code(err.code).send({ error: err.message });
    }
    return reply.code(201).send({ union: result.union });
  });

  // `person2Id` fills the empty partner slot of a single-parent union (the
  // "add the other parent" flow); the field updates apply in the same request.
  app.patch("/api/family-tree/unions/:id", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const parsed = parseBody(updateUnionSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid changes", details: parsed.error });
    }
    const unionId = (request.params as { id: string }).id;
    const { person2Id, ...fields } = parsed.data;
    const existing = getUnion(unionId);
    if (!existing) {
      return reply.code(404).send({ error: "Union not found" });
    }
    // The family being changed must already be the editor's — a partner or a
    // child of it in their branch — not merely the person they are putting into
    // it: otherwise any single parent in the tree could be handed a branch
    // person as the other parent, and their children with them.
    if (!canEditUnion(request.user!, existing)) {
      return reply.code(403).send({ error: "You can only edit relationships of family members in a branch you have edit rights on." });
    }
    // Filling the slot can fold this union into the couple's existing one, so
    // the field changes go to whichever union remains.
    let targetId = unionId;
    if (person2Id) {
      const result = setUnionPartner(unionId, person2Id);
      if ("error" in result) {
        const err = RELATION_ERRORS[result.error];
        return reply.code(err.code).send({ error: err.message });
      }
      targetId = result.union.id;
    }
    const union = updateUnion(targetId, fields);
    if (!union) {
      return reply.code(404).send({ error: "Union not found" });
    }
    return reply.send({ union });
  });

  app.delete("/api/family-tree/unions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    if (!deleteUnion((request.params as { id: string }).id)) {
      return reply.code(404).send({ error: "Union not found" });
    }
    return reply.send({ deleted: true });
  });

  // ── Children (admin or branch editor) ──

  app.post("/api/family-tree/unions/:id/children", { preHandler: [app.authenticate, requireTreeView] }, async (request, reply) => {
    const unionId = (request.params as { id: string }).id;
    const parsed = parseBody(addChildSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid child link", details: parsed.error });
    }
    const union = getUnion(unionId);
    if (!union) {
      return reply.code(404).send({ error: "Union not found" });
    }
    // Same rule as filling a partner slot: the family gaining a child must be the
    // editor's own (a parent or a sibling-to-be in their branch), so a branch
    // person cannot be hung under strangers' parents.
    if (!canEditUnion(request.user!, union)) {
      return reply.code(403).send({ error: "You can only add relationships for family members in a branch you have edit rights on." });
    }
    const result = addChild(unionId, parsed.data.childId, parsed.data.relation ?? "biological");
    if ("error" in result) {
      const err = RELATION_ERRORS[result.error];
      return reply.code(err.code).send({ error: err.message });
    }
    return reply.code(201).send({ union: getUnion(unionId) });
  });

  app.delete("/api/family-tree/unions/:id/children/:childId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id: unionId, childId } = request.params as { id: string; childId: string };
    if (!removeChild(unionId, childId)) {
      return reply.code(404).send({ error: "Child link not found" });
    }
    return reply.send({ removed: true });
  });
}
