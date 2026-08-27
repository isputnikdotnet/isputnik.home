// Bulk import of quote packs — a JSON file of famous quotes, family sayings, or
// anything else worth having in rotation, brought in as ordinary rows of the one
// `quotes` table (see quotes.ts). Imported quotes are external by construction:
// they link to no library book, so attribution is whatever the file carries.
//
// The file's shape:
//   { "version": 1,
//     "defaults": { "language": "en", "visibility": "family", "inRotation": true },
//     "quotes": [ { "text": "…", "author": "…", "source": "…", "language": "ru",
//                   "date": "1878", "context": "…", "tags": ["humour"] } ] }
//
// `defaults` describe the pack as a whole; a row overrides only its own language.
// Visibility and rotation are pack-level because they are a decision about the
// pack ("these are for the family, put them in the daily card"), not about any
// one line in it.
//
// Three things make an import safe to run twice:
//   • every row is validated ON ITS OWN, so one malformed entry is reported
//     rather than sinking the other 4999;
//   • duplicates are skipped against both the caller's existing quotes and the
//     rest of the same batch, so re-importing a pack is a no-op;
//   • ?dryRun=1 answers "what would this do" without writing anything.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { addEntityTags } from "./audiobook/categorize.js";
import { languageSchema, QUOTE_ENTITY_TYPE } from "./quotes.js";
import { partialDateSchema } from "../familytree/persons.js";

// One request's worth. Anything larger is REFUSED rather than truncated: a
// silent cap would look like a complete import that quietly lost 15,000 lines.
const MAX_QUOTES = 5000;

// How many bad rows to describe individually. The count is always exact — only
// the per-row detail is capped, so a wholly malformed file cannot answer with a
// megabyte of complaints.
const MAX_REPORTED_INVALID = 50;

const defaultsSchema = z.object({
  language: languageSchema.optional(),
  visibility: z.enum(["private", "family"]).optional(),
  inRotation: z.boolean().optional()
});

// These messages are read by whoever picked the file — a pack off the internet
// always has a few odd rows — so they say what is wrong with the row in plain
// words rather than in zod's ("Too small: expected string to have >=1 characters").
const rowSchema = z.object({
  text: z.string({ message: "the quote text is missing" })
    .trim()
    .min(1, "the quote text is empty")
    .max(10000, "the quote text is longer than 10,000 characters"),
  // Who said it and what it is from — the same pair quotes.ts snapshots for a
  // library book, which is why an imported quote displays like any other.
  author: z.string().trim().max(300, "the author name is too long").optional(),
  source: z.string().trim().max(300, "the source title is too long").optional(),
  language: languageSchema.optional(),
  date: partialDateSchema.optional(),
  context: z.string().trim().max(500, "the context note is too long").optional(),
  // Stored now even though the tag UI lands later: dedup means a re-import after
  // that UI exists would skip every row, so tags dropped here are lost for good.
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional()
});

// Rows arrive as `unknown` on purpose — each is parsed in the loop below so a
// bad one yields its index and reason instead of failing the whole request.
const envelopeSchema = z.object({
  version: z.number().int().optional(),
  defaults: defaultsSchema.optional(),
  quotes: z.array(z.unknown()).min(1),
  // What the admin picked, sent by the client so the import can be recognised
  // later and undone as one event. Cosmetic, so a missing or silly name costs
  // nothing but a nameless row in the list.
  fileName: z.string().trim().max(255).optional()
});

type ImportRow = z.infer<typeof rowSchema>;

// Case- and whitespace-insensitive identity for a quote, as a two-element JSON
// array so the halves can never run together. Deliberately computed in JS rather
// than SQL: SQLite's lower() is ASCII-only, so a Russian pack would dedup
// against nothing at all.
function dedupKey(text: string, author: string | null | undefined): string {
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify([norm(text), norm(author ?? "")]);
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
    .join("; ");
}

