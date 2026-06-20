import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { accessibleLibraryIds, canUserWriteLibrary, getAccessibleLibrary } from "../shared/library-access.js";
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
    JOIN library_items ON library_items.library_id = libraries.id
    JOIN item_people ON item_people.item_id = library_items.id
    JOIN people ON people.id = item_people.person_id
    WHERE people.name = ?
  `).all(name) as { settings_json: string }[];
  return rows
    .map((row) => normalizeLibrarySettings("audiobook", row.settings_json).default_language)
    .filter((lang): lang is string => Boolean(lang));
}

export type PersonItem = {
  id: string;
  type: string;
  role: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
};

// Every item a person is credited on, across ALL media types and every library
// the caller can access — the data behind the unified person page. People are
// global (one row per name, see schema.sql), so a single name can span
// audiobooks and ebooks; `role` says how they're credited on each item. The
// library_id filter is the entire permission story: an item in a library the
// user can't see simply never joins.
export function listPersonItems(name: string, userId: string, userRole: string): PersonItem[] {
  const libraryIds = [...accessibleLibraryIds(userId, userRole)];
  if (libraryIds.length === 0) return [];

  const placeholders = libraryIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      li.id                AS id,
      li.type              AS type,
      li.folder_path       AS folder_path,
      im.title             AS title,
      im.cover_storage_key AS cover_storage_key,
      ip.role              AS role,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names
    FROM item_people ip
    JOIN people p              ON p.id = ip.person_id
    JOIN library_items li      ON li.id = ip.item_id
    LEFT JOIN item_metadata im ON im.item_id = li.id
    LEFT JOIN item_people author_credits ON author_credits.item_id = li.id AND author_credits.role = 'author'
    LEFT JOIN people authors   ON authors.id = author_credits.person_id
    WHERE p.name = ? COLLATE NOCASE
      AND li.deleted_at IS NULL
      AND li.library_id IN (${placeholders})
    GROUP BY li.id, ip.role
    ORDER BY
      CASE ip.role WHEN 'author' THEN 0 WHEN 'narrator' THEN 1 ELSE 2 END,
      ip.role,
      COALESCE(im.sort_title, im.title, li.folder_path) COLLATE NOCASE
  `).all(name, ...libraryIds) as {
    id: string; type: string; folder_path: string; title: string | null;
    cover_storage_key: string | null; role: string; author_names: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    role: row.role,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    authors: row.author_names ? row.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null
  }));
}

export type AuthorSummary = { name: string; audiobookCount: number; ebookCount: number };

