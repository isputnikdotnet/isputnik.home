// "Send to" — one family member pointing another at something.
//
// The shape of this module is one idea: a recommendation is a POINTER plus a
// line of text. No file is ever copied, and the recipient opens it with their
// own account and their own access. That is what keeps it cheap and safe.
//
// The destinations endpoint is what makes it feel like one button rather than
// four: people, the caller's own e-reader, and a guest link all come back from
// one call, already filtered to what actually applies to this subject.
//
// The one thing that IS more than a pointer: picking somebody who cannot open
// the subject yet grants them read access on the way through (grantItemAccess,
// shared with POST /api/shares/user so there is a single implementation). It
// never happens implicitly — the client must pass grantAccess, and it only does
// that after telling the sender in plain words what will happen. Folding it in
// here is the point: a separate "share with a person" dialog beside a "send to a
// person" sheet is two answers to one question, and people picked the wrong one.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { parseBody, requestOrigin } from "../../core/shared.js";
import { canGrantItemAccess, grantItemAccess } from "../library/shared/shares.js";
import { hydrateEntities, hydrateOne, isSubjectEntityType, type HydratedEntity } from "./subjects.js";
import { notifyRecommendationSent } from "./notify.js";

// Entity types that are rows in library_items, and so can go to My List. A
// family-tree person is sendable and note-able but there is nothing to save.
const LIBRARY_ITEM_TYPES = new Set(["audiobook", "ebook", "gallery"]);

const entityRef = {
  entityType: z.string().trim().refine(isSubjectEntityType, "Unknown entity type"),
  entityId: z.string().trim().min(1).max(64)
};

const sendSchema = z.object({
  ...entityRef,
  /** Widen access to anyone picked who cannot open it yet. See the send route. */
  grantAccess: z.boolean().optional(),
  // Plural on the wire even though the UI sends one today: the row shape is
  // per-recipient either way, so multi-select stays a client decision.
  toUserIds: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  message: z.string().trim().max(280).nullable().optional()
});

interface CandidateRow {
  id: string;
  display_name: string;
  role: string;
}

interface RecommendationRow {
  id: string;
  from_user_id: string | null;
  to_user_id: string;
  entity_type: string;
  entity_id: string;
  message: string | null;
  status: string;
  subject_title: string | null;
  from_name: string | null;
  created_at: string;
  seen_at: string | null;
}

function displayName(userId: string): string {
  const row = db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as
    | { display_name: string }
    | undefined;
  return row?.display_name ?? "Someone";
}

// The card as the inbox renders it. `available` false means the subject is gone
// or the recipient can no longer see it — the row survives on its snapshot so
// the card still says what it was about rather than vanishing without trace.
function cardView(row: RecommendationRow, hydrated: Map<string, HydratedEntity>) {
  const view = hydrated.get(`${row.entity_type}:${row.entity_id}`);
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    seen: row.seen_at != null,
    fromName: row.from_name ?? (row.from_user_id ? displayName(row.from_user_id) : "Someone"),
    available: view?.available ?? false,
    title: view?.title ?? row.subject_title ?? "No longer available",
    subtitle: view?.subtitle ?? null,
    coverUrl: view?.coverUrl ?? null,
    href: view?.href ?? "",
    // Only library items have somewhere to be saved to.
    savable: LIBRARY_ITEM_TYPES.has(row.entity_type)
  };
}

