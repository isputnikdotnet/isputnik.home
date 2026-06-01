import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";

// A library section is a grouping shell on the Audiobooks page: a master icon
// that holds one or more libraries (its members carry section_id in their
// settings_json). The section owns only its identity — name + icon. Per-library
// metadata overrides live on each member library, not here.

interface SectionRow {
  id: string;
  name: string;
  icon: string;
  created_at: string;
  updated_at: string;
  library_count: number;
}

function publicSection(row: SectionRow) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libraryCount: row.library_count
  };
}

// Member libraries reference a section by section_id stored in settings_json.
// SQLite's json_extract lets us count and detach members without parsing in JS.
function listSections(): SectionRow[] {
  return db.prepare(`
    SELECT
      library_sections.*,
      (
        SELECT COUNT(*)
        FROM libraries
        WHERE json_extract(libraries.settings_json, '$.section_id') = library_sections.id
      ) AS library_count
    FROM library_sections
    ORDER BY library_sections.name COLLATE NOCASE
  `).all() as SectionRow[];
}

const sectionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  icon: z.string().trim().min(1).max(40).default("radio")
});

export async function sectionsRoutesPlugin(app: FastifyInstance) {
  // All authenticated users need the section list to render the master icons.
  app.get("/api/library/sections", { preHandler: app.authenticate }, async () => {
    return { sections: listSections().map(publicSection) };
  });

  app.post("/api/library/sections", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(sectionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid section details", details: parsed.error });
      return;
    }

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO library_sections (id, name, icon, created_by)
      VALUES (?, ?, ?, ?)
    `).run(id, parsed.data.name, parsed.data.icon, request.user!.id);

    logActivity({
      event: "library.section.created",
      actorUserId: request.user!.id,
      targetType: "library_section",
      targetId: id,
      detail: `Created library section "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    const row = db.prepare(`
      SELECT library_sections.*, 0 AS library_count
      FROM library_sections WHERE id = ?
    `).get(id) as SectionRow;
    reply.code(201).send({ section: publicSection(row) });
  });

  app.patch("/api/library/sections/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id FROM library_sections WHERE id = ?").get(id) as { id: string } | undefined;
    if (!existing) {
      reply.code(404).send({ error: "Section not found" });
      return;
    }

    const parsed = parseBody(sectionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid section details", details: parsed.error });
      return;
    }

    db.prepare(`
      UPDATE library_sections
      SET name = ?, icon = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(parsed.data.name, parsed.data.icon, id);

    logActivity({
      event: "library.section.updated",
      actorUserId: request.user!.id,
      targetType: "library_section",
      targetId: id,
      detail: `Updated library section "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    const row = listSections().find((section) => section.id === id)!;
    reply.send({ section: publicSection(row) });
  });

  app.delete("/api/library/sections/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id, name FROM library_sections WHERE id = ?")
      .get(id) as { id: string; name: string } | undefined;
    if (!existing) {
      reply.code(404).send({ error: "Section not found" });
      return;
    }

    db.transaction(() => {
      // Detach member libraries so they reappear in the main grid rather than
      // pointing at a section that no longer exists.
      const members = db.prepare(
        "SELECT id, settings_json FROM libraries WHERE json_extract(settings_json, '$.section_id') = ?"
      ).all(id) as { id: string; settings_json: string }[];
      for (const member of members) {
        const settings = JSON.parse(member.settings_json || "{}");
        delete settings.section_id;
        db.prepare("UPDATE libraries SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(JSON.stringify(settings), member.id);
      }
      db.prepare("DELETE FROM library_sections WHERE id = ?").run(id);
    })();

    logActivity({
      event: "library.section.deleted",
      actorUserId: request.user!.id,
      targetType: "library_section",
      targetId: id,
      detail: `Deleted library section "${existing.name}". Member libraries were detached.`,
      ipAddress: request.ip
    });

    reply.send({ deleted: true });
  });
}
