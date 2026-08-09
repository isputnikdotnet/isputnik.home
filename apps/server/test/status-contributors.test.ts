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
});
