// Notes — what the household says about a thing, kept under the thing itself.
//
// The rule that keeps this from becoming a comment section is that there is only
// one rule: **if you can see the subject, you can read and write its notes.**
// No per-note audience, no picker, no second permission axis. Visibility and the
// right to post are the same question, asked once, of the subject resolver.
//
// (The proposal originally said posting should need `member` on the object, a
// tier above plain view. Phase 1 settled it the other way: anyone who can see a
// thing may already Send it to someone with a message attached, so refusing them
// a note on the same thing is incoherent — and the accounts it would silence are
// exactly the view-only ones, the children, whose remarks on the family photos
// are the point of the feature.)
//
// Bodies are plain text, stored and served as text, rendered as text. No
// markdown, no HTML, no link auto-detection. That is the entire XSS story for
// user-authored content here.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { hydrateOne, isSubjectEntityType } from "./subjects.js";

const MAX_BODY = 2000;

const subjectQuery = z.object({
  entityType: z.string().trim().refine(isSubjectEntityType, "Unknown entity type"),
  entityId: z.string().trim().min(1).max(64)
});

const createSchema = subjectQuery.extend({
  body: z.string().trim().min(1).max(MAX_BODY)
});

interface NoteRow {
  id: string;
  user_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

function noteView(row: NoteRow, viewer: { id: string; role: string }) {
  return {
    id: row.id,
    body: row.body,
    authorName: row.author_name ?? "Someone",
    // Whose note it is, so the client can say "you" and show the delete control.
    mine: row.user_id != null && row.user_id === viewer.id,
    createdAt: row.created_at,
    edited: row.updated_at !== row.created_at,
    // An admin can remove anything; everyone else only their own.
    canDelete: (row.user_id != null && row.user_id === viewer.id) || viewer.role === "admin"
  };
}

export async function notesPlugin(app: FastifyInstance) {
  // Every note on one subject, oldest first — a conversation reads downward.
  app.get("/api/social/notes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = subjectQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Unknown subject" });
    }
    const { entityType, entityId } = parsed.data;

    // The access check for reading notes IS the access check for the subject.
    // A 404 rather than a 403: a subject you cannot see should not be confirmed
    // to exist by the shape of the refusal.
    if (!hydrateOne(entityType, entityId, user)) {
      return reply.code(404).send({ error: "Not found" });
    }

    const rows = db.prepare(`
      SELECT id, user_id, author_name, body, created_at, updated_at
      FROM notes
      WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL
      ORDER BY datetime(created_at) ASC
    `).all(entityType, entityId) as NoteRow[];

    return reply.send({ notes: rows.map((row) => noteView(row, user)) });
  });

  app.post("/api/social/notes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Unable to post this note", details: parsed.error });
    }
    const { entityType, entityId, body } = parsed.data;

    if (!hydrateOne(entityType, entityId, user)) {
      return reply.code(404).send({ error: "Not found" });
    }

    const author = db.prepare("SELECT display_name FROM users WHERE id = ?").get(user.id) as
      | { display_name: string }
      | undefined;

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO notes (id, user_id, author_name, entity_type, entity_id, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.id, author?.display_name ?? null, entityType, entityId, body);

    const row = db.prepare(`
      SELECT id, user_id, author_name, body, created_at, updated_at FROM notes WHERE id = ?
    `).get(id) as NoteRow;

    return reply.code(201).send({ note: noteView(row, user) });
  });

  // Soft delete. The author, or an admin. With no replies there is no thread
  // shape to preserve, so the note simply stops being listed; the row stays so a
  // mistake can be undone by hand.
  app.delete("/api/social/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const id = (request.params as { id: string }).id;

    const row = db.prepare("SELECT user_id FROM notes WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { user_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "Not found" });

    if (row.user_id !== user.id && user.role !== "admin") {
      return reply.code(403).send({ error: "You can only remove your own notes." });
    }

    db.prepare("UPDATE notes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    return reply.send({ ok: true });
  });
}
