// Quote of the day — one quote from the shared pool, the same one all day.
//
// DERIVED, never stored, like every other home card: the pick is a pure function
// of (the viewer's calendar date, the pool, the chosen category). Nothing is
// scheduled, nothing is written, and two requests on the same day agree because
// they compute the same answer — not because anyone saved it.
//
// The pool is `in_rotation` quotes the viewer may see: everything marked
// 'family', plus their own. Imported packs opt in by default, which is what
// makes an admin's import show up on everyone's home page.
//
// The pick WALKS the pool by date rather than hashing it: the whole house moves
// one quote further each day, so a small library is seen in full instead of
// repeating at random.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { normalizeText } from "./audiobook/categorize.js";
import { QUOTE_ENTITY_TYPE } from "./quotes.js";

export interface DailyQuote {
  quoteId: string;
  text: string;
  /** Who said it — the speaker's name, else whoever the source is credited to. */
  attribution: string | null;
  /** The work it came from, when there is one. */
  source: string | null;
  /** The category this pick was drawn from; null when drawn from everything. */
  category: string | null;
  /** Every category the pool offers, for the card's switcher. */
  categories: string[];
  /**
   * Years since it was said, when today is the anniversary of the day it was
   * said. Null for an ordinary rotation pick — which is what the card reads to
   * decide between "Quote of the day" and "5 years ago today".
   */
  yearsAgo: number | null;
}

interface PoolRow {
  id: string;
  text: string;
  source_title: string | null;
  source_author: string | null;
  person_name: string | null;
  language: string | null;
  quote_date: string | null;
}

// An anniversary needs the exact day, so only a FULL date qualifies: 'YYYY' and
// 'YYYY-MM' say when something was said without saying which day, and a quote
// dated to a year cannot have a day to come round again.
//
// The year must be strictly past — something said this morning is not "0 years
// ago today".
function yearsSince(quoteDate: string | null, today: string): number | null {
  if (!quoteDate || !/^\d{4}-\d{2}-\d{2}$/.test(quoteDate)) return null;
  if (quoteDate.slice(5) !== today.slice(5)) return null;
  const years = Number(today.slice(0, 4)) - Number(quoteDate.slice(0, 4));
  return years > 0 ? years : null;
}

/** 'pt-BR' and 'pt' are the same language for the purpose of picking a quote. */
function primaryLanguage(value: string | null): string {
  return (value ?? "").trim().toLowerCase().split("-")[0];
}

export function dailyQuote(
  user: { id: string },
  date: string,
  opts: { language?: string; category?: string } = {}
): DailyQuote | null {
  const pool = db.prepare(`
    SELECT id, text, source_title, source_author, person_name, language, quote_date
    FROM quotes
    WHERE in_rotation = 1 AND (visibility = 'family' OR user_id = ?)
    ORDER BY id
  `).all(user.id) as PoolRow[];
  if (pool.length === 0) return null;

  // Categories are tags. Only the ones the POOL wears are offered, so the
  // switcher stays as short as the library is — never the whole tag table.
  const tagRows = db.prepare(`
    SELECT taggables.entity_id AS quote_id, tags.display_name AS name, tags.key AS key
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = ?
      AND taggables.entity_id IN (${pool.map(() => "?").join(", ")})
  `).all(QUOTE_ENTITY_TYPE, ...pool.map((row) => row.id)) as
    { quote_id: string; name: string; key: string }[];

  const keysByQuote = new Map<string, Set<string>>();
  const nameByKey = new Map<string, string>();
  for (const row of tagRows) {
    nameByKey.set(row.key, row.name);
    const keys = keysByQuote.get(row.quote_id);
    if (keys) keys.add(row.key);
    else keysByQuote.set(row.quote_id, new Set([row.key]));
  }
  const categories = [...nameByKey.values()].sort((a, b) => a.localeCompare(b));

  // A category the pool no longer has (the last Funny quote was deleted, or the
  // viewer's stored choice is stale) falls back to the whole pool rather than
  // showing nothing at all.
  const wantedKey = opts.category ? normalizeText(opts.category) : "";
  const inCategory = wantedKey
    ? pool.filter((row) => keysByQuote.get(row.id)?.has(wantedKey))
    : pool;
  const categoryHeld = wantedKey && inCategory.length > 0;
  let candidates = categoryHeld ? inCategory : pool;

  // YYYYMMDD as a number: one step per day, and every viewer in the house lands
  // on the same quote because they send the same local date.
  const dayNumber = Number(date.replace(/-/g, "")) || 0;

  // Something said on this day in an earlier year outranks the rotation: a
  // remembered moment beats a line drawn in turn.
  //
  // Only when the pick is NOT narrowed to a category. Choosing "Funny" is the
  // viewer steering, and steering has to work — an anniversary that ignored the
  // choice would make the switcher look broken. On "All" (or a stale category
  // the pool no longer has) the anniversary is exactly what they want to see.
  //
  // No language filter either: there is only one thing that was said on that
  // date, and dropping it for being in the wrong language would lose the point.
  if (!categoryHeld) {
    const anniversaries = pool
      .map((row) => ({ row, yearsAgo: yearsSince(row.quote_date, date) }))
      .filter((entry): entry is { row: PoolRow; yearsAgo: number } => entry.yearsAgo !== null);
    if (anniversaries.length > 0) {
      const pick = anniversaries[dayNumber % anniversaries.length];
      return { ...publicShape(pick.row, categories), category: null, yearsAgo: pick.yearsAgo };
    }
  }

  // The viewer's own language wins when the pool speaks it; otherwise everything
  // stays in play — a Russian reader should still get a quote, not a blank card.
  const wantedLanguage = primaryLanguage(opts.language ?? null);
  if (wantedLanguage) {
    const sameLanguage = candidates.filter((row) => primaryLanguage(row.language) === wantedLanguage);
    if (sameLanguage.length > 0) candidates = sameLanguage;
  }

  const row = candidates[dayNumber % candidates.length];

  return {
    ...publicShape(row, categories),
    category: categoryHeld ? (nameByKey.get(wantedKey) ?? null) : null,
    yearsAgo: null
  };
}

/** The half of the answer that does not depend on how the quote was chosen. */
function publicShape(row: PoolRow, categories: string[]) {
  return {
    quoteId: row.id,
    text: row.text,
    attribution: row.person_name ?? row.source_author,
    source: row.source_title,
    categories
  };
}

export function registerDailyQuoteRoutes(app: FastifyInstance) {
  // The home card already arrives with the feed; this is what the card's category
  // switcher calls, so changing category swaps one quote instead of refetching
  // the whole front page.
  app.get("/api/library/quotes/daily", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { date?: string; lang?: string; category?: string };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? "") ? query.date! : serverLocalDate();
    return reply.send({
      quote: dailyQuote(request.user!, date, { language: query.lang, category: query.category })
    });
  });
}

/** Fallback when the client sends no (or a malformed) local date. */
function serverLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
