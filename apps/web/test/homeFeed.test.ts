import { describe, expect, it } from "vitest";
import { batchDayLabel, tightMemoryGroups } from "../src/features/home/feed";
import type { GalleryMemoryGroup } from "../src/features/gallery/types";

// The viewer opened from the home memory card must browse the same set the
// card advertises. This rule mirrors the server's card-building one; if the
// two drift, tapping a tight card pages through near-day photos again —
// exactly the bug this pins down.

const group = (year: number, precision: "day" | "near", count: number): GalleryMemoryGroup =>
  ({ year, precision, count, items: [] });

describe("tightMemoryGroups", () => {
  it("drops near-match years when the exact day can fill the strip", () => {
    const groups = [group(2019, "day", 3), group(2018, "near", 5), group(2017, "day", 1)];
    expect(tightMemoryGroups(groups).map((g) => g.year)).toEqual([2019, 2017]);
  });

  it("keeps near-match years while the day itself is thin", () => {
    const groups = [group(2019, "day", 2), group(2018, "near", 5)];
    expect(tightMemoryGroups(groups)).toEqual(groups);
  });

  it("keeps an all-near day whole — widening was the only match there was", () => {
    const groups = [group(2018, "near", 6)];
    expect(tightMemoryGroups(groups)).toEqual(groups);
  });
});

describe("batchDayLabel", () => {
  it("names the day the way a person would", () => {
    const iso = (daysAgo: number) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(batchDayLabel(iso(0))).toBe("today");
    expect(batchDayLabel(iso(1))).toBe("yesterday");
    // Recent days are relative ("3 days ago") — localizable, unlike a weekday
    // name, which would need case declension in Russian.
    expect(batchDayLabel(iso(3))).toBe("3 days ago");
    expect(batchDayLabel(iso(30))).toMatch(/^on /);
  });
});
