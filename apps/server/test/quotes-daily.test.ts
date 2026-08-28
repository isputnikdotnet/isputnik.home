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

describe("anniversaries", () => {
  // Something said on this day in an earlier year outranks the rotation — the
  // point of recording WHEN a family saying was said.
  const seedDated = (id: string, quoteDate: string, extra: Partial<QuoteSeed> = {}) => {
    seedQuote({ id, text: `Said on ${quoteDate}`, ...extra });
    db.prepare("UPDATE quotes SET quote_date = ? WHERE id = ?").run(quoteDate, id);
  };

  it("surfaces a quote said on this day in an earlier year", () => {
    for (const id of ["q1", "q2", "q3"]) seedQuote({ id, text: `Filler ${id}` });
    seedDated("anniversary", "2021-08-27");

    const picked = dailyQuote(me, TODAY)!;
    expect(picked.quoteId).toBe("anniversary");
    expect(picked.yearsAgo).toBe(5);
  });

  it("leaves an ordinary pick unmarked", () => {
    seedQuote({ id: "q1", text: "No date" });
    expect(dailyQuote(me, TODAY)!.yearsAgo).toBeNull();
  });

  it("ignores a date that is not today", () => {
    seedQuote({ id: "q1", text: "Filler" });
    seedDated("other", "2021-08-26");
    expect(dailyQuote(me, TODAY)!.yearsAgo).toBeNull();
  });

  it("ignores something said earlier the same year — that is not an anniversary", () => {
    seedQuote({ id: "q1", text: "Filler" });
    seedDated("today", "2026-08-27");
    expect(dailyQuote(me, TODAY)!.yearsAgo).toBeNull();
  });

  it("needs a full date: a year or a month alone has no day to come round", () => {
    seedQuote({ id: "q1", text: "Filler" });
    seedDated("yearOnly", "2021");
    seedDated("monthOnly", "2021-08");
    expect(dailyQuote(me, TODAY)!.yearsAgo).toBeNull();
  });

  it("respects the rotation opt-in, like every other pick", () => {
    seedQuote({ id: "q1", text: "Filler" });
    seedDated("optedOut", "2021-08-27", { inRotation: false });
    expect(dailyQuote(me, TODAY)!.quoteId).toBe("q1");
  });

  it("never surfaces someone else's private anniversary", () => {
    seedQuote({ id: "q1", text: "Filler" });
    seedDated("theirs", "2021-08-27", { owner: "relative", visibility: "private" });
    expect(dailyQuote(me, TODAY)!.quoteId).toBe("q1");
  });

  it("picks the same one all day when several fall on this date", () => {
    seedDated("a", "2019-08-27");
    seedDated("b", "2021-08-27");
    const first = dailyQuote(me, TODAY)!;
    expect(dailyQuote(me, TODAY)!.quoteId).toBe(first.quoteId);
    expect(first.yearsAgo).toBe(first.quoteId === "a" ? 7 : 5);
  });

  it("stands aside when the viewer has chosen a category, so the switcher works", () => {
    seedQuote({ id: "funny1", text: "Ha", tags: ["Funny"] });
    seedDated("anniversary", "2021-08-27");

    // On All, the anniversary wins.
    expect(dailyQuote(me, TODAY)!.quoteId).toBe("anniversary");
    // Having asked for Funny, that is what they get.
    const funny = dailyQuote(me, TODAY, { category: "Funny" })!;
    expect(funny.quoteId).toBe("funny1");
    expect(funny.yearsAgo).toBeNull();
  });

  it("comes back on a stale category, since the pick is not narrowed anyway", () => {
    seedDated("anniversary", "2021-08-27");
    expect(dailyQuote(me, TODAY, { category: "GoneForever" })!.quoteId).toBe("anniversary");
  });

  it("outranks language preference — one thing was said that day", () => {
    seedQuote({ id: "ru1", text: "Русская", language: "ru" });
    seedDated("anniversary", "2021-08-27", { language: "en" });
    expect(dailyQuote(me, TODAY, { language: "ru" })!.quoteId).toBe("anniversary");
  });
});

