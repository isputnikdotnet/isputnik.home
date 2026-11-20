import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectStatusContributions,
  registerStatusContributor,
  resetStatusContributors
} from "../src/core/status-contributors.js";

// The per-media-type numbers on /api/status used to be hard-coded in core. They
// are now pushed in by each type, which means two things have to hold: the
// merged payload keeps exactly the keys the admin Statistics page reads, and one
// type failing cannot blank the page for the others.

afterEach(() => {
  resetStatusContributors();
  vi.restoreAllMocks();
});

describe("status contributors", () => {
  it("merges every contributor into one flat object", () => {
    registerStatusContributor("a", ["one"], () => ({ one: 1 }));
    registerStatusContributor("b", ["two", "three"], () => ({ two: 2, three: 3 }));
    expect(collectStatusContributions()).toEqual({ one: 1, two: 2, three: 3 });
  });

  it("returns nothing when no media type has registered", () => {
    expect(collectStatusContributions()).toEqual({});
  });

  it("calls a multi-key contributor once, not once per key", () => {
    const contribute = vi.fn(() => ({ x: 1, y: 2 }));
    registerStatusContributor("multi", ["x", "y"], contribute);
    collectStatusContributions();
    expect(contribute).toHaveBeenCalledTimes(1);
  });

  it("refuses to let two modules claim the same key", () => {
    registerStatusContributor("first", ["shared"], () => ({ shared: 1 }));
    expect(() => registerStatusContributor("second", ["shared"], () => ({ shared: 2 })))
      .toThrow(/already claimed/);
  });

  it("tolerates re-registering the identical contributor", () => {
    const contribute = () => ({ k: 1 });
    registerStatusContributor("same", ["k"], contribute);
    expect(() => registerStatusContributor("same", ["k"], contribute)).not.toThrow();
  });

  it("keeps the other types' numbers when one throws", () => {
    const warn = vi.fn();
    registerStatusContributor("healthy", ["good"], () => ({ good: 42 }));
    registerStatusContributor("broken", ["bad"], () => { throw new Error("no such table"); });
    expect(collectStatusContributions({ warn })).toEqual({ good: 42 });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("the real media-type contributors", () => {
  it("together supply exactly the keys the Statistics page reads", async () => {
    const { registerAudiobookStats } = await import("../src/modules/library/audiobook/stats.js");
    const { registerEbookStats } = await import("../src/modules/library/ebook/stats.js");
    const { registerGalleryStats } = await import("../src/modules/library/gallery/stats.js");
    resetStatusContributors();
    registerAudiobookStats();
    registerEbookStats();
    registerGalleryStats();

    // The shape core/status.ts used to build by hand. Changing this list means
    // changing what apps/web reads off /api/status.
    expect(Object.keys(collectStatusContributions()).sort()).toEqual([
      "audiobookBooks",
      "audiobookLibraries",
      "ebookStats",
      "faceStats",
      "galleryStats",
      "libraryStats"
    ]);
  });

  // Stories' and the family tree's summaries for their control-panel Overviews
  // (2026-11-19): counts only, from their own modules.
  it("gives Stories and the family tree their own summaries", async () => {
    const { registerStoryStats } = await import("../src/modules/stories/stats.js");
    const { registerFamilyTreeStats } = await import("../src/modules/familytree/stats.js");
    resetStatusContributors();
    registerStoryStats();
    registerFamilyTreeStats();
    // Registering again (a plugin booted twice) is the same contributor.
    expect(() => { registerStoryStats(); registerFamilyTreeStats(); }).not.toThrow();
    const out = collectStatusContributions() as {
      storyStats: { stories: number; published: number; recipes: number; collections: number; recordings: number; recordingSeconds: number };
      familyTreeStats: { people: number; couples: number; sources: number; photos: number; places: number };
    };
    expect(Object.keys(out).sort()).toEqual(["familyTreeStats", "storyStats"]);
    expect(out.storyStats).toEqual({ stories: expect.any(Number), published: expect.any(Number), recipes: expect.any(Number), collections: expect.any(Number), recordings: expect.any(Number), recordingSeconds: expect.any(Number) });
    expect(out.familyTreeStats).toEqual({ people: expect.any(Number), couples: expect.any(Number), sources: expect.any(Number), photos: expect.any(Number), places: expect.any(Number) });
  });
});