// Every person credited as an author, across all accessible libraries, with how
// many audiobooks vs ebooks they have — drives the unified Authors list and its
// All / Audiobooks / Ebooks filter. Same global-people + access-filter shape as
// listPersonItems; narrators are intentionally excluded (audiobook-only role).
export function listAuthors(userId: string, userRole: string): AuthorSummary[] {
  const libraryIds = [...accessibleLibraryIds(userId, userRole)];
  if (libraryIds.length === 0) return [];

  const placeholders = libraryIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      p.name AS name,
      SUM(CASE WHEN li.type = 'audiobook' THEN 1 ELSE 0 END) AS audiobook_count,
      SUM(CASE WHEN li.type = 'ebook' THEN 1 ELSE 0 END) AS ebook_count
    FROM people p
    JOIN item_people ip   ON ip.person_id = p.id AND ip.role = 'author'
    JOIN library_items li ON li.id = ip.item_id
    WHERE li.deleted_at IS NULL
      AND li.library_id IN (${placeholders})
    GROUP BY p.id
    ORDER BY p.sort_name COLLATE NOCASE, p.name COLLATE NOCASE
  `).all(...libraryIds) as { name: string; audiobook_count: number; ebook_count: number }[];

  return rows.map((row) => ({
    name: row.name,
    audiobookCount: row.audiobook_count,
    ebookCount: row.ebook_count
  }));
}

export async function audiobookPeoplePlugin(app: FastifyInstance) {
  app.get("/api/library/people/by-name", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }

    const row = db.prepare(`
      SELECT id, name, sort_name, bio, image_storage_key AS cover_storage_key
      FROM people WHERE name = ? LIMIT 1
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
      SELECT name, image_storage_key AS cover_storage_key
      FROM people
      WHERE image_storage_key IS NOT NULL
      ORDER BY rowid ASC
    `).all() as { name: string; cover_storage_key: string }[];

    // First row per name wins, matching the by-name endpoints.
    const photos: Record<string, string> = {};
    for (const row of rows) {
      photos[row.name] ??= `/api/library/covers/${row.cover_storage_key}`;
    }
    reply.send({ photos });
  });

  // The unified person page's data: everything this person made, across types
  // and every accessible library. See listPersonItems above.
  app.get("/api/library/people/by-name/items", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      reply.code(400).send({ error: "Name is required" });
      return;
    }
    reply.send({ items: listPersonItems(name, request.user!.id, request.user!.role) });
  });

  // Flat list of every person name (global) — feeds the merge picker on the
  // person page, which no longer derives candidates from a bulk book load.
  app.get("/api/library/people/names", { preHandler: app.authenticate }, async (_request, reply) => {
    const rows = db.prepare("SELECT name FROM people ORDER BY name COLLATE NOCASE").all() as { name: string }[];
    reply.send({ names: rows.map((row) => row.name) });
  });

  // The unified Authors browse: every author across types, with per-type counts.
  app.get("/api/library/people/authors", { preHandler: app.authenticate }, async (request, reply) => {
    reply.send({ authors: listAuthors(request.user!.id, request.user!.role) });
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

    db.prepare("UPDATE people SET name = COALESCE(?, name), bio = ?, sort_name = ? WHERE name = ?").run(
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

    const exists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(name);
    if (!exists) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    try {
      const { updatedBio, updatedPhoto, result } = await enrichPerson(name, personLookupLanguages(name));
      const row = db.prepare(`
        SELECT id, name, sort_name, bio, image_storage_key AS cover_storage_key
        FROM people WHERE name = ? LIMIT 1
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

    const existing = db.prepare("SELECT id FROM people WHERE name = ?").get(name);
    if (existing) {
      reply.code(409).send({ error: "A person with that name already exists." });
      return;
    }

    const resolvedSortName = sortName?.trim() || sortTitle(name);
    db.prepare("INSERT INTO people (id, name, sort_name, bio) VALUES (?, ?, ?, ?)")
      .run(nanoid(16), name, resolvedSortName, bio?.trim() || null);

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

    const exists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(name);
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
      "SELECT id, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
    ).all(name) as { id: string; cover_storage_key: string | null }[];
    if (rows.length === 0) {
      reply.code(404).send({ error: "Person not found" });
      return;
    }

    try {
      const storageKey = await writePersonPhoto(rows[0].id, parsed.data.url);
      db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ?").run(storageKey, name);
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

    const sourceExists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(from);
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

      // People are global: fold the single `from` person into the `into` person.
      const fromRow = db.prepare(
        "SELECT id, sort_name, bio, image_storage_key FROM people WHERE name = ?"
      ).get(from) as { id: string; sort_name: string | null; bio: string | null; image_storage_key: string | null } | undefined;
      if (!fromRow) return;

      let intoRow = db.prepare("SELECT id FROM people WHERE name = ?").get(into) as { id: string } | undefined;
      if (!intoRow) {
        const id = nanoid(16);
        db.prepare(
          "INSERT INTO people (id, name, sort_name, bio, image_storage_key) VALUES (?, ?, ?, ?, ?)"
        ).run(id, into, fromRow.sort_name, fromRow.bio, fromRow.image_storage_key);
        intoRow = { id };
      }
      if (intoRow.id !== fromRow.id) {
        // Repoint item credits, de-duplicating on (item_id, person_id, role).
        db.prepare(`
          INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order)
          SELECT item_id, ?, role, sort_order FROM item_people WHERE person_id = ?
        `).run(intoRow.id, fromRow.id);
        db.prepare("DELETE FROM item_people WHERE person_id = ?").run(fromRow.id);
        db.prepare("DELETE FROM people WHERE id = ?").run(fromRow.id);
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
      "SELECT id, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
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

    db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ?").run(storageKey, name);
    removeStoredPhotos(authorRows.map((row) => row.cover_storage_key).filter((key) => key !== storageKey));

    reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
  });
}
