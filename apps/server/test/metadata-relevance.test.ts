// The gate that makes the metadata lookup honour its search box. Providers are
// keyword engines — Audible answers "Dune" with the whole Dune universe plus a
// study guide, Open Library's `q` matches descriptions and subjects — so
// without this filter the dialog was mostly wrong titles. A candidate survives
// only when everything typed is present in the result itself.
import { describe, expect, it } from "vitest";
import { rankByQueryRelevance } from "../src/modules/library/audiobook/providers/relevance.js";
import type { MetadataCandidate } from "../src/modules/library/audiobook/providers/types.js";

function candidate(title: string, extra: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return { title, authors: [], source: "audible", ...extra };
}

const titles = (results: MetadataCandidate[]) => results.map((result) => result.title);

describe("metadata lookup relevance", () => {
  it("drops results that don't carry every word of the query", () => {
    const results = rankByQueryRelevance([
      candidate("Dune"),
      candidate("Dune Messiah"),
      candidate("Children of Dune"),
      candidate("The Road to Dune"),
      candidate("Sandworms of Arrakis"),
      candidate("Brave New World")
    ], { query: "Dune" });

    expect(titles(results)).toEqual(["Dune", "Dune Messiah", "Children of Dune", "The Road to Dune"]);
  });

  it("keeps the closest title first and sinks the longer ones", () => {
    const results = rankByQueryRelevance([
      candidate("A Study Guide for Frank Herbert's Dune Messiah"),
      candidate("Dune Messiah: Book Two"),
      candidate("Dune Messiah")
    ], { query: "Dune Messiah" });

    expect(titles(results)).toEqual([
      "Dune Messiah",
      "Dune Messiah: Book Two",
      "A Study Guide for Frank Herbert's Dune Messiah"
    ]);
  });

  it("ignores articles and punctuation on both sides", () => {
    const results = rankByQueryRelevance([
      candidate("The Hobbit, or There and Back Again"),
      candidate("The Silmarillion")
    ], { query: "Hobbit" });

    expect(titles(results)).toEqual(["The Hobbit, or There and Back Again"]);
  });

  it("matches Russian case endings but not merely similar words", () => {
    const results = rankByQueryRelevance([
      candidate("Война и мир", { authors: ["Лев Толстой"] }),
      candidate("Детство. Отрочество. Юность", { authors: ["Лев Толстой"] }),
      candidate("Война миров", { authors: ["Герберт Уэллс"] })
    ], { query: "Война и мир Толстого" });

    expect(titles(results)).toEqual(["Война и мир"]);
  });

  it("finds a book by an identifier pasted into the box", () => {
    const results = rankByQueryRelevance([
      candidate("The Martian", { asin: "B082BHJMFF" }),
      candidate("The Martian Chronicles", { asin: "B0036V1RCE" })
    ], { query: "B082BHJMFF" });

    expect(titles(results)).toEqual(["The Martian"]);
  });

  it("counts an explicit author filter as part of the query", () => {
    const results = rankByQueryRelevance([
      candidate("Metro 2033", { authors: ["Dmitry Glukhovsky"] }),
      candidate("Metro 2033", { authors: ["Anna Kalinkina"] })
    ], { query: "Metro 2033", author: "Glukhovsky" });

    expect(results).toHaveLength(1);
    expect(results[0].authors).toEqual(["Dmitry Glukhovsky"]);
  });

  it("passes everything through when there is nothing to match on", () => {
    const all = [candidate("Dune"), candidate("Brave New World")];
    expect(rankByQueryRelevance(all, { query: "  " })).toEqual(all);
  });
});
