// Home — the front page's ranked card feed. Cross-module product logic: it
// composes over the library, gallery and social loaders, so it lives beside
// them rather than inside any one of them.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseQuery } from "../../core/shared.js";
import { loadHomeFeed, type HomeCard } from "./feed.js";
import { getSections } from "../../core/sections.js";
import { loadForYouRows } from "../social/for-you.js";
import { registerWhatsNewRoutes } from "./whats-new.js";

/** How many waiting rows the front page shows before "See all". */
const HOME_WAITING_ROWS = 3;

// All strings: a malformed date falls back to today below rather than failing.
const feedQuerySchema = z.object({
  date: z.string().optional(),
  lang: z.string().optional(),
  quoteCategory: z.string().optional(),
  quoteCategories: z.string().optional()
});

export async function homePlugin(app: FastifyInstance) {
  registerWhatsNewRoutes(app);

  // `date` is the VIEWER'S local calendar date (the server may sit in another
  // timezone), same contract as the gallery memories endpoint. A malformed or
  // impossible one falls back to the server's local day.
  app.get("/api/home/feed", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(feedQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    let date = qp.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      const now = new Date();
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    // lang + quoteCategory steer the quote of the day only: which language it
    // prefers, and which category the viewer last chose on the card itself.
    // What is waiting on this person rides with the feed: the first three rows
    // and the total, so Home shows them and links to the rest (docs/for-you-plan.md).
    const waiting = loadForYouRows(request.user!);
    return {
      waiting: waiting.slice(0, HOME_WAITING_ROWS),
      waitingTotal: waiting.length,
      cards: onlySectionsOn(loadHomeFeed(request.user!, date, {
        language: qp.lang,
        quoteCategory: qp.quoteCategory,
        // Comma-separated, and capped: a hand-built URL should not be able to
        // make the card evaluate an unbounded list of names.
        quoteCategories: (qp.quoteCategories ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .slice(0, 24)
      }))
    };
  });
}

// A card belongs to the section it opens; with that section switched off
// (core/sections.ts) the card is left out. The quote and the book batches of a
// type still on stay.
function onlySectionsOn(cards: HomeCard[]): HomeCard[] {
  const sections = getSections();
  return cards.filter((card) => {
    switch (card.type) {
      case "memory":
      case "photos_added":
      case "note":
      case "album":
      case "slideshow":
      case "person":
        return sections.gallery;
      case "story":
      case "story_update":
        return sections.stories;
      case "series_next":
        return card.item.kind === "ebook" ? sections.ebooks : sections.audiobooks;
      case "added_batch":
        // Counted within bookLibraryIds(), which already leaves out a type that is off.
        return sections.audiobooks || sections.ebooks;
      default:
        return true;
    }
  });
}
