import type { FastifyInstance } from "fastify";
import { db } from "../../../db.js";
import { accessibleLibraryIds } from "../shared/library-access.js";
import { normalizeText } from "./categorize.js";
import { categoryImageUrl } from "./book-helpers.js";

export function registerBrowseRoutes(app: FastifyInstance) {

  // Unified permissions resolve access by library id (assignments table), so every
  // query below carries libraries.id; rows are filtered against the user's accessible
  // library ids, resolved once per request.
  interface AccessLibFields { library_id: string }

  // Fixed navigation categories with book counts across the user's accessible libraries.
  app.get("/api/library/categories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const categories = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories ORDER BY sort_order").all() as { id: string; key: string; name: string; icon: string | null; image_storage_key: string | null }[];
    const rows = db.prepare(`
      SELECT book_metadata.category_id AS category_id, libraries.id AS library_id
      FROM books
      JOIN libraries ON libraries.id = books.library_id
      JOIN book_metadata ON book_metadata.book_id = books.id
      WHERE books.deleted_at IS NULL AND libraries.type = 'audiobook' AND book_metadata.category_id IS NOT NULL
    `).all() as (AccessLibFields & { category_id: string })[];

    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!allowed.has(row.library_id)) continue;
      counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
    }

    return {
      categories: categories.map((category) => ({
        key: category.key,
        name: category.name,
        icon: category.icon,
        imageUrl: categoryImageUrl(category.image_storage_key),
        bookCount: counts.get(category.id) ?? 0
      }))
    };
  });


  app.get("/api/library/categories/:key/books", { preHandler: app.authenticate }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const user = request.user!;
    const category = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories WHERE key = ?").get(key) as { id: string; key: string; name: string; icon: string | null; image_storage_key: string | null } | undefined;
    if (!category) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT
        books.id,
        COALESCE(book_metadata.title, books.folder_path) AS title,
        book_metadata.cover_storage_key,
        libraries.id AS library_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM books
      JOIN libraries ON libraries.id = books.library_id
      JOIN book_metadata ON book_metadata.book_id = books.id AND book_metadata.category_id = ?
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.deleted_at IS NULL AND libraries.type = 'audiobook'
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(category.id) as (AccessLibFields & { id: string; title: string; cover_storage_key: string | null; author_names: string | null })[];

    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const accessible = rows.filter((row) => allowed.has(row.library_id));
    reply.send({
      category: {
        key: category.key,
        name: category.name,
        icon: category.icon,
        imageUrl: categoryImageUrl(category.image_storage_key),
        books: accessible.map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.author_names ? b.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
          coverUrl: b.cover_storage_key ? `/api/library/covers/${b.cover_storage_key}` : null
        }))
      }
    });
  });


  // All tags in the user's accessible audiobook libraries, with usage counts.
  app.get("/api/library/tags", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT tags.id AS tag_id, tags.display_name AS name, libraries.id AS library_id
      FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      JOIN books ON books.id = taggables.entity_id AND taggables.entity_type = 'book'
      JOIN libraries ON libraries.id = books.library_id
      WHERE books.deleted_at IS NULL AND libraries.type = 'audiobook'
    `).all() as (AccessLibFields & { tag_id: string; name: string })[];

    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const counts = new Map<string, { name: string; count: number }>();
    for (const row of rows) {
      if (!allowed.has(row.library_id)) continue;
      const entry = counts.get(row.tag_id) ?? { name: row.name, count: 0 };
      entry.count += 1;
      counts.set(row.tag_id, entry);
    }

    return {
      tags: [...counts.values()]
        .map((e) => ({ name: e.name, count: e.count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    };
  });


  // Books carrying a given tag, across the user's accessible audiobook libraries.
  // The :name param is the tag's display name; it's normalized to match tags.key.
  app.get("/api/library/tags/:name/books", { preHandler: app.authenticate }, async (request, reply) => {
    const name = decodeURIComponent((request.params as { name: string }).name);
    const user = request.user!;
    const tag = db.prepare("SELECT id, display_name FROM tags WHERE key = ?")
      .get(normalizeText(name)) as { id: string; display_name: string } | undefined;
    if (!tag) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT
        books.id,
        COALESCE(book_metadata.title, books.folder_path) AS title,
        book_metadata.cover_storage_key,
        libraries.id AS library_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM books
      JOIN libraries ON libraries.id = books.library_id
      JOIN book_metadata ON book_metadata.book_id = books.id
      JOIN taggables ON taggables.entity_id = books.id AND taggables.entity_type = 'book' AND taggables.tag_id = ?
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.deleted_at IS NULL AND libraries.type = 'audiobook'
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(tag.id) as (AccessLibFields & { id: string; title: string; cover_storage_key: string | null; author_names: string | null })[];

    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const accessible = rows.filter((row) => allowed.has(row.library_id));
    reply.send({
      tag: {
        name: tag.display_name,
        books: accessible.map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.author_names ? b.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
          coverUrl: b.cover_storage_key ? `/api/library/covers/${b.cover_storage_key}` : null
        }))
      }
    });
  });
}
