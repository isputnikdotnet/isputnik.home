// Quotes / highlights — a cross-type, user-owned entity that lives at the library
// level (like the bookmarks listing in bookmarks.ts) rather than inside one media
// plugin, because a quote need not belong to any library book at all.
//
// Three shapes over one table (see schema.sql `quotes`):
//   • in-reader     — item_id + document_id + cfi set; the cfi anchors an on-page
//                     highlight and is the jump target back into the reader.
//   • book-linked   — item_id set, no cfi (e.g. attached to a book by hand).
//   • external      — all NULL; just `text` + a free-text source the user typed.
//
// source_title/source_author are snapshotted on save so attribution survives the
// book being deleted (its FK is ON DELETE SET NULL). Display still prefers the
// live item metadata whenever item_id resolves.
//
// Beyond the passage itself a quote carries: `origin` (derived here, never sent
// by the client), `visibility` — private to its owner until raised to 'family',
// which is what lets a row reach a shared surface — `in_rotation` for the Quote
// of the day pool, and the optional language/date/context a famous or family
// quote wants.
import { z } from "zod";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import {
  accessibleLibraryIds,
  canUserAccessBook,
  getLibraryForBook,
  getReadableDocument
} from "./shared/library-access.js";
import { userHasItemShare } from "./shared/share-access.js";
import { normalizeText, setEntityTags } from "./audiobook/categorize.js";
import { mediaKind } from "./shared/library-types.js";
// A quote's date is the same partial ISO date a family member's birth date is
// ('YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'), deliberately: the two sort and read alike,
// and a family saying dated to a year sits next to the person who said it.
import { partialDateSchema } from "../familytree/persons.js";

/** A quote's name in the polymorphic tag (and later collection) tables. */
export const QUOTE_ENTITY_TYPE = "quote";

/** One screenful of the Quotes page, and the most a caller may ask for. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** Category chips offered as filters — the most-used, not every tag ever. */
const MAX_CATEGORY_FILTERS = 12;

interface QuoteRow {
  id: string;
  user_id: string;
  item_id: string | null;
  document_id: string | null;
  cfi: string | null;
  text: string;
  note: string | null;
  color: string | null;
  source_title: string | null;
  source_author: string | null;
  percent_complete: number | null;
  origin: string;
  visibility: string;
  in_rotation: number;
  language: string | null;
  quote_date: string | null;
  context: string | null;
  family_tree_person_id: string | null;
  person_name: string | null;
  live_person_name: string | null;
  created_at: string;
  updated_at: string;
  // Joined from the live item when item_id still resolves (NULL for external quotes).
  library_id: string | null;
  library_type: string | null;
  folder_path: string | null;
  item_title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
  owner_name: string | null;
}

