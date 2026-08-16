// The "N× smaller" tag on a near set's tiles, and the card's loudest sentence: a copy
// being deleted carries far more pixels than the one being kept. The film-scanner pair
// that forced all of this — FL000003.jpg at 432×640 beside FH000003-003.jpg at
// 1215×1800 — runs through both.
import { describe, expect, it } from "vitest";
import {
  keeperMuchSmaller,
  largestPixelsOf,
  sizeShortfallOf,
  type SnapshotMember
} from "../src/features/control/sections/duplicates/cleanup-types";

function member(over: Partial<SnapshotMember>): SnapshotMember {
  return {
    id: "m", itemId: "i", folderId: null, libraryId: "GAL", libraryName: "GAL",
    path: "a.jpg", size: 1000, role: "keep", status: "pending", distance: 1,
    keeperPath: null, keeperMemberId: null, coverUrl: null, previewUrl: null,
    fileUrl: null, width: null, height: null,
    ...over
  };
}

const FULL = member({ id: "full", width: 1215, height: 1800 });
const INDEX = member({ id: "index", width: 432, height: 640, role: "delete" });

describe("the N× smaller tag", () => {
  it("calls the film scanner's index print what it is", () => {
    const largest = largestPixelsOf([FULL, INDEX]);
    const tag = sizeShortfallOf(INDEX, largest);
    // 1215×1800 over 432×640 is ~7.9× the pixels.
    expect(tag).toMatchObject({ times: 8, severe: true });
    expect(tag?.label).toBe("8× smaller");
  });

  it("says nothing about the biggest copy, or a near-equal one", () => {
    const near = member({ width: 1100, height: 1650 });
    const largest = largestPixelsOf([FULL, near]);
    expect(sizeShortfallOf(FULL, largest)).toBeNull();
    expect(sizeShortfallOf(near, largest)).toBeNull();
  });

  it("marks a merely-smaller copy without calling it severe", () => {
    const half = member({ width: 860, height: 1270 }); // ~2× fewer pixels
    const largest = largestPixelsOf([FULL, half]);
    expect(sizeShortfallOf(half, largest)).toMatchObject({ times: 2, severe: false });
  });

  it("never tags a copy whose dimensions are unknown", () => {
    const unknown = member({ width: null, height: null });
    expect(sizeShortfallOf(unknown, largestPixelsOf([FULL, unknown]))).toBeNull();
  });
});

describe("the keeping-the-small-one warning", () => {
  it("stays quiet when the big copy is the keeper", () => {
    expect(keeperMuchSmaller([FULL, INDEX])).toBe(false);
  });

  it("speaks up when a click flips the roles", () => {
    const flipped = [
      { ...FULL, role: "delete" as const },
      { ...INDEX, role: "keep" as const }
    ];
    expect(keeperMuchSmaller(flipped)).toBe(true);
  });

  it("stays quiet on a modest difference, and on unknown dimensions", () => {
    const half = member({ id: "half", width: 860, height: 1270, role: "keep" });
    expect(keeperMuchSmaller([{ ...FULL, role: "delete" }, half])).toBe(false);
    const unknown = member({ id: "u", role: "keep" });
    expect(keeperMuchSmaller([{ ...FULL, role: "delete" }, unknown])).toBe(false);
  });
});
