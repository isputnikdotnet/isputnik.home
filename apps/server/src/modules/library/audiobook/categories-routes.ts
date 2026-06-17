import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { CATEGORY_SEED, isBuiltinCategoryImageKey } from "../../../categories-seed.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { normalizeText, rematchAllCategories } from "./categorize.js";

function imageUrl(imageStorageKey: string | null) {
  if (isBuiltinCategoryImageKey(imageStorageKey)) {
    return null;
  }
  return imageStorageKey ? `/api/library/covers/${imageStorageKey}` : null;
}

function categoryResponse(row: {
  id: string;
  key: string;
  name: string;
  sort_order: number;
  icon: string | null;
  image_storage_key: string | null;
  book_count: number;
  mapping_count: number;
}) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    icon: row.icon,
    imageUrl: imageUrl(row.image_storage_key),
    bookCount: row.book_count,
    mappingCount: row.mapping_count
  };
}

function categoryKeyBase(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "category";
}

function uniqueCategoryKey(name: string) {
  const base = categoryKeyBase(name);
  let key = base.slice(0, 64);
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM categories WHERE key = ?").get(key)) {
    const ending = `_${suffix}`;
    key = `${base.slice(0, 64 - ending.length)}${ending}`;
    suffix += 1;
  }
  return key;
}

function nextCategorySortOrder() {
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM categories WHERE key != 'general_other'")
    .get() as { next_order: number };
  return Math.min(row.next_order, 999);
}