function splitNames(value: string | null): string[] {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

// Shared SELECT — left-joins the live item so item-linked quotes carry current
// title/author/cover, while external quotes (no item, or a removed one) come back
// with the joined columns NULL and fall back to the snapshot.
const QUOTE_SELECT = `
  SELECT
    q.id, q.user_id, q.item_id, q.document_id, q.cfi, q.text, q.note, q.color,
    q.source_title, q.source_author, q.percent_complete,
    q.origin, q.visibility, q.in_rotation, q.language, q.quote_date, q.context,
    q.family_tree_person_id, q.person_name, speaker.name AS live_person_name,
    q.created_at, q.updated_at,
    library_items.library_id, libraries.type AS library_type, library_items.folder_path,
    item_metadata.title AS item_title, item_metadata.cover_storage_key,
    GROUP_CONCAT(DISTINCT authors.name) AS author_names,
    owner.display_name AS owner_name
  FROM quotes q
  LEFT JOIN users AS owner ON owner.id = q.user_id
  LEFT JOIN family_tree_persons AS speaker ON speaker.id = q.family_tree_person_id
  LEFT JOIN library_items ON library_items.id = q.item_id AND library_items.deleted_at IS NULL
  LEFT JOIN libraries ON libraries.id = library_items.library_id
  LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
  LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
  LEFT JOIN people AS authors ON authors.id = item_people.person_id
`;

function publicQuote(row: QuoteRow, viewerId: string, tags: string[] = []) {
  const liveTitle = row.item_title ?? (row.folder_path ? path.basename(row.folder_path) : null);
  const liveAuthors = splitNames(row.author_names);
  // Prefer live item metadata; fall back to the snapshot taken at save time.
  const sourceTitle = liveTitle ?? row.source_title ?? null;
  const sourceAuthors = liveAuthors.length > 0
    ? liveAuthors
    : (row.source_author ? [row.source_author] : []);
  const mine = row.user_id === viewerId;
  return {
    id: row.id,
    // Only the owner may edit or delete; everyone else reads. Naming who saved a
    // shared quote is the point of a family library — "Grandma kept this one".
    mine,
    ownerName: mine ? null : row.owner_name,
    tags,
    // item_id may be set in the table but null here if the book was removed/soft-deleted.
    itemId: row.library_id ? row.item_id : null,
    documentId: row.document_id,
    cfi: row.cfi,
    text: row.text,
    note: row.note,
    color: row.color,
    percentComplete: row.percent_complete,
    origin: row.origin,
    visibility: row.visibility,
    inRotation: row.in_rotation === 1,
    language: row.language,
    quoteDate: row.quote_date,
    context: row.context,
    // WHO SAID IT. Prefer the live person (they may have been renamed); fall back
    // to the snapshot when the person is gone, so a deleted relative leaves their
    // sayings attributed rather than anonymous.
    personId: row.family_tree_person_id,
    personName: row.live_person_name ?? row.person_name,
    sourceTitle,
    sourceAuthors,
    libraryType: row.library_type ? mediaKind(row.library_type) : null,
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Tags for a set of quotes, in one query rather than joined into QUOTE_SELECT —
// that statement already GROUP_CONCATs over two joins, and a third multiplying
// join is how those turn into wrong counts.
function tagsForQuotes(ids: string[]): Map<string, string[]> {
  const byQuote = new Map<string, string[]>();
  if (ids.length === 0) return byQuote;
  const rows = db.prepare(`
    SELECT taggables.entity_id AS quote_id, tags.display_name AS name
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = ? AND taggables.entity_id IN (${ids.map(() => "?").join(", ")})
    ORDER BY tags.display_name
  `).all(QUOTE_ENTITY_TYPE, ...ids) as { quote_id: string; name: string }[];
  for (const row of rows) {
    const list = byQuote.get(row.quote_id);
    if (list) list.push(row.name);
    else byQuote.set(row.quote_id, [row.name]);
  }
  return byQuote;
}

function fetchQuote(id: string): QuoteRow | undefined {
  return db.prepare(`${QUOTE_SELECT} WHERE q.id = ? GROUP BY q.id`).get(id) as QuoteRow | undefined;
}

// Shape, not membership: an imported pack may carry any language, and rejecting
// codes the UI has no locale for would throw away perfectly good quotes.
export const languageSchema = z.string().trim()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, "Use a language code like 'en' or 'ru'");

// Metadata every write path shares. `origin` is absent on purpose — the server
// derives it, so a client cannot pass a reader highlight off as an import.
const metadataFields = {
  visibility: z.enum(["private", "family"]).optional(),
  inRotation: z.boolean().optional(),
  language: languageSchema.nullable().optional(),
  quoteDate: partialDateSchema.nullable().optional(),
  context: z.string().trim().max(500).nullable().optional(),
  // A quote's categories (Funny, Kids, …). Free-form and shared with every other
  // tagged thing, so the daily card can offer exactly the ones quotes actually use.
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  // WHO SAID IT — a family-tree person. Distinct from sourceAuthor, which is who
  // wrote the book. Reading the tree is open to every signed-in user, so linking
  // needs no edit right on the person: the quote is the thing being edited.
  familyTreePersonId: z.string().trim().min(1).nullable().optional()
};

const createSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  itemId: z.string().trim().min(1).nullable().optional(),
  documentId: z.string().trim().min(1).nullable().optional(),
  cfi: z.string().trim().min(1).max(2000).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  percentComplete: z.number().min(0).max(1).nullable().optional(),
  sourceTitle: z.string().trim().max(300).nullable().optional(),
  sourceAuthor: z.string().trim().max(300).nullable().optional(),
  ...metadataFields
});

const updateSchema = z.object({
  text: z.string().trim().min(1).max(10000).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  sourceTitle: z.string().trim().max(300).nullable().optional(),
  sourceAuthor: z.string().trim().max(300).nullable().optional(),
  ...metadataFields
});