export async function socialPlugin(app: FastifyInstance) {
  // Everything the "Send to" sheet needs, in one call: which family members can
  // actually open this thing, whether the caller's e-reader applies, and whether
  // a guest link is possible.
  //
  // Access is resolved per candidate by running the subject resolver as THEM.
  // That is one query per household member — fine at five, and it is the only
  // way to be sure a recommendation is openable rather than a dead end.
  app.get("/api/social/destinations", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as { entityType?: string; entityId?: string };
    if (!query.entityType || !query.entityId || !isSubjectEntityType(query.entityType)) {
      return reply.code(400).send({ error: "Unknown subject" });
    }

    const subject = hydrateOne(query.entityType, query.entityId, user);
    if (!subject) {
      return reply.code(404).send({ error: "Not found" });
    }

    const candidates = db.prepare(`
      SELECT id, display_name, role FROM users
      WHERE id != ? AND is_active = 1 AND deleted_at IS NULL
      ORDER BY display_name COLLATE NOCASE
    `).all(user.id) as CandidateRow[];

    // Who already has this in their inbox, so the sheet can say so instead of
    // letting someone send the same book three times in a week.
    const alreadySent = new Set(
      (db.prepare(`
        SELECT to_user_id FROM recommendations
        WHERE from_user_id = ? AND entity_type = ? AND entity_id = ?
      `).all(user.id, query.entityType, query.entityId) as { to_user_id: string }[])
        .map((row) => row.to_user_id)
    );

    // Everyone is listed, including people who cannot open this yet. Hiding them
    // was the first design, and it produced the exact duplication this feature set
    // out to remove: "Mom isn't in the list" sent you off to a separate Share
    // dialog to grant access, then back here to tell her. One list, and the sheet
    // says which of the two it will be.
    const canGrant = LIBRARY_ITEM_TYPES.has(query.entityType)
      && canGrantItemAccess(query.entityId, user.id, user.role);

    const people = candidates.map((candidate) => ({
      id: candidate.id,
      displayName: candidate.display_name,
      alreadySent: alreadySent.has(candidate.id),
      canOpen: hydrateOne(query.entityType!, query.entityId!, candidate) != null
    }));

    // The e-reader row is the caller's own device, and only for books. Not set
    // up yet is still worth showing — it is better discovery than burying the
    // address in Profile, which is where it lives today.
    const self = db.prepare("SELECT ereader_email FROM users WHERE id = ?").get(user.id) as
      | { ereader_email: string | null }
      | undefined;

    return reply.send({
      subject: {
        title: subject.title,
        subtitle: subject.subtitle,
        coverUrl: subject.coverUrl,
        href: subject.href
      },
      people,
      // Whether picking somebody from the "needs access" half is allowed at all.
      // False for a viewer-level member: they still see who is missing, they just
      // cannot be the one to fix it.
      canGrant,
      ereader: query.entityType === "ebook"
        ? { applicable: true, configured: Boolean(self?.ereader_email) }
        : { applicable: false, configured: false },
      // Guest links exist for books and gallery items already; a family-tree
      // person has no public page to link to.
      guestLink: LIBRARY_ITEM_TYPES.has(query.entityType)
    });
  });

  // Send. Re-sending the same subject to the same person is an upsert, not a
  // duplicate: it refreshes the message and lifts the card back to 'new'.
  app.post("/api/social/recommendations", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(sendSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Unable to send", details: parsed.error });
    }
    const { entityType, entityId, toUserIds, message, grantAccess } = parsed.data;

    const subject = hydrateOne(entityType, entityId, user);
    if (!subject) {
      return reply.code(404).send({ error: "Not found" });
    }

    const recipients = db.prepare(`
      SELECT id, display_name, role FROM users
      WHERE id IN (${toUserIds.map(() => "?").join(", ")})
        AND id != ? AND is_active = 1 AND deleted_at IS NULL
    `).all(...toUserIds, user.id) as CandidateRow[];

    const senderName = displayName(user.id);
    const origin = requestOrigin(request);
    const sent: string[] = [];
    const skipped: string[] = [];

    const granted: string[] = [];

    for (const recipient of recipients) {
      // Checked as the RECIPIENT: a recommendation they cannot open is a dead
      // end, and silently sending one is worse than saying it can't be sent.
      if (!hydrateOne(entityType, entityId, recipient)) {
        // ...unless the sender asked to widen access and is allowed to. The grant
        // is never implicit: the client has to pass grantAccess, which it only
        // does after telling the sender in words that access will be given.
        const widened = grantAccess && LIBRARY_ITEM_TYPES.has(entityType)
          ? grantItemAccess({
              itemId: entityId,
              toUserId: recipient.id,
              by: user,
              origin,
              ipAddress: request.ip
            })
          : "forbidden";

        if (widened !== "ok" || !hydrateOne(entityType, entityId, recipient)) {
          skipped.push(recipient.display_name);
          continue;
        }
        granted.push(recipient.display_name);
      }
      db.prepare(`
        INSERT INTO recommendations
          (id, from_user_id, to_user_id, entity_type, entity_id, message, subject_title, from_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (from_user_id, to_user_id, entity_type, entity_id) DO UPDATE SET
          message = excluded.message,
          subject_title = excluded.subject_title,
          status = 'new',
          seen_at = NULL,
          created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(nanoid(16), user.id, recipient.id, entityType, entityId, message ?? null, subject.title, senderName);

      sent.push(recipient.display_name);
      notifyRecommendationSent({
        recipientId: recipient.id,
        senderName,
        subjectTitle: subject.title,
        message: message ?? null,
        origin
      });
    }

    if (sent.length === 0) {
      return reply.code(403).send({
        error: skipped.length > 0
          ? `${skipped.join(", ")} can't open this yet — it's in a library they don't have access to.`
          : "Nobody to send this to."
      });
    }

    return reply.code(201).send({ sent, skipped, granted });
  });

  // The bell. A count of what has not been LOOKED AT, not of what has not been
  // acted on — so it clears when you open the inbox and never climbs to 47.
  app.get("/api/social/inbox/summary", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const row = db.prepare(
      "SELECT COUNT(*) AS unseen FROM recommendations WHERE to_user_id = ? AND seen_at IS NULL"
    ).get(user.id) as { unseen: number };
    return { unseen: row.unseen };
  });

  app.get("/api/social/inbox", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT * FROM recommendations
      WHERE to_user_id = ?
      ORDER BY (status = 'new') DESC, datetime(created_at) DESC
      LIMIT 50
    `).all(user.id) as RecommendationRow[];

    const hydrated = hydrateEntities(
      rows.map((row) => ({ entityType: row.entity_type, entityId: row.entity_id })),
      user
    );
    return reply.send({ items: rows.map((row) => cardView(row, hydrated)) });
  });

  // Opening the inbox stamps everything in it as seen. Deliberately not per
  // card: the dot means "there is something new here", and once you have looked,
  // there isn't.
  app.post("/api/social/inbox/seen", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    db.prepare(`
      UPDATE recommendations SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE to_user_id = ? AND seen_at IS NULL
    `).run(user.id);
    return reply.send({ ok: true });
  });

  // Save — the whole tie-in with "Save for Later". It writes to the existing
  // item_saves ("My List"); there is no second saved-things list.
  app.post("/api/social/recommendations/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const row = db.prepare("SELECT * FROM recommendations WHERE id = ? AND to_user_id = ?")
      .get(id, user.id) as RecommendationRow | undefined;
    if (!row) return reply.code(404).send({ error: "Not found" });

    if (!LIBRARY_ITEM_TYPES.has(row.entity_type)) {
      return reply.code(400).send({ error: "This isn't something that can go to your list." });
    }
    if (!hydrateOne(row.entity_type, row.entity_id, user)) {
      return reply.code(404).send({ error: "This is no longer available." });
    }

    db.prepare(`
      INSERT INTO item_saves (id, user_id, item_id) VALUES (?, ?, ?)
      ON CONFLICT (user_id, item_id) DO NOTHING
    `).run(nanoid(16), user.id, row.entity_id);
    db.prepare("UPDATE recommendations SET status = 'saved' WHERE id = ?").run(id);
    return reply.send({ ok: true });
  });

  // "Not now". Keeps the row — the sender's Sent list stays honest — but takes
  // it out of the active pile.
  app.post("/api/social/recommendations/:id/dismiss", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;
    const changed = db.prepare(
      "UPDATE recommendations SET status = 'dismissed' WHERE id = ? AND to_user_id = ?"
    ).run(id, user.id).changes;
    if (changed === 0) return reply.code(404).send({ error: "Not found" });
    return reply.send({ ok: true });
  });
}