export function registerQuoteImportRoutes(app: FastifyInstance) {
  // The runs this admin has made, newest first — the list the manage page shows.
  // `quoteCount` is recomputed rather than read from the stored count, so a run
  // whose quotes were deleted one by one reports what is actually left.
  app.get("/api/library/quotes/imports", { preHandler: app.requireAdmin }, async (request, reply) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT i.id, i.file_name, i.created_at, i.quote_count AS imported_count,
        (SELECT COUNT(*) FROM quotes q WHERE q.import_id = i.id AND q.user_id = i.user_id) AS remaining
      FROM quote_imports i
      WHERE i.user_id = ?
      ORDER BY datetime(i.created_at) DESC
    `).all(user.id) as {
      id: string; file_name: string | null; created_at: string;
      imported_count: number; remaining: number;
    }[];

    return reply.send({
      imports: rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        createdAt: row.created_at,
        importedCount: row.imported_count,
        remainingCount: row.remaining
      }))
    });
  });

  // Undo one run: its quotes, their tag links, and the record itself. Scoped to
  // the caller's own rows like every other quote delete, so one admin can never
  // clear another's import.
  app.delete("/api/library/quotes/imports/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const user = request.user!;
    const importId = (request.params as { id: string }).id;

    const record = db.prepare("SELECT id, file_name FROM quote_imports WHERE id = ? AND user_id = ?")
      .get(importId, user.id) as { id: string; file_name: string | null } | undefined;
    if (!record) return reply.code(404).send({ error: "Import not found" });

    const ids = (db.prepare("SELECT id FROM quotes WHERE import_id = ? AND user_id = ?")
      .all(importId, user.id) as { id: string }[]).map((row) => row.id);

    db.transaction(() => {
      const dropTags = db.prepare("DELETE FROM taggables WHERE entity_type = ? AND entity_id = ?");
      for (const id of ids) dropTags.run(QUOTE_ENTITY_TYPE, id);
      db.prepare("DELETE FROM quotes WHERE import_id = ? AND user_id = ?").run(importId, user.id);
      db.prepare("DELETE FROM quote_imports WHERE id = ? AND user_id = ?").run(importId, user.id);
    })();

    logActivity({
      event: "quotes.import_deleted",
      actorUserId: user.id,
      targetType: "quote",
      targetId: importId,
      detail: `Deleted ${ids.length} quote${ids.length === 1 ? "" : "s"} imported from ${record.file_name ?? "a file"}.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: ids.length });
  });

  // ADMIN ONLY. A pack is a shared library the whole house reads from, not a
  // personal list — so curating it is an administrative act, like adding a
  // library. (The GEDCOM import next door is gated the same way, for the same
  // reason.) Everyone can still add their own quotes one at a time.
  //
  // The client sends the file's parsed contents as JSON. Fastify's default 1 MiB
  // body limit is well under a few thousand quotes, hence the per-route override.
  app.post(
    "/api/library/quotes/import",
    { preHandler: app.requireAdmin, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const user = request.user!;
      const dryRun = String((request.query as { dryRun?: string }).dryRun ?? "") === "1";

      const parsed = parseBody(envelopeSchema, request.body);
      if (parsed.error) {
        return reply.code(400).send({ error: "Invalid import file", details: parsed.error });
      }
      const { version, defaults, quotes: rows, fileName } = parsed.data;

      if (version !== undefined && version !== 1) {
        return reply.code(400).send({
          error: `This file says format version ${version}; this server reads version 1.`
        });
      }
      if (rows.length > MAX_QUOTES) {
        return reply.code(400).send({
          error: `That file holds ${rows.length} quotes — more than the ${MAX_QUOTES} one import can take. Split it into smaller files.`
        });
      }

      // A pack is for the family and for the daily card unless it says otherwise:
      // importing quotes nobody but the importer can see would defeat the point.
      const visibility = defaults?.visibility ?? "family";
      const inRotation = (defaults?.inRotation ?? true) ? 1 : 0;
      const packLanguage = defaults?.language ?? null;

      // Everything this user already has, keyed the way the incoming rows are.
      const seen = new Set<string>(
        (db.prepare("SELECT text, source_author FROM quotes WHERE user_id = ?").all(user.id) as {
          text: string;
          source_author: string | null;
        }[]).map((row) => dedupKey(row.text, row.source_author))
      );

      const invalid: { index: number; reason: string }[] = [];
      let invalidCount = 0;
      let skippedDuplicates = 0;
      const ready: ImportRow[] = [];

      rows.forEach((raw, index) => {
        const row = rowSchema.safeParse(raw);
        if (!row.success) {
          invalidCount += 1;
          if (invalid.length < MAX_REPORTED_INVALID) {
            invalid.push({ index, reason: describe(row.error) });
          }
          return;
        }
        const key = dedupKey(row.data.text, row.data.author);
        if (seen.has(key)) {
          skippedDuplicates += 1;
          return;
        }
        // Adding it here is what dedups the batch against ITSELF, not merely
        // against the database.
        seen.add(key);
        ready.push(row.data);
      });

      if (!dryRun && ready.length > 0) {
        const insert = db.prepare(`
          INSERT INTO quotes (
            id, user_id, text, source_title, source_author,
            origin, visibility, in_rotation, language, quote_date, context, import_id
          )
          VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?)
        `);
        // The run is recorded before its rows so they can point at it, and only
        // on a real import — a dry run writes nothing at all, including this.
        const importId = nanoid(16);
        db.transaction(() => {
          db.prepare("INSERT INTO quote_imports (id, user_id, file_name, quote_count) VALUES (?, ?, ?, ?)")
            .run(importId, user.id, fileName ?? null, ready.length);
          for (const row of ready) {
            const id = nanoid(16);
            insert.run(
              id,
              user.id,
              row.text,
              row.source ?? null,
              row.author ?? null,
              visibility,
              inRotation,
              row.language ?? packLanguage,
              row.date ?? null,
              row.context ?? null,
              importId
            );
            if (row.tags && row.tags.length > 0) addEntityTags(QUOTE_ENTITY_TYPE, id, row.tags);
          }
        })();
        logActivity({
          event: "quotes.imported",
          actorUserId: user.id,
          targetType: "quote",
          detail: `Imported ${ready.length} quote${ready.length === 1 ? "" : "s"} from a file`
            + (skippedDuplicates > 0 ? `, skipping ${skippedDuplicates} already saved.` : "."),
          ipAddress: request.ip
        });
      }

      return reply.send({
        dryRun,
        total: rows.length,
        // On a dry run this is what WOULD be imported.
        imported: ready.length,
        skippedDuplicates,
        invalidCount,
        invalid
      });
    }
  );
}
