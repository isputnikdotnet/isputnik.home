import { beforeEach, describe, expect, it } from "vitest";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { queryGalleryMemories } from "../src/modules/library/gallery/catalog.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Same synthetic-asset trick as gallery.test.ts: with metaEnabled=false the
// ingester never touches the file, and taken_at falls back to the mtime we set.
function asset(relativePath: string, takenAtIso: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: Date.parse(takenAtIso)
  };
}

// "Today" for every test — a fixed date keeps the tiers deterministic.
const TODAY = "2026-07-05";

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("gallery memories", () => {
  it("groups exact-day matches by year, newest year first, excluding the current year", async () => {
    await ingestGalleryAsset("GAL", asset("a.jpg", "2024-07-05T10:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("b.jpg", "2023-07-05T09:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("c.jpg", "2023-07-05T18:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("other-month.jpg", "2024-03-01T10:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("today-this-year.jpg", "2026-07-05T08:00:00Z"), false);

    const { precision, groups } = queryGalleryMemories("u1", ["GAL"], TODAY, 60);
    expect(precision).toBe("day");
    expect(groups.map((g) => g.year)).toEqual([2024, 2023]);
    expect(groups.map((g) => g.count)).toEqual([1, 2]);
    // Items within a year are chronological.
    expect(groups[1].items.map((i) => i.title)).toEqual(["b.jpg", "c.jpg"]);
  });

  it("widens to ±3 days when nothing matches the exact day", async () => {
    await ingestGalleryAsset("GAL", asset("close.jpg", "2022-07-07T10:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("far.jpg", "2022-07-20T10:00:00Z"), false);

    const { precision, groups } = queryGalleryMemories("u1", ["GAL"], TODAY, 60);
    expect(precision).toBe("near");
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.title)).toEqual(["close.jpg"]);
  });

  it("the ±3 window wraps across the year boundary", async () => {
    await ingestGalleryAsset("GAL", asset("nye.jpg", "2025-12-30T20:00:00Z"), false);

    const { precision, groups } = queryGalleryMemories("u1", ["GAL"], "2026-01-01", 60);
    expect(precision).toBe("near");
    expect(groups.map((g) => g.year)).toEqual([2025]);
  });

  it("widens to the whole month as the last resort", async () => {
    await ingestGalleryAsset("GAL", asset("late-july.jpg", "2021-07-25T10:00:00Z"), false);

    const { precision, groups } = queryGalleryMemories("u1", ["GAL"], TODAY, 60);
    expect(precision).toBe("month");
    expect(groups.map((g) => g.year)).toEqual([2021]);
  });

  it("returns no groups when no past-year asset is dated in this month", async () => {
    await ingestGalleryAsset("GAL", asset("january.jpg", "2024-01-10T10:00:00Z"), false);

    const { groups } = queryGalleryMemories("u1", ["GAL"], TODAY, 60);
    expect(groups).toHaveLength(0);
  });

  it("caps items per year while reporting the true count", async () => {
    await ingestGalleryAsset("GAL", asset("one.jpg", "2020-07-05T08:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("two.jpg", "2020-07-05T12:00:00Z"), false);
    await ingestGalleryAsset("GAL", asset("three.jpg", "2020-07-05T16:00:00Z"), false);

    const { groups } = queryGalleryMemories("u1", ["GAL"], TODAY, 2);
    expect(groups[0].count).toBe(3);
    expect(groups[0].items.map((i) => i.title)).toEqual(["one.jpg", "two.jpg"]);
  });

  it("returns nothing for an empty library scope", async () => {
    await ingestGalleryAsset("GAL", asset("a.jpg", "2024-07-05T10:00:00Z"), false);
    const { groups } = queryGalleryMemories("u1", [], TODAY, 60);
    expect(groups).toHaveLength(0);
  });
});
