import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import {
  pathIsInside,
  normaliseRelativePath,
  validateStorageRootPath,
  relativePathWithinRoot,
  publicStorageRoot,
  type StorageRootRow
} from "./shared/storage-roots.js";

const storageRootSchema = z.object({
  name: z.string().trim().min(2).max(120),
  path: z.string().trim().min(1).max(1000)
});

const browseQuerySchema = z.object({
  path: z.string().trim().max(1000).default("")
});

export async function storagePlugin(app: FastifyInstance) {
  app.get("/api/storage/roots", { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`
      SELECT
        storage_roots.*,
        COUNT(libraries.id) AS library_count
      FROM storage_roots
      LEFT JOIN libraries ON libraries.source_path = storage_roots.path
        OR libraries.source_path LIKE storage_roots.path || ?
      GROUP BY storage_roots.id
      ORDER BY storage_roots.name COLLATE NOCASE
    `).all(`${path.sep}%`) as StorageRootRow[];

    return { roots: rows.map(publicStorageRoot) };
  });

  app.post("/api/storage/roots", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(storageRootSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid storage container details", details: parsed.error });
      return;
    }

    let rootPath: string;
    try {
      rootPath = validateStorageRootPath(parsed.data.path);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid storage container path" });
      return;
    }

    const id = nanoid(16);
    try {
      db.prepare(`
        INSERT INTO storage_roots (id, name, path, created_by)
        VALUES (?, ?, ?, ?)
      `).run(id, parsed.data.name, rootPath, request.user!.id);
    } catch {
      reply.code(409).send({ error: "A storage container already uses that path." });
      return;
    }

    logActivity({
      event: "storage.root.created",
      actorUserId: request.user!.id,
      targetType: "storage_root",
      targetId: id,
      detail: `Added Digital Library storage container "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ root: { id, name: parsed.data.name, path: rootPath, libraryCount: 0 } });
  });

  app.delete("/api/storage/roots/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const root = db.prepare("SELECT id, name, path FROM storage_roots WHERE id = ?").get(id) as {
      id: string;
      name: string;
      path: string;
    } | undefined;

    if (!root) {
      reply.code(404).send({ error: "Storage container not found" });
      return;
    }

    const inUse = db.prepare(`
      SELECT COUNT(*) AS count
      FROM libraries
      WHERE source_path = ?
        OR source_path LIKE ?
    `).get(root.path, `${root.path}${path.sep}%`) as { count: number };

    if (inUse.count > 0) {
      reply.code(409).send({ error: "This storage container is already used by a library." });
      return;
    }

    db.prepare("DELETE FROM storage_roots WHERE id = ?").run(id);
    logActivity({
      event: "storage.root.deleted",
      actorUserId: request.user!.id,
      targetType: "storage_root",
      targetId: id,
      detail: `Deleted Digital Library storage container "${root.name}".`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/storage/roots/:id/browse", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(browseQuerySchema, request.query);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid browse path", details: parsed.error });
      return;
    }

    const root = db.prepare("SELECT id, name, path FROM storage_roots WHERE id = ?").get(id) as {
      id: string;
      name: string;
      path: string;
    } | undefined;
    if (!root) {
      reply.code(404).send({ error: "Storage container not found" });
      return;
    }

    try {
      const currentPath = relativePathWithinRoot(root.path, parsed.data.path ?? "");
      const currentRelativePath = normaliseRelativePath(path.relative(root.path, currentPath));
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .flatMap((entry) => {
          const absolutePath = path.join(currentPath, entry.name);
          try {
            const realPath = fs.realpathSync(absolutePath);
            if (!pathIsInside(realPath, root.path) || !fs.statSync(realPath).isDirectory()) {
              return [];
            }
            return [{
              name: entry.name,
              relativePath: normaliseRelativePath(path.relative(root.path, realPath))
            }];
          } catch {
            return [];
          }
        })
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

      const parentPath = currentPath === root.path
        ? null
        : normaliseRelativePath(path.relative(root.path, path.dirname(currentPath)));

      return {
        root: { ...root, libraryCount: 0 },
        currentPath: currentRelativePath,
        selectedPath: currentPath,
        parentPath,
        entries
      };
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to browse storage container" });
    }
  });
}
