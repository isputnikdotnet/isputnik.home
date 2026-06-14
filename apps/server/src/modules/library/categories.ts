// Global, cross-type category browse. Categories are a single taxonomy
// (book_metadata.category_id) shared by every book-like library type, so the
// list (with counts) and the per-category book list span audiobooks + ebooks (and
// any future BOOK_LIBRARY_TYPES). Lives at the library level rather than in one
// media plugin, like the home feeds and the Recycle Bin.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { categoryImageUrl, type CategoryRow } from "./audiobook/book-helpers.js";
import { bookLibraryIds, crossTypeBooksByFilter } from "./feed.js";

const placeholders = (n: number) => Array(n).fill("?").join(", ");

export function registerCategoryRoutes(app: FastifyInstance) {
  // Fixed navigation categories with book counts across the user's accessible
  // book-like libraries. Shape matches the client `CategorySummary`, so the
  // metadata-editor / bulk-edit category pickers consume it unchanged.
  app.get("/api/library/categories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const categories = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories ORDER BY sort_order")
      .all() as CategoryRow[];

    const libIds = bookLibraryIds(user);
    const counts = new Map<string, number>();
    if (libIds.length > 0) {
      const rows = db.prepare(`
        SELECT book_metadata.category_id AS category_id, COUNT(*) AS n
        FROM books
        JOIN book_metadata ON book_metadata.book_id = books.id
        WHERE books.deleted_at IS NULL
          AND books.library_id IN (${placeholders(libIds.length)})
          AND book_metadata.category_id IS NOT NULL
        GROUP BY book_metadata.category_id
      `).all(...libIds) as { category_id: string; n: number }[];
      for (const row of rows) counts.set(row.category_id, row.n);
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

  // Books in a category across every accessible book-like library, mapped to the
  // cross-type FeedItem shape (type badge + correct per-type detail route).
  app.get("/api/library/categories/:key/books", { preHandler: app.authenticate }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const user = request.user!;
    const category = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories WHERE key = ?")
      .get(key) as CategoryRow | undefined;
    if (!category) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }

    const books = crossTypeBooksByFilter(user.id, bookLibraryIds(user), "book_metadata.category_id = ?", [category.id]);

    reply.send({
      category: {
        key: category.key,
        name: category.name,
        icon: category.icon,
        imageUrl: categoryImageUrl(category.image_storage_key),
        books
      }
    });
  });
}
