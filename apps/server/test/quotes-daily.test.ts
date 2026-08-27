// Quote of the day. The card is derived, never stored, so the properties that
// matter are about the pick being a pure function of (date, pool, category):
// stable all day, different tomorrow, the same for everyone in the house, and
// never showing a quote its viewer is not allowed to see.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { dailyQuote } from "../src/modules/library/quotes-daily.js";
import { addEntityTags } from "../src/modules/library/audiobook/categorize.js";
import { resetDb, makeUser } from "./helpers/seed.js";

const me = { id: "member" };
const TODAY = "2026-08-27";

interface QuoteSeed {
  id: string;
  text: string;
  owner?: string;
  visibility?: "private" | "family";
  inRotation?: boolean;
  language?: string | null;
  tags?: string[];
}

function seedQuote(seed: QuoteSeed) {
  db.prepare(`
    INSERT INTO quotes (id, user_id, text, source_author, visibility, in_rotation, language)
    VALUES (?, ?, ?, 'Someone', ?, ?, ?)
  `).run(
    seed.id,
    seed.owner ?? "member",
    seed.text,
    seed.visibility ?? "family",
    seed.inRotation === false ? 0 : 1,
    seed.language ?? null
  );
  if (seed.tags?.length) addEntityTags("quote", seed.id, seed.tags);
}

beforeEach(() => {
  resetDb();
  makeUser("member");
  makeUser("relative");
});

describe("picking the day's quote", () => {
  it("returns nothing at all when the pool is empty", () => {
    expect(dailyQuote(me, TODAY)).toBeNull();

    // A quote that exists but is not in rotation is not a pool member.
    seedQuote({ id: "q1", text: "Not rotating", inRotation: false });
    expect(dailyQuote(me, TODAY)).toBeNull();
  });

  it("gives the same quote all day and a different one tomorrow", () => {
    for (const id of ["q1", "q2", "q3"]) seedQuote({ id, text: `Quote ${id}` });

    const first = dailyQuote(me, TODAY)!;
    expect(dailyQuote(me, TODAY)!.quoteId).toBe(first.quoteId);
    expect(dailyQuote(me, "2026-08-28")!.quoteId).not.toBe(first.quoteId);
  });

  it("shows everyone in the house the same quote", () => {
    for (const id of ["q1", "q2", "q3"]) seedQuote({ id, text: `Quote ${id}` });
    expect(dailyQuote({ id: "relative" }, TODAY)!.quoteId).toBe(dailyQuote(me, TODAY)!.quoteId);
  });

  it("walks the whole pool rather than repeating a few", () => {
    for (const id of ["q1", "q2", "q3", "q4"]) seedQuote({ id, text: `Quote ${id}` });
    const seen = new Set(
      ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"].map((day) => dailyQuote(me, day)!.quoteId)
    );
    expect(seen.size).toBe(4);
  });
});

describe("who may appear in the pool", () => {
  it("keeps someone else's private quote out, and lets your own in", () => {
    seedQuote({ id: "theirs", text: "Their secret", owner: "relative", visibility: "private" });
    seedQuote({ id: "mine", text: "My own", owner: "member", visibility: "private" });

    // Only one candidate, so every day lands on it.
    expect(dailyQuote(me, TODAY)!.quoteId).toBe("mine");
    // And the other user sees only theirs.
    expect(dailyQuote({ id: "relative" }, TODAY)!.quoteId).toBe("theirs");
  });

  it("shares a family quote with everyone", () => {
    seedQuote({ id: "shared", text: "For the house", owner: "relative", visibility: "family" });
    expect(dailyQuote(me, TODAY)!.quoteId).toBe("shared");
  });
});

describe("categories", () => {
  beforeEach(() => {
    seedQuote({ id: "funny1", text: "Ha", tags: ["Funny"] });
    seedQuote({ id: "funny2", text: "Hee", tags: ["Funny"] });
    seedQuote({ id: "kids1", text: "Why is the sky?", tags: ["Kids", "Funny"] });
    seedQuote({ id: "plain", text: "No category" });
  });

  it("offers only the categories the pool actually wears", () => {
    expect(dailyQuote(me, TODAY)!.categories).toEqual(["Funny", "Kids"]);
  });

  it("draws from the chosen category and says which one", () => {
    const picked = dailyQuote(me, TODAY, { category: "Kids" })!;
    expect(picked.quoteId).toBe("kids1");
    expect(picked.category).toBe("Kids");
  });

  it("matches a category however it was capitalised", () => {
    expect(dailyQuote(me, TODAY, { category: "kids" })!.quoteId).toBe("kids1");
  });

  it("falls back to the whole pool when the chosen category has nothing left", () => {
    // The viewer's stored choice outlives the last quote that wore it.
    const picked = dailyQuote(me, TODAY, { category: "Wisdom" })!;
    expect(picked.quoteId).toBeTruthy();
    expect(picked.category).toBeNull();
  });
});

describe("language", () => {
  it("prefers the viewer's language when the pool speaks it", () => {
    seedQuote({ id: "en1", text: "English one", language: "en" });
    seedQuote({ id: "ru1", text: "Русская цитата", language: "ru" });

    for (const day of ["2026-08-27", "2026-08-28", "2026-08-29"]) {
      expect(dailyQuote(me, day, { language: "ru" })!.quoteId).toBe("ru1");
      expect(dailyQuote(me, day, { language: "en" })!.quoteId).toBe("en1");
    }
  });

  it("treats a regional code as its base language", () => {
    seedQuote({ id: "pt1", text: "Uma frase", language: "pt" });
    seedQuote({ id: "en1", text: "English one", language: "en" });
    expect(dailyQuote(me, TODAY, { language: "pt-BR" })!.quoteId).toBe("pt1");
  });

  it("still shows a quote when the pool speaks no such language", () => {
    seedQuote({ id: "en1", text: "English only", language: "en" });
    expect(dailyQuote(me, TODAY, { language: "ru" })!.quoteId).toBe("en1");
  });

  it("applies language inside the chosen category, not instead of it", () => {
    seedQuote({ id: "funnyRu", text: "Смешно", language: "ru", tags: ["Funny"] });
    seedQuote({ id: "funnyEn", text: "Funny", language: "en", tags: ["Funny"] });
    seedQuote({ id: "wiseRu", text: "Мудро", language: "ru", tags: ["Wisdom"] });

    const picked = dailyQuote(me, TODAY, { category: "Funny", language: "ru" })!;
    expect(picked.quoteId).toBe("funnyRu");
  });
});
