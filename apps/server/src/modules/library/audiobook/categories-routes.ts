import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { normalizeText, rematchAllCategories } from "./categorize.js";

function imageUrl(imageStorageKey: string | null) {
  return imageStorageKey ? `/api/library/covers/${imageStorageKey}` : null;
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
          SELECT COUNT(*) FROM book_metadata WHERE book_metadata.category_id = categories.id
        ) AS book_count
      FROM categories
      ORDER BY categories.sort_order
    `).all() as { id: string; key: string; name: string; sort_order: number; icon: string | null; image_storage_key: string | null; book_count: number }[];
    return {
      categories: rows.map((r) => ({
        id: r.id, key: r.key, name: r.name, sortOrder: r.sort_order,
        icon: r.icon, imageUrl: imageUrl(r.image_storage_key), bookCount: r.book_count
      }))
    };
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
    if (row.image_storage_key) {
      try { fs.rmSync(thumbnailAbsolutePath(row.image_storage_key), { force: true }); } catch { /* ignore */ }
    }
    db.prepare("UPDATE categories SET image_storage_key = NULL WHERE id = ?").run(id);
    reply.send({ deleted: true });
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
}
