import { describe, expect, it } from "vitest";
import { activityPhrase, recommendationLine } from "../src/features/social/phrasing";

// The wording IS the feature here. "Dad wants you to listen to this" lands as a
// person talking; "Dad sent you this" lands as software reporting an event, and
// for a household where not everyone is comfortable with computers that is most
// of the difference. So the sentences are pinned.

describe("what a recommendation asks", () => {
  it("names the verb that fits the thing", () => {
    expect(recommendationLine("Dad", "audiobook")).toBe("Dad wants you to listen to this");
    expect(recommendationLine("Dad", "ebook")).toBe("Dad wants you to read this");
    expect(recommendationLine("Mum", "gallery")).toBe("Mum wants you to see this");
    expect(recommendationLine("Mum", "gallery_album")).toBe("Mum wants you to see these photos");
    expect(recommendationLine("Anna", "gallery_slideshow")).toBe("Anna wants you to watch this");
    expect(recommendationLine("Anna", "family_tree_person")).toBe("Anna wants you to see this");
  });

  it("falls back to something true rather than nothing for an unknown type", () => {
    expect(recommendationLine("Dad", "something_new")).toBe("Dad sent you this");
  });
});

describe("what an activity line says", () => {
  // The first version put the title last in every sentence, which produced
  // "Dad added to the family tree Grandma". A phrase is two halves with the
  // title between them; real data caught it and this keeps it caught.
  it("puts the title where the sentence needs it, not always last", () => {
    expect(activityPhrase("Anna", "note")).toEqual({ before: "Anna left a note on", after: "" });
    expect(activityPhrase("Dad", "person")).toEqual({ before: "Dad added", after: "to the family tree" });
  });

  it("reads as a sentence once the title is dropped in", () => {
    const sentence = (actor: string, kind: Parameters<typeof activityPhrase>[1], title: string) => {
      const phrase = activityPhrase(actor, kind);
      return [phrase.before, title, phrase.after].filter(Boolean).join(" ");
    };

    expect(sentence("Anna", "note", "Dune")).toBe("Anna left a note on Dune");
    expect(sentence("Mum", "album", "Summer 2019")).toBe("Mum made the album Summer 2019");
    expect(sentence("Mum", "slideshow", "Christmas")).toBe("Mum made the slideshow Christmas");
    expect(sentence("Dad", "person", "Grandma")).toBe("Dad added Grandma to the family tree");
  });
});

// The activity row's timestamp is shared/relativeTime's "compact" style — pinned
// in relativeTime.test.ts with the other two.
