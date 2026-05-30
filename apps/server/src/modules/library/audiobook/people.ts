import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

type AuthorRow = {
  id: string;
  name: string;
  sort_name: string | null;
  bio: string | null;
  cover_storage_key: string | null;
};

function photoUrl(storageKey: string | null) {
  return storageKey ? `/api/library/covers/${storageKey}` : null;
}

const personProfileSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  bio: z.string().trim().max(10000).nullable().optional(),
  sortName: z.string().trim().max(240).nullable().optional()
});

export async function audiobookPeoplePlugin(app: FastifyInstance) {
  app.get("/api/library/people/by-name", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const row = db.prepare(`
      SELECT id, name, sort_name, bio, cover_storage_key
      FROM authors WHERE name = ? ORDER BY rowid ASC LIMIT 1
    `).get(name) as AuthorRow | undefined;

    reply.send({
      person: row
        ? { name: row.name, sortName: row.sort_name, bio: row.bio, photoUrl: photoUrl(row.cover_storage_key) }
        : null
    });
  });

  app.patch("/api/library/people/by-name", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const parsed = parseBody(personProfileSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid profile data", details: parsed.error });
      return;
    }

    db.prepare("UPDATE authors SET name = COALESCE(?, name), bio = ?, sort_name = ? WHERE name = ?").run(
      parsed.data.name ?? null,
      parsed.data.bio ?? null,
      parsed.data.sortName ?? null,
      name
    );

    reply.send({ updated: true });
  });

  app.put("/api/library/people/by-name/photo", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Photo is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Photo is too large (max 10 MB)." });
      return;
    }

    const firstAuthor = db.prepare(
      "SELECT id FROM authors WHERE name = ? ORDER BY rowid ASC LIMIT 1"
    ).get(name) as { id: string } | undefined;

    if (!firstAuthor) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    const storageKey = thumbnailStorageKey("people", firstAuthor.id, `${firstAuthor.id}-photo${ext}`);
    const absolutePath = thumbnailAbsolutePath(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body as Buffer);

    db.prepare("UPDATE authors SET cover_storage_key = ? WHERE name = ?").run(storageKey, name);

    reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
  });
}
