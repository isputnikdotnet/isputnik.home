import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { canUserWriteLibrary, getAccessibleLibrary } from "../shared/library-access.js";
import { enrichPerson, lookupPersonByUrl, lookupPersonInfo, lookupPersonPhotoCandidates, removeStoredPhotos, writePersonPhoto } from "./enrich.js";
import { MetadataLinkError } from "./providers/types.js";
import { sortTitle } from "./scanner.js";

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

const createPersonSchema = z.object({
  name: z.string().trim().min(1).max(240),
  libraryId: z.string().trim().min(1),
  bio: z.string().trim().max(10000).nullable().optional(),
  sortName: z.string().trim().max(240).nullable().optional()
});

// Wikipedia language hints for a person: the default languages of the
// libraries they appear in (e.g. ru Wikipedia for a Russian library), then
// English.
function personLookupLanguages(name: string) {
  const rows = db.prepare(`
    SELECT DISTINCT libraries.settings_json AS settings_json
    FROM libraries
    JOIN authors ON authors.library_id = libraries.id
    WHERE authors.name = ?
  `).all(name) as { settings_json: string }[];
  return rows
    .map((row) => normalizeLibrarySettings("audiobook", row.settings_json).default_language)
    .filter((lang): lang is string => Boolean(lang));
}

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

  // Photos for all people that have one, keyed by name — lets the authors/
  // narrators list pages show avatars without a request per person.
  app.get("/api/library/people/photos", { preHandler: app.authenticate }, async (_request, reply) => {
    const rows = db.prepare(`
      SELECT name, cover_storage_key
      FROM authors
      WHERE cover_storage_key IS NOT NULL
      ORDER BY rowid ASC
    `).all() as { name: string; cover_storage_key: string }[];

    // First row per name wins, matching the by-name endpoints.
    const photos: Record<string, string> = {};
    for (const row of rows) {
      photos[row.name] ??= `/api/library/covers/${row.cover_storage_key}`;
    }
    reply.send({ photos });
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

  // Look the person up online (Wikipedia, then Open Library) and fill their
  // biography and photo — empty fields only; existing data is never replaced.
  app.post("/api/library/people/by-name/enrich", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const exists = db.prepare("SELECT 1 FROM authors WHERE name = ? LIMIT 1").get(name);
    if (!exists) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    try {
      const { updatedBio, updatedPhoto, result } = await enrichPerson(name, personLookupLanguages(name));
      const row = db.prepare(`
        SELECT id, name, sort_name, bio, cover_storage_key
        FROM authors WHERE name = ? ORDER BY rowid ASC LIMIT 1
      `).get(name) as AuthorRow | undefined;

      reply.send({
        found: Boolean(result),
        updatedBio,
        updatedPhoto,
        source: result?.source ?? null,
        person: row
          ? { name: row.name, sortName: row.sort_name, bio: row.bio, photoUrl: photoUrl(row.cover_storage_key) }
          : null
      });
    } catch {
      reply.code(502).send({ error: "Online lookup failed. Check the server's internet access and try again." });
    }
  });

  // Preview a person's online profile (Wikipedia / Open Library) without writing
  // anything: by name, or from a specific pasted author link (?url=). The modal
  // shows a current-vs-found comparison and applies fields on confirmation.
  app.get("/api/library/people/by-name/lookup", { preHandler: app.authenticate }, async (request, reply) => {
    const q = request.query as { name?: string; url?: string };
    const name = String(q.name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const url = q.url?.trim();
    try {
      const candidate = url
        ? await lookupPersonByUrl(url)
        : await lookupPersonInfo(name, personLookupLanguages(name));
      reply.send({ candidate });
    } catch (err) {
      const status = err instanceof MetadataLinkError ? err.status : 502;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Online lookup failed" });
    }
  });

  // Create a person manually (profile-only): a library-scoped authors row with
  // name + optional bio. It becomes a book-edit suggestion immediately and shows
  // on the browse page once a book credits them. Role isn't stored (it lives on
  // book_authors), so "author" and "narrator" create the same kind of row.
  app.post("/api/library/people", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createPersonSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid person data", details: parsed.error });
      return;
    }
    const { name, libraryId, bio, sortName } = parsed.data;

    const lib = getAccessibleLibrary(libraryId, request.user!.id, request.user!.role, "audiobook");
    if (!lib || !canUserWriteLibrary(lib, request.user!.id, request.user!.role)) {
      reply.code(403).send({ error: "Write access to the library is required to add people." });
      return;
    }

    const existing = db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?").get(libraryId, name);
    if (existing) {
      reply.code(409).send({ error: "A person with that name already exists in this library." });
      return;
    }

    const resolvedSortName = sortName?.trim() || sortTitle(name);
    db.prepare("INSERT INTO authors (id, library_id, name, sort_name, bio) VALUES (?, ?, ?, ?, ?)")
      .run(nanoid(16), libraryId, name, resolvedSortName, bio?.trim() || null);

    logActivity({
      event: "library.person.created",
      actorUserId: request.user!.id,
      targetType: "person",
      targetId: name,
      detail: `Created person "${name}".`,
      ipAddress: request.ip
    });

    reply.send({ person: { name, sortName: resolvedSortName, bio: bio?.trim() || null, photoUrl: null } });
  });

  // Photo candidates the user can pick from (Wikipedia per language, Open
  // Library author records). Lookup only — nothing is applied here.
  app.get("/api/library/people/by-name/photo-candidates", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const exists = db.prepare("SELECT 1 FROM authors WHERE name = ? LIMIT 1").get(name);
    if (!exists) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    try {
      const candidates = await lookupPersonPhotoCandidates(name, personLookupLanguages(name));
      reply.send({ candidates });
    } catch {
      reply.code(502).send({ error: "Online lookup failed. Check the server's internet access and try again." });
    }
  });

  // Apply a picked candidate: download (SSRF-guarded), normalise to webp, and
  // set it as the person's photo — an explicit choice, so it replaces any
  // existing photo.
  app.post("/api/library/people/by-name/photo-from-url", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const parsed = parseBody(z.object({ url: z.string().trim().url().max(2000) }), request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid photo URL", details: parsed.error });
      return;
    }

    const rows = db.prepare(
      "SELECT id, cover_storage_key FROM authors WHERE name = ? ORDER BY rowid ASC"
    ).all(name) as { id: string; cover_storage_key: string | null }[];
    if (rows.length === 0) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    try {
      const storageKey = await writePersonPhoto(rows[0].id, parsed.data.url);
      db.prepare("UPDATE authors SET cover_storage_key = ? WHERE name = ?").run(storageKey, name);
      removeStoredPhotos(rows.map((row) => row.cover_storage_key).filter((key) => key !== storageKey));
      reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to download the photo." });
    }
  });

  // Merge one person into another: record a variant -> canonical alias (so it
  // survives rescans), then repoint this person's book links to the target and
  // delete the now-orphaned author rows. Covers authors and narrators alike,
  // since both live in the authors table (role is on the book_authors link).
  app.post("/api/library/people/merge", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(
      z.object({ from: z.string().trim().min(1).max(240), into: z.string().trim().min(1).max(240) }),
      request.body
    );
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid merge data", details: parsed.error });
      return;
    }
    const { from, into } = parsed.data;
    if (from.toLowerCase() === into.toLowerCase()) {
      reply.code(400).send({ error: "Choose a different person to merge into." });
      return;
    }

    const sourceExists = db.prepare("SELECT 1 FROM authors WHERE name = ? LIMIT 1").get(from);
    if (!sourceExists) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    db.transaction(() => {
      // Record the alias, and re-point any existing aliases that pointed at `from`.
      db.prepare(`
        INSERT INTO person_aliases (id, alias, canonical_name, created_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET canonical_name = excluded.canonical_name
      `).run(nanoid(16), from, into, request.user!.id);
      db.prepare("UPDATE person_aliases SET canonical_name = ? WHERE canonical_name = ?").run(into, from);

      // Per library, fold the `from` author row into the `into` row.
      const fromRows = db.prepare(
        "SELECT id, library_id, sort_name, bio, cover_storage_key FROM authors WHERE name = ?"
      ).all(from) as { id: string; library_id: string; sort_name: string | null; bio: string | null; cover_storage_key: string | null }[];

      for (const fromRow of fromRows) {
        let intoRow = db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?")
          .get(fromRow.library_id, into) as { id: string } | undefined;
        if (!intoRow) {
          const id = nanoid(16);
          db.prepare(
            "INSERT INTO authors (id, library_id, name, sort_name, bio, cover_storage_key) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(id, fromRow.library_id, into, fromRow.sort_name, fromRow.bio, fromRow.cover_storage_key);
          intoRow = { id };
        }
        // Repoint book links, de-duplicating on (book_id, author_id, role).
        db.prepare(`
          INSERT OR IGNORE INTO book_authors (book_id, author_id, role, sort_order)
          SELECT book_id, ?, role, sort_order FROM book_authors WHERE author_id = ?
        `).run(intoRow.id, fromRow.id);
        db.prepare("DELETE FROM book_authors WHERE author_id = ?").run(fromRow.id);
        db.prepare("DELETE FROM authors WHERE id = ?").run(fromRow.id);
      }
    })();

    logActivity({
      event: "library.person.merged",
      actorUserId: request.user!.id,
      targetType: "person",
      targetId: into,
      detail: `Merged "${from}" into "${into}".`,
      ipAddress: request.ip
    });
    reply.send({ merged: true, into });
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

    const authorRows = db.prepare(
      "SELECT id, cover_storage_key FROM authors WHERE name = ? ORDER BY rowid ASC"
    ).all(name) as { id: string; cover_storage_key: string | null }[];

    if (authorRows.length === 0) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    // Versioned file name so the replaced photo isn't masked by browser cache.
    const storageKey = thumbnailStorageKey("people", authorRows[0].id, `${authorRows[0].id}-photo-${Date.now()}${ext}`);
    const absolutePath = thumbnailAbsolutePath(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body as Buffer);

    db.prepare("UPDATE authors SET cover_storage_key = ? WHERE name = ?").run(storageKey, name);
    removeStoredPhotos(authorRows.map((row) => row.cover_storage_key).filter((key) => key !== storageKey));

    reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
  });
}
