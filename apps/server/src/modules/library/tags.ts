// Global, cross-type tag browse. Tags are polymorphic (taggables.entity_type /
// entity_id), so one tag can span audiobooks, ebooks, gallery photos, and
// family-tree people at once. Both endpoints report every type: the list gives
// per-type counts (so the client can offer an All / Audiobooks / Ebooks /
// Gallery / Family tree filter) and the detail returns each type's matches.
// Lives at the library level like the home feeds and the category browse.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { normalizeText } from "./audiobook/categorize.js";
import { bookLibraryIds, crossTypeBooksByFilter } from "./feed.js";
import { accessibleLibraryIds } from "./shared/library-access.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./gallery/catalog.js";
import { listFamilyPersonsByTag } from "../familytree/persons.js";

const placeholders = (n: number) => Array(n).fill("?").join(", ");

// Item counts per tag and library type, scoped to what the viewer can see.
interface TypeCountRow {
  id: string;
  name: string;
  type: string;
  count: number;
}

export function registerTagRoutes(app: FastifyInstance) {
  // Every tag in use across the viewer's accessible libraries and the family
  // tree, with a per-type breakdown. Also feeds the shared metadata editor's tag
  // autocomplete, so `count` stays the plain total it always was.
  app.get("/api/library/tags", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const libIds = [...accessibleLibraryIds(user.id, user.role)];

    const itemRows = libIds.length === 0 ? [] : db.prepare(`
      SELECT tags.id, tags.display_name AS name, libraries.type AS type, COUNT(*) AS count
      FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      JOIN library_items ON library_items.id = taggables.entity_id AND taggables.entity_type = 'library_item'
      JOIN libraries ON libraries.id = library_items.library_id
      WHERE library_items.deleted_at IS NULL AND library_items.library_id IN (${placeholders(libIds.length)})
      GROUP BY tags.id, libraries.type
    `).all(...libIds) as TypeCountRow[];

    // The tree is readable by every signed-in user, so family counts need no scoping.
    const familyRows = db.prepare(`
      SELECT tags.id, tags.display_name AS name, COUNT(*) AS count
      FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      JOIN family_tree_persons ON family_tree_persons.id = taggables.entity_id
      WHERE taggables.entity_type = 'family_tree_person'
      GROUP BY tags.id
    `).all() as { id: string; name: string; count: number }[];

    const byTag = new Map<string, {
      name: string; count: number;
      audiobookCount: number; ebookCount: number; galleryCount: number; familyCount: number;
    }>();
    const entry = (id: string, name: string) => {
      const found = byTag.get(id)
        ?? { name, count: 0, audiobookCount: 0, ebookCount: 0, galleryCount: 0, familyCount: 0 };
      byTag.set(id, found);
      return found;
    };
    for (const row of itemRows) {
      const tag = entry(row.id, row.name);
      tag.count += row.count;
      if (row.type === "audiobook") tag.audiobookCount += row.count;
      else if (row.type === "ebook") tag.ebookCount += row.count;
      else if (row.type === "gallery") tag.galleryCount += row.count;
    }
    for (const row of familyRows) {
      const tag = entry(row.id, row.name);
      tag.count += row.count;
      tag.familyCount += row.count;
    }

    const tags = [...byTag.values()].sort((a, b) =>
      b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { tags };
  });

  // Everything carrying a given tag: books (audiobooks + ebooks), gallery
  // photos/videos, and family-tree people. The :name param is the tag's display
  // name; it's normalized to match tags.key.
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

    const galleryIds = [...accessibleLibraryIds(user.id, user.role, "gallery")];
    const photos = galleryIds.length === 0 ? [] : (db.prepare(`
      SELECT ${ASSET_COLUMNS}
      ${ASSET_JOINS}
      JOIN taggables ON taggables.entity_id = library_items.id
        AND taggables.entity_type = 'library_item' AND taggables.tag_id = ?
      WHERE library_items.deleted_at IS NULL
        AND library_items.library_id IN (${placeholders(galleryIds.length)})
      ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
    `).all(user.id, tag.id, ...galleryIds) as GalleryAssetRow[]).map(mapAsset);

    reply.send({
      tag: { name: tag.display_name, books, photos, people: listFamilyPersonsByTag(tag.id) }
    });
  });
}