describe("which categories the card offers", () => {
  // A library with thirty categories cannot wear thirty chips, so the card caps
  // the row — and rotates it, or the first eight alphabetically would own the
  // card forever and the rest would never be seen.
  const seedCategories = (names: string[]) => {
    names.forEach((name, i) => seedQuote({ id: `q${i}`, text: `Quote ${i}`, tags: [name] }));
  };
  const twelve = ["Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh", "Ii", "Jj", "Kk", "Ll"];

  it("offers everything when the library has few categories", () => {
    seedCategories(["Funny", "Kids", "Wisdom"]);
    expect(dailyQuote(me, TODAY)!.categories).toEqual(["Funny", "Kids", "Wisdom"]);
  });

  it("caps the row at eight, and still reports the rest for the settings", () => {
    seedCategories(twelve);
    const picked = dailyQuote(me, TODAY)!;
    expect(picked.categories).toHaveLength(8);
    expect(picked.allCategories).toHaveLength(12);
  });

  it("rotates the window daily, so every category comes round", () => {
    seedCategories(twelve);
    const seen = new Set<string>();
    for (let day = 1; day <= 12; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      for (const name of dailyQuote(me, date)!.categories) seen.add(name);
    }
    expect(seen.size).toBe(12);
  });

  it("shows the same eight to everyone on the same day", () => {
    seedCategories(twelve);
    expect(dailyQuote({ id: "relative" }, TODAY)!.categories)
      .toEqual(dailyQuote(me, TODAY)!.categories);
  });

  it("keeps the chosen chip in the row even when today's window excludes it", () => {
    seedCategories(twelve);
    const rotation = dailyQuote(me, TODAY)!.categories;
    const excluded = twelve.find((name) => !rotation.includes(name))!;

    const picked = dailyQuote(me, TODAY, { category: excluded })!;
    expect(picked.categories).toContain(excluded);
    expect(picked.category).toBe(excluded);
  });
});

describe("what the viewer prefers", () => {
  beforeEach(() => {
    seedQuote({ id: "funny1", text: "Ha", tags: ["Funny"] });
    seedQuote({ id: "kids1", text: "Why is the sky?", tags: ["Kids"] });
    seedQuote({ id: "wise1", text: "Know thyself", tags: ["Wisdom"] });
    seedQuote({ id: "plain", text: "No category at all" });
  });

  it("offers exactly the categories they chose, and nothing else", () => {
    const picked = dailyQuote(me, TODAY, { categories: ["Funny", "Kids"] })!;
    expect(picked.categories).toEqual(["Funny", "Kids"]);
    // The settings still need the full list to choose from.
    expect(picked.allCategories).toEqual(["Funny", "Kids", "Wisdom"]);
  });

  it("draws from all of them together, not one at a time", () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 6; day += 1) {
      seen.add(dailyQuote(me, `2026-09-0${day}`, { categories: ["Funny", "Kids"] })!.quoteId);
    }
    expect([...seen].sort()).toEqual(["funny1", "kids1"]);
    // Never the uncategorised one, nor a category they did not ask for.
    expect(seen.has("plain")).toBe(false);
    expect(seen.has("wise1")).toBe(false);
  });

  it("lets an explicit chip narrow within what they prefer", () => {
    const picked = dailyQuote(me, TODAY, { categories: ["Funny", "Kids"], category: "Kids" })!;
    expect(picked.quoteId).toBe("kids1");
  });

  it("ignores a preference the library no longer has", () => {
    const picked = dailyQuote(me, TODAY, { categories: ["Funny", "GoneForever"] })!;
    expect(picked.categories).toEqual(["Funny"]);
    expect(picked.quoteId).toBe("funny1");
  });

  it("falls back to the whole pool when none of the preferences exist", () => {
    const picked = dailyQuote(me, TODAY, { categories: ["Nope", "AlsoNope"] })!;
    expect(picked.quoteId).toBeTruthy();
    expect(picked.categories).toHaveLength(3);
  });
});