function rememberDeletedCategoryKey(key: string) {
  if (!CATEGORY_SEED.some((category) => category.key === key)) {
    return;
  }
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'deleted_category_keys'")
    .get() as { value: string } | undefined;
  let keys: string[] = [];
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (Array.isArray(parsed)) {
        keys = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      keys = [];
    }
  }
  if (!keys.includes(key)) {
    keys.push(key);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('deleted_category_keys', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(JSON.stringify(keys));
}

async function writeCategoryImage(categoryId: string, source: Buffer) {
  const storageKey = thumbnailStorageKey("categories", categoryId, `${categoryId}.webp`);
  const filePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp(source).resize(240, 240, { fit: "cover" }).webp({ quality: 84 }).toFile(filePath);
  return storageKey;
}

// Admin-only management of the navigation categories and the alias mapping table.
export async function categoriesAdminPlugin(app: FastifyInstance) {
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/library/manage/categories", { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`
      SELECT
        categories.id, categories.key, categories.name, categories.sort_order, categories.icon, categories.image_storage_key,
        (
          SELECT COUNT(*) FROM item_categories WHERE item_categories.category_id = categories.id AND item_categories.is_primary = 1
        ) AS book_count,
        (
          SELECT COUNT(*) FROM category_aliases WHERE category_aliases.category_id = categories.id
        ) AS mapping_count
      FROM categories
      ORDER BY categories.sort_order
    `).all() as { id: string; key: string; name: string; sort_order: number; icon: string | null; image_storage_key: string | null; book_count: number; mapping_count: number }[];
    return {
      categories: rows.map(categoryResponse)
    };
  });

  const categoryCreateSchema = z.object({
    name: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).max(999).optional(),
    icon: z.string().trim().min(1).max(40).nullable().optional()
  });

  app.post("/api/library/manage/categories", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(categoryCreateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid category", details: parsed.error });
      return;
    }
    const categoryId = nanoid(16);
    const key = uniqueCategoryKey(parsed.data.name);
    const sortOrder = parsed.data.sortOrder ?? nextCategorySortOrder();
    const icon = parsed.data.icon || "layout-grid";
    db.prepare("INSERT INTO categories (id, key, name, sort_order, icon) VALUES (?, ?, ?, ?, ?)")
      .run(categoryId, key, parsed.data.name, sortOrder, icon);
    logActivity({
      event: "library.category.created",
      actorUserId: request.user!.id,
      detail: `Created category "${parsed.data.name}".`,
      ipAddress: request.ip
    });
    reply.code(201).send({
      category: categoryResponse({
        id: categoryId,
        key,
        name: parsed.data.name,
        sort_order: sortOrder,
        icon,
        image_storage_key: null,
        book_count: 0,
        mapping_count: 0
      })
    });
  });

  const categoryUpdateSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    icon: z.string().trim().min(1).max(40).nullable().optional()
  });

  app.patch("/api/library/manage/categories/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id FROM categories WHERE id = ?").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }
    const parsed = parseBody(categoryUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid category", details: parsed.error });
      return;
    }
    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    if (parsed.data.name !== undefined) { updates.push("name = ?"); values.push(parsed.data.name); }
    if (parsed.data.sortOrder !== undefined) { updates.push("sort_order = ?"); values.push(parsed.data.sortOrder); }
    if (parsed.data.icon !== undefined) { updates.push("icon = ?"); values.push(parsed.data.icon || null); }
    if (updates.length > 0) {
      db.prepare(`UPDATE categories SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
    }
    reply.send({ updated: true });
  });

  app.put("/api/library/manage/categories/:id/image", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(id);
    if (!category) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }
    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Image is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Image is too large." });
      return;
    }
    try {
      const storageKey = await writeCategoryImage(id, body);
      db.prepare("UPDATE categories SET image_storage_key = ? WHERE id = ?").run(storageKey, id);
      reply.send({ updated: true, imageUrl: `${imageUrl(storageKey)}?v=${Date.now()}` });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to save image" });
    }
  });

  app.delete("/api/library/manage/categories/:id/image", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = db.prepare("SELECT image_storage_key FROM categories WHERE id = ?").get(id) as { image_storage_key: string | null } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }
    if (row.image_storage_key && !isBuiltinCategoryImageKey(row.image_storage_key)) {
      try { fs.rmSync(thumbnailAbsolutePath(row.image_storage_key), { force: true }); } catch { /* ignore */ }
    }
    db.prepare("UPDATE categories SET image_storage_key = NULL WHERE id = ?").run(id);
    reply.send({ deleted: true });
  });

  app.delete("/api/library/manage/categories/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const category = db.prepare("SELECT id, key, name, image_storage_key FROM categories WHERE id = ?")
      .get(id) as { id: string; key: string; name: string; image_storage_key: string | null } | undefined;
    if (!category) {
      reply.code(404).send({ error: "Category not found" });
      return;
    }
    if (category.key === "general_other") {
      reply.code(400).send({ error: "General / Other cannot be deleted." });
      return;
    }
    const fallback = db.prepare("SELECT id FROM categories WHERE key = 'general_other'").get() as { id: string } | undefined;
    if (!fallback) {
      reply.code(500).send({ error: "Fallback category is missing." });
      return;
    }
    let movedBooks = 0;
    db.transaction(() => {
      // OR IGNORE: an item already carrying the fallback category would collide on
      // (item_id, category_id); its stale row then cascade-deletes with the category,
      // leaving the item in the fallback either way.
      movedBooks = db.prepare("UPDATE OR IGNORE item_categories SET category_id = ? WHERE category_id = ?")
        .run(fallback.id, category.id).changes;
      db.prepare("DELETE FROM categories WHERE id = ?").run(category.id);
      rememberDeletedCategoryKey(category.key);
    })();
    if (category.image_storage_key && !isBuiltinCategoryImageKey(category.image_storage_key)) {
      try { fs.rmSync(thumbnailAbsolutePath(category.image_storage_key), { force: true }); } catch { /* ignore */ }
    }
    logActivity({
      event: "library.category.deleted",
      actorUserId: request.user!.id,
      detail: `Deleted category "${category.name}" and moved ${movedBooks} book(s) to General / Other.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true, movedBooks });
  });

  app.get("/api/library/manage/aliases", { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`
      SELECT category_aliases.id, category_aliases.keyword, category_aliases.priority,
             categories.id AS category_id, categories.key AS category_key, categories.name AS category_name
      FROM category_aliases
      JOIN categories ON categories.id = category_aliases.category_id
      ORDER BY categories.sort_order, category_aliases.keyword
    `).all() as { id: string; keyword: string; priority: number; category_id: string; category_key: string; category_name: string }[];
    return {
      aliases: rows.map((r) => ({
        id: r.id, keyword: r.keyword, priority: r.priority,
        categoryId: r.category_id, categoryKey: r.category_key, categoryName: r.category_name
      }))
    };
  });

  const aliasCreateSchema = z.object({
    keyword: z.string().trim().min(1).max(120),
    categoryId: z.string().trim().min(1).max(64),
    priority: z.number().int().min(0).max(999).optional()
  });

  app.post("/api/library/manage/aliases", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(aliasCreateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid mapping", details: parsed.error });
      return;
    }
    const keyword = normalizeText(parsed.data.keyword);
    if (!keyword) {
      reply.code(400).send({ error: "Keyword is empty after normalization." });
      return;
    }
    const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(parsed.data.categoryId);
    if (!category) {
      reply.code(400).send({ error: "Category not found." });
      return;
    }
    const existing = db.prepare("SELECT id FROM category_aliases WHERE keyword = ?").get(keyword);
    if (existing) {
      reply.code(409).send({ error: `A mapping for "${keyword}" already exists.` });
      return;
    }
    const aliasId = nanoid(16);
    db.prepare("INSERT INTO category_aliases (id, keyword, category_id, priority) VALUES (?, ?, ?, ?)")
      .run(aliasId, keyword, parsed.data.categoryId, parsed.data.priority ?? 20);
    logActivity({
      event: "library.category.alias_created",
      actorUserId: request.user!.id,
      detail: `Mapped "${keyword}" to a category.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ alias: { id: aliasId, keyword } });
  });

  const aliasUpdateSchema = z.object({
    keyword: z.string().trim().min(1).max(120).optional(),
    categoryId: z.string().trim().min(1).max(64).optional(),
    priority: z.number().int().min(0).max(999).optional()
  });

  app.patch("/api/library/manage/aliases/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id FROM category_aliases WHERE id = ?").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Mapping not found" });
      return;
    }
    const parsed = parseBody(aliasUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid mapping", details: parsed.error });
      return;
    }
    const updates: string[] = [];
    const values: (string | number)[] = [];
    if (parsed.data.keyword !== undefined) {
      const keyword = normalizeText(parsed.data.keyword);
      if (!keyword) { reply.code(400).send({ error: "Keyword is empty after normalization." }); return; }
      const clash = db.prepare("SELECT id FROM category_aliases WHERE keyword = ? AND id != ?").get(keyword, id);
      if (clash) { reply.code(409).send({ error: `A mapping for "${keyword}" already exists.` }); return; }
      updates.push("keyword = ?"); values.push(keyword);
    }
    if (parsed.data.categoryId !== undefined) {
      const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(parsed.data.categoryId);
      if (!category) { reply.code(400).send({ error: "Category not found." }); return; }
      updates.push("category_id = ?"); values.push(parsed.data.categoryId);
    }
    if (parsed.data.priority !== undefined) { updates.push("priority = ?"); values.push(parsed.data.priority); }
    if (updates.length > 0) {
      db.prepare(`UPDATE category_aliases SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
    }
    reply.send({ updated: true });
  });

  app.delete("/api/library/manage/aliases/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = db.prepare("DELETE FROM category_aliases WHERE id = ?").run(id);
    if (result.changes === 0) {
      reply.code(404).send({ error: "Mapping not found" });
      return;
    }
    reply.send({ deleted: true });
  });

  app.post("/api/library/manage/rematch", { preHandler: app.requireAdmin }, async (request) => {
    const changed = rematchAllCategories();
    logActivity({
      event: "library.category.rematch",
      actorUserId: request.user!.id,
      detail: `Re-matched categories from tags — ${changed} book(s) updated.`,
      ipAddress: request.ip
    });
    return { changed };
  });

  // ── Tag management ────────────────────────────────────────────────
  // Global tag list with usage counts (books not soft-deleted).
  function listTags(): { id: string; name: string; bookCount: number }[] {
    return db.prepare(`
      SELECT
        tags.id AS id,
        tags.display_name AS name,
        (
          SELECT COUNT(*)
          FROM taggables
          JOIN library_items ON library_items.id = taggables.entity_id
          WHERE taggables.tag_id = tags.id
            AND taggables.entity_type = 'library_item'
            AND library_items.deleted_at IS NULL
        ) AS bookCount
      FROM tags
      ORDER BY tags.display_name COLLATE NOCASE
    `).all() as { id: string; name: string; bookCount: number }[];
  }

  app.get("/api/library/manage/tags", { preHandler: app.requireAdmin }, async () => {
    return { tags: listTags() };
  });

  const tagNameSchema = z.object({ displayName: z.string().trim().min(1).max(120) });

  app.post("/api/library/manage/tags", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(tagNameSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid tag name", details: parsed.error });
      return;
    }

    const displayName = parsed.data.displayName.trim();
    const key = normalizeText(displayName);
    if (!key) {
      reply.code(400).send({ error: "Tag name must contain letters or numbers." });
      return;
    }

    const id = nanoid();
    const result = db.prepare("INSERT OR IGNORE INTO tags (id, key, display_name) VALUES (?, ?, ?)")
      .run(id, key, displayName);
    if (result.changes === 0) {
      reply.code(409).send({ error: "Tag already exists." });
      return;
    }

    logActivity({
      event: "library.tag.created",
      actorUserId: request.user!.id,
      targetType: "tag",
      targetId: id,
      detail: `Created tag "${displayName}".`,
      ipAddress: request.ip
    });

    return { tags: listTags() };
  });

  app.patch("/api/library/manage/tags/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id, display_name FROM tags WHERE id = ?")
      .get(id) as { id: string; display_name: string } | undefined;
    if (!existing) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }

    const parsed = parseBody(tagNameSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid tag name", details: parsed.error });
      return;
    }

    const displayName = parsed.data.displayName.trim();
    const newKey = normalizeText(displayName);
    if (!newKey) {
      reply.code(400).send({ error: "Tag name must contain letters or numbers." });
      return;
    }

    // If another tag already uses this key, merge into it: move this tag's book
    // links onto the survivor (deduping), then delete this tag.
    const collision = db.prepare("SELECT id FROM tags WHERE key = ? AND id != ?")
      .get(newKey, id) as { id: string } | undefined;

    db.transaction(() => {
      if (collision) {
        db.prepare(`
          INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id)
          SELECT ?, entity_type, entity_id FROM taggables WHERE tag_id = ?
        `).run(collision.id, id);
        db.prepare("DELETE FROM taggables WHERE tag_id = ?").run(id);
        db.prepare("DELETE FROM tags WHERE id = ?").run(id);
        // Keep the survivor's display name in sync with the chosen spelling.
        db.prepare("UPDATE tags SET display_name = ? WHERE id = ?").run(displayName, collision.id);
      } else {
        db.prepare("UPDATE tags SET display_name = ?, key = ? WHERE id = ?").run(displayName, newKey, id);
      }
    })();

    logActivity({
      event: "library.tag.renamed",
      actorUserId: request.user!.id,
      targetType: "tag",
      targetId: collision?.id ?? id,
      detail: collision
        ? `Merged tag "${existing.display_name}" into "${displayName}".`
        : `Renamed tag "${existing.display_name}" to "${displayName}".`,
      ipAddress: request.ip
    });

    return { tags: listTags(), merged: Boolean(collision) };
  });

  app.delete("/api/library/manage/tags/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id, display_name FROM tags WHERE id = ?")
      .get(id) as { id: string; display_name: string } | undefined;
    if (!existing) {
      reply.code(404).send({ error: "Tag not found" });
      return;
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE tag_id = ?").run(id);
      db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    })();

    logActivity({
      event: "library.tag.deleted",
      actorUserId: request.user!.id,
      targetType: "tag",
      targetId: id,
      detail: `Deleted tag "${existing.display_name}".`,
      ipAddress: request.ip
    });

    return { deleted: true };
  });

  // Delete tags that aren't linked to any non-deleted book.
  app.post("/api/library/manage/tags/prune", { preHandler: app.requireAdmin }, async (request) => {
    const unused = listTags().filter((tag) => tag.bookCount === 0);
    db.transaction(() => {
      for (const tag of unused) {
        db.prepare("DELETE FROM taggables WHERE tag_id = ?").run(tag.id);
        db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
      }
    })();

    if (unused.length > 0) {
      logActivity({
        event: "library.tag.pruned",
        actorUserId: request.user!.id,
        detail: `Pruned ${unused.length} unused tag(s).`,
        ipAddress: request.ip
      });
    }

    return { pruned: unused.length };
  });
}
