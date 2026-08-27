// Home — the front page's ranked card feed. Cross-module product logic: it
// composes over the library, gallery and social loaders, so it lives beside
// them rather than inside any one of them.
import type { FastifyInstance } from "fastify";
import { loadHomeFeed } from "./feed.js";

export async function homePlugin(app: FastifyInstance) {
  // `date` is the VIEWER'S local calendar date (the server may sit in another
  // timezone), same contract as the gallery memories endpoint. A malformed or
  // impossible one falls back to the server's local day.
  app.get("/api/home/feed", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { date?: string; lang?: string; quoteCategory?: string };
    let date = qp.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      const now = new Date();
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    // lang + quoteCategory steer the quote of the day only: which language it
    // prefers, and which category the viewer last chose on the card itself.
    return {
      cards: loadHomeFeed(request.user!, date, {
        language: qp.lang,
        quoteCategory: qp.quoteCategory
      })
    };
  });
}