// The speaker as stored: the id plus a name snapshot, so a deleted relative
// leaves their sayings attributed rather than anonymous (the FK is SET NULL).
// Returns null when the id names nobody, so the caller can 404.
function resolveSpeaker(personId: string | null | undefined): { id: string | null; name: string | null } | null {
  if (personId === undefined || personId === null) return { id: null, name: null };
  const person = db.prepare("SELECT id, name FROM family_tree_persons WHERE id = ?")
    .get(personId) as { id: string; name: string } | undefined;
  return person ? { id: person.id, name: person.name } : null;
}

export function registerQuoteRoutes(app: FastifyInstance) {
  // All my quotes (Quotes page), or just one document's quotes (the reader, to
  // redraw its highlights) when ?documentId is given.
  //
  // The page pages. A family that imports a couple of quote packs has thousands
  // of these, and answering with every one of them — to be filtered and grouped
  // in the browser — stopped being reasonable the moment bulk import existed.
  // Search, filter and paging all happen in SQL; the client renders what it is
  // given and asks for more.
  app.get("/api/library/quotes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as {
      documentId?: string; personId?: string; q?: string;
      filter?: string; tag?: string; offset?: string; limit?: string;
    };
    const documentId = (query.documentId ?? "").trim();
    const personId = (query.personId ?? "").trim();
    const search = (query.q ?? "").trim();
    const filter = (query.filter ?? "").trim();
    const tag = (query.tag ?? "").trim();
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(query.limit) || DEFAULT_PAGE));

    // The reader asks per document and wants ITS OWN highlights back to redraw —
    // never someone else's, and never a page of them: it needs the lot to paint
    // the margins.
    if (documentId) {
      const rows = db.prepare(`
        ${QUOTE_SELECT} WHERE q.user_id = ? AND q.document_id = ?
        GROUP BY q.id ORDER BY datetime(q.created_at) DESC
      `).all(user.id, documentId) as QuoteRow[];
      const tags = tagsForQuotes(rows.map((row) => row.id));
      return reply.send({
        quotes: rows.map((row) => publicQuote(row, user.id, tags.get(row.id) ?? [])),
        total: rows.length
      });
    }

    const where: string[] = [];
    const args: (string | number)[] = [];

    // Your own quotes plus every quote anyone marked as shared — the rule every
    // quote surface uses.
    where.push("(q.user_id = ? OR q.visibility = 'family')");
    args.push(user.id);

    // Access to item-linked quotes, in SQL rather than a JS pass afterwards: a
    // filter applied after the LIMIT would page over rows it then threw away,
    // giving short pages and a total that lies.
    const allowed = [...accessibleLibraryIds(user.id, user.role)];
    where.push(`(
      q.item_id IS NULL
      OR library_items.id IS NULL
      ${allowed.length > 0 ? `OR library_items.library_id IN (${allowed.map(() => "?").join(", ")})` : ""}
      OR EXISTS (
        SELECT 1 FROM shares
        WHERE shares.resource_id = q.item_id
          AND shares.user_id = ?
          AND shares.module = CASE libraries.type
            WHEN 'ebook' THEN 'ebook' WHEN 'gallery' THEN 'gallery' ELSE 'audiobook' END
          AND shares.revoked_at IS NULL
          AND (shares.expires_at IS NULL OR datetime(shares.expires_at) > datetime('now'))
      )
    )`);
    args.push(...allowed, user.id);

    // ?personId scopes to one family member's sayings, for their profile.
    if (personId) {
      where.push("q.family_tree_person_id = ?");
      args.push(personId);
    }
    if (filter === "mine") {
      where.push("q.user_id = ?");
      args.push(user.id);
    } else if (filter === "rotation") {
      where.push("q.in_rotation = 1");
    } else if (filter === "import" || filter === "reader" || filter === "manual") {
      where.push("q.origin = ?");
      args.push(filter);
    }
    if (tag) {
      where.push(`EXISTS (
        SELECT 1 FROM taggables
        JOIN tags ON tags.id = taggables.tag_id
        WHERE taggables.entity_type = ? AND taggables.entity_id = q.id AND tags.key = ?
      )`);
      args.push(QUOTE_ENTITY_TYPE, normalizeText(tag));
    }
    if (search) {
      // lower_unicode(), not LIKE's own folding: SQLite only case-folds ASCII, so
      // a search for "цитата" would miss "Цитата" — half this library is Russian.
      const columns = ["q.text", "q.source_title", "q.source_author", "q.person_name", "q.context", "q.note"];
      where.push(`(${columns.map((c) => `lower_unicode(${c}) LIKE ?`).join(" OR ")})`);
      const needle = `%${search.toLowerCase()}%`;
      args.push(...columns.map(() => needle));
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const from = `
      FROM quotes q
      LEFT JOIN library_items ON library_items.id = q.item_id AND library_items.deleted_at IS NULL
      LEFT JOIN libraries ON libraries.id = library_items.library_id
    `;

    const { total } = db.prepare(`SELECT COUNT(*) AS total ${from} ${whereSql}`)
      .get(...args) as { total: number };

    const rows = db.prepare(`
      ${QUOTE_SELECT} ${whereSql}
      GROUP BY q.id ORDER BY datetime(q.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as QuoteRow[];

    // The categories offered as filters, counted over everything the current
    // search and filter match — not just this page, or the chips would change
    // shape as you scrolled. The active tag is excluded from its own count so
    // clearing it is possible.
    const categoryArgs = args.slice(0, args.length);
    const categories = db.prepare(`
      SELECT tags.display_name AS name, COUNT(*) AS count
      FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      WHERE taggables.entity_type = ?
        AND taggables.entity_id IN (SELECT q.id ${from} ${whereSql})
      GROUP BY tags.id ORDER BY count DESC, name ASC LIMIT ?
    `).all(QUOTE_ENTITY_TYPE, ...categoryArgs, MAX_CATEGORY_FILTERS) as { name: string; count: number }[];

    const tags = tagsForQuotes(rows.map((row) => row.id));
    return reply.send({
      quotes: rows.map((row) => publicQuote(row, user.id, tags.get(row.id) ?? [])),
      total,
      categories
    });
  });

  app.post("/api/library/quotes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid quote", details: parsed.error });
    }
    const data = parsed.data;

    // When the quote links a library book, the caller must be able to read it.
    if (data.itemId) {
      if (data.documentId) {
        if (!getReadableDocument(data.itemId, data.documentId, user)) {
          return reply.code(404).send({ error: "Document not found" });
        }
      } else {
        const library = getLibraryForBook(data.itemId);
        if (!library || !canUserAccessBook(data.itemId, library, user.id, user.role, mediaKind(library.type))) {
          return reply.code(404).send({ error: "Book not found" });
        }
      }
    }

    // Snapshot the book's title/author so attribution survives its deletion, unless
    // the caller supplied an explicit source (an external quote, or a manual override).
    let sourceTitle = data.sourceTitle ?? null;
    let sourceAuthor = data.sourceAuthor ?? null;
    if (data.itemId && (!sourceTitle || !sourceAuthor)) {
      const snap = db.prepare(`
        SELECT item_metadata.title AS title, library_items.folder_path AS folder_path,
          (SELECT people.name FROM item_people
             JOIN people ON people.id = item_people.person_id
             WHERE item_people.item_id = library_items.id AND item_people.role = 'author'
             LIMIT 1) AS author
        FROM library_items
        LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
        WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      `).get(data.itemId) as { title: string | null; folder_path: string | null; author: string | null } | undefined;
      if (snap) {
        if (!sourceTitle) sourceTitle = snap.title ?? (snap.folder_path ? path.basename(snap.folder_path) : null);
        if (!sourceAuthor) sourceAuthor = snap.author ?? null;
      }
    }

    const speaker = resolveSpeaker(data.familyTreePersonId);
    if (!speaker) return reply.code(404).send({ error: "Family member not found" });

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO quotes (
        id, user_id, item_id, document_id, cfi, text, note, color,
        source_title, source_author, percent_complete,
        origin, visibility, in_rotation, language, quote_date, context,
        family_tree_person_id, person_name
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.id,
      data.itemId ?? null,
      data.documentId ?? null,
      data.cfi ?? null,
      data.text,
      data.note ?? null,
      data.color ?? null,
      sourceTitle,
      sourceAuthor,
      data.percentComplete ?? null,
      // Anchored in a document = captured while reading; everything else through
      // this route was typed by hand. Imports set their own origin.
      data.documentId ? "reader" : "manual",
      data.visibility ?? "private",
      data.inRotation ? 1 : 0,
      data.language ?? null,
      data.quoteDate ?? null,
      data.context ?? null,
      speaker.id,
      speaker.name
    );

    if (data.tags) setEntityTags(QUOTE_ENTITY_TYPE, id, data.tags);
    return reply.code(201).send({
      quote: publicQuote(fetchQuote(id)!, user.id, tagsForQuotes([id]).get(id) ?? [])
    });
  });

  app.patch("/api/library/quotes/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const quoteId = (request.params as { id: string }).id;

    const existing = db.prepare("SELECT id FROM quotes WHERE id = ? AND user_id = ?").get(quoteId, user.id);
    if (!existing) {
      return reply.code(404).send({ error: "Quote not found" });
    }

    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid quote", details: parsed.error });
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    // Empty string clears the column — the editor sends "" for a field the user
    // emptied. A boolean can't go through here (false would clear rather than
    // store 0), so the rotation flag has its own setter.
    const set = (column: string, value: string | null | undefined) => {
      if (value === undefined) return;
      updates.push(`${column} = ?`);
      values.push(value || null);
    };
    const setFlag = (column: string, value: boolean | undefined) => {
      if (value === undefined) return;
      updates.push(`${column} = ?`);
      values.push(value ? 1 : 0);
    };
    set("text", parsed.data.text);
    set("note", parsed.data.note);
    set("color", parsed.data.color);
    set("source_title", parsed.data.sourceTitle);
    set("source_author", parsed.data.sourceAuthor);
    set("visibility", parsed.data.visibility);
    setFlag("in_rotation", parsed.data.inRotation);
    set("language", parsed.data.language);
    set("quote_date", parsed.data.quoteDate);
    set("context", parsed.data.context);
    if (parsed.data.familyTreePersonId !== undefined) {
      const speaker = resolveSpeaker(parsed.data.familyTreePersonId);
      if (!speaker) return reply.code(404).send({ error: "Family member not found" });
      // Never let the two drift: unlinking clears the snapshot too, or a quote
      // would keep claiming a speaker it is no longer attached to.
      updates.push("family_tree_person_id = ?", "person_name = ?");
      values.push(speaker.id, speaker.name);
    }

    if (updates.length > 0) {
      db.prepare(`
        UPDATE quotes SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
      `).run(...values, quoteId);
    }

    // Tags live in taggables rather than a column, so they apply even when no
    // column changed — the same rule the family-tree person editor follows.
    if (parsed.data.tags) setEntityTags(QUOTE_ENTITY_TYPE, quoteId, parsed.data.tags);
    return reply.send({
      quote: publicQuote(fetchQuote(quoteId)!, user.id, tagsForQuotes([quoteId]).get(quoteId) ?? [])
    });
  });

  // Undo a bulk import. One click brings in thousands of quotes, and without
  // this the only way back out is deleting them one at a time — which is no way
  // to recover from a pack that turned out to be full of rubbish.
  //
  // Deliberately narrow: the caller's OWN quotes, and only the ones an import
  // brought in. It can never touch a reading highlight, a hand-typed quote, or
  // anyone else's — so the worst case is losing a pack that can be imported
  // again. Registered before /:id, though fastify would prefer the static
  // segment anyway; quote ids are 16-character nanoids, so none can read
  // "imported" and become unreachable.
  app.delete("/api/library/quotes/imported", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const ids = (db.prepare("SELECT id FROM quotes WHERE user_id = ? AND origin = 'import'")
      .all(user.id) as { id: string }[]).map((row) => row.id);
    if (ids.length === 0) return reply.send({ deleted: 0 });

    db.transaction(() => {
      const dropTags = db.prepare("DELETE FROM taggables WHERE entity_type = ? AND entity_id = ?");
      for (const id of ids) dropTags.run(QUOTE_ENTITY_TYPE, id);
      db.prepare(`DELETE FROM quotes WHERE user_id = ? AND origin = 'import'`).run(user.id);
    })();

    logActivity({
      event: "quotes.import_cleared",
      actorUserId: user.id,
      targetType: "quote",
      detail: `Deleted ${ids.length} imported quote${ids.length === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: ids.length });
  });

  app.delete("/api/library/quotes/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const quoteId = (request.params as { id: string }).id;
    const result = db.transaction(() => {
      const deleted = db.prepare("DELETE FROM quotes WHERE id = ? AND user_id = ?").run(quoteId, user.id);
      // taggables carries no FK on entity_id, so an imported quote's tag links
      // need clearing by hand — the same cleanup deleting a family person does.
      if (deleted.changes > 0) {
        db.prepare("DELETE FROM taggables WHERE entity_type = ? AND entity_id = ?").run(QUOTE_ENTITY_TYPE, quoteId);
      }
      return deleted;
    })();
    if (result.changes === 0) {
      return reply.code(404).send({ error: "Quote not found" });
    }
    return reply.send({ deleted: true });
  });
}
