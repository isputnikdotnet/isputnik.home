// Global, cross-type tag browse. Tags are polymorphic (taggables.entity_type /
// entity_id), so a tag's books span every book-like library type today — and the
// same query naturally extends to other entity types (gallery, documents) later.
// Lives at the library level like the home feeds and the category browse.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { normalizeText } from "./audiobook/categorize.js";
import { bookLibraryIds, crossTypeBooksByFilter } from "./feed.js";

const placeholders = (n: number) => Array(n).fill("?").join(", ");

export function registerTagRoutes(app: FastifyInstance) {
  // Every tag used across the user's accessible book-like libraries, with usage
  // counts. Also feeds the shared metadata editor's tag autocomplete, so it now
  // suggests tags from audiobooks and ebooks alike.
  app.get("/api/library/tags", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const libIds = bookLibraryIds(user);
    if (libIds.length === 0) return { tags: [] };

    const rows = db.prepare(`
      SELECT tags.display_name AS name, COUNT(*) AS count
      FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      JOIN library_items ON library_items.id = taggables.entity_id AND taggables.entity_type = 'library_item'
      WHERE library_items.deleted_at IS NULL AND library_items.library_id IN (${placeholders(libIds.length)})
      GROUP BY tags.id
      ORDER BY count DESC, name COLLATE NOCASE
    `).all(...libIds) as { name: string; count: number }[];

    return { tags: rows };
  });

  // Books carrying a given tag, across every accessible book-like library. The
  // :name param is the tag's display name; it's normalized to match tags.key.
  app.get("/api/library/tags/:name/books", { preHandler: app.authenticate }, async (request, reply) => {
    const name = decodeURIComponent((request.params as { name: string }).name);
    const user = request.user!;
    const tag = db.prepare("SELECT id, display_name FROM tags WHERE key = ?")
      .get(normalizeText(name)) as { id: string; display_name: string } | undefined;
    if (!tag) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }

    const books = crossTypeBooksByFilter(
      user.id,
      bookLibraryIds(user),
      "EXISTS (SELECT 1 FROM taggables WHERE taggables.entity_id = library_items.id AND taggables.entity_type = 'library_item' AND taggables.tag_id = ?)",
      [tag.id]
    );

    reply.send({ tag: { name: tag.display_name, books } });
  });
}
