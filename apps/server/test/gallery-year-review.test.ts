import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { buildYearReview, suggestYearReviews, galleryReviewableYears } from "../src/modules/library/gallery/year-review.js";
import { queryGalleryTimeline, EMPTY_GALLERY_FILTERS } from "../src/modules/library/gallery/catalog.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

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

// N assets an hour apart from `startIso`, in library `lib`. `ext` makes them videos.
async function shots(lib: string, prefix: string, startIso: string, n: number, ext = "jpg"): Promise<string[]> {
  const start = Date.parse(startIso);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const iso = new Date(start + i * 3_600_000).toISOString();
    ids.push((await ingestGalleryAsset(lib, asset(`${prefix}-${i}.${ext}`, iso), false))!);
  }
  return ids;
}

// One asset in each of the twelve months of `year`, `perMonth` of them each time.
async function acrossTheYear(lib: string, year: number, perMonth: number): Promise<string[][]> {
  const byMonth: string[][] = [];
  for (let m = 1; m <= 12; m += 1) {
    const mm = String(m).padStart(2, "0");
    byMonth.push(await shots(lib, `m${mm}`, `${year}-${mm}-10T10:00:00Z`, perMonth));
  }
  return byMonth;
}

let saveSeq = 0;
function heart(itemId: string, userId = "u") {
  saveSeq += 1;
  db.prepare("INSERT INTO item_saves (id, user_id, item_id, note) VALUES (?, ?, ?, NULL)")
    .run(`sv-${saveSeq}`, userId, itemId);
}

const monthsOf = (ids: string[]): string[] => {
  const rows = db.prepare(`SELECT item_id, substr(taken_at, 6, 2) AS m FROM gallery_details WHERE item_id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as { item_id: string; m: string }[];
  const by = new Map(rows.map((r) => [r.item_id, r.m]));
  return ids.map((id) => by.get(id)!);
};

beforeEach(() => {
  resetDb();
  makeUser("u");
  makeUser("v");
  makeLibrary("GAL", { createdBy: "u", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "u", type: "gallery" });
});

describe("year in review — which years are offered", () => {
  it("skips a year with too little material", async () => {
    await shots("GAL", "thin", "2024-06-01T10:00:00Z", 8); // < MIN_ITEMS
    expect(galleryReviewableYears(["GAL"])).toEqual([]);
    expect(buildYearReview(["GAL"], "u", 2024)).toBeNull();
  });

  it("lists qualifying years newest-first and only from libraries in scope", async () => {
    await shots("GAL", "a", "2023-06-01T10:00:00Z", 14);
    await shots("GAL", "b", "2024-06-01T10:00:00Z", 14);
    await shots("PRIV", "c", "2022-06-01T10:00:00Z", 14);

    expect(galleryReviewableYears(["GAL"])).toEqual([2024, 2023]);
    expect(galleryReviewableYears(["GAL", "PRIV"])).toEqual([2024, 2023, 2022]);
    expect(galleryReviewableYears([])).toEqual([]);
  });

  it("titles a finished year 'in review' and the running one 'so far'", async () => {
    const thisYear = new Date().getFullYear();
    await shots("GAL", "old", "2019-06-01T10:00:00Z", 14);
    await shots("GAL", "now", `${thisYear}-01-05T10:00:00Z`, 14);

    expect(buildYearReview(["GAL"], "u", 2019)!.title).toBe("2019 in review");
    expect(buildYearReview(["GAL"], "u", thisYear)!.title).toBe(`${thisYear} so far`);
  });

  it("returns the most recent years, capped by limit, as ready-to-save suggestions", async () => {
    await shots("GAL", "a", "2022-06-01T10:00:00Z", 14);
    await shots("GAL", "b", "2023-06-01T10:00:00Z", 14);
    await shots("GAL", "c", "2024-06-01T10:00:00Z", 14);

    const out = suggestYearReviews(["GAL"], "u", { limit: 2 });
    expect(out.map((r) => r.year)).toEqual([2024, 2023]);
    expect(out[0].id).toBe("year-2024");
    expect(out[0].itemIds.length).toBe(out[0].count);
  });
});

describe("year in review — coverage beats ranking", () => {
  // The whole point of the feature: a year where every heart landed in one month
  // must still produce a film that spans the year, not twelve slides of July.
  it("spreads the film across every month that has photos", async () => {
    const byMonth = await acrossTheYear("GAL", 2024, 5);
    for (const id of byMonth[6]) heart(id); // all five July photos hearted

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 12 })!;
    expect(review.count).toBe(12);
    expect(new Set(monthsOf(review.itemIds)).size).toBe(12); // one slide per month
    expect(review.subtitle).toContain("12 months");
  });

  it("still puts the hearted photo in its month's slot", async () => {
    const byMonth = await acrossTheYear("GAL", 2024, 5);
    const loved = byMonth[6][3]; // one July photo, not the first
    heart(loved);

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 12 })!;
    expect(review.itemIds).toContain(loved);
  });

  it("gives an eventful month more slots than a quiet one", async () => {
    // Two months of equal size, but one is where the hearts are.
    await shots("GAL", "jan", "2024-01-10T10:00:00Z", 20);
    const august = await shots("GAL", "aug", "2024-08-10T10:00:00Z", 20);
    for (const id of august.slice(0, 10)) heart(id);

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 20 })!;
    const months = monthsOf(review.itemIds);
    const augustSlides = months.filter((m) => m === "08").length;
    const januarySlides = months.filter((m) => m === "01").length;
    expect(augustSlides).toBeGreaterThan(januarySlides);
    expect(januarySlides).toBeGreaterThanOrEqual(1); // but January is never dropped
  });

  it("orders the finished film chronologically", async () => {
    await acrossTheYear("GAL", 2024, 5);
    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 24 })!;
    const months = monthsOf(review.itemIds);
    expect([...months]).toEqual([...months].sort());
  });
});

describe("year in review — what gets picked", () => {
  it("prefers hearted photos over unhearted ones within a month", async () => {
    const ids = await shots("GAL", "jul", "2024-07-10T10:00:00Z", 20);
    const loved = [ids[17], ids[18], ids[19]];
    for (const id of loved) heart(id);

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 12 })!;
    for (const id of loved) expect(review.itemIds).toContain(id);
  });

  it("counts every household heart, not just the viewer's", async () => {
    const ids = await shots("GAL", "jul", "2024-07-10T10:00:00Z", 20);
    heart(ids[19], "v"); // someone else in the house hearted it; "u" is watching

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 12 })!;
    expect(review.itemIds).toContain(ids[19]);
  });

  it("keeps the best frame of a burst, not merely the first", async () => {
    const ids = await shots("GAL", "burst", "2024-07-10T10:00:00Z", 16);
    // The first three are the same shot; the rest are pairwise far apart.
    const set = db.prepare("UPDATE gallery_details SET phash = ? WHERE item_id = ?");
    set.run("0000000000000000", ids[0]);
    set.run("0000000000000001", ids[1]);
    set.run("0000000000000003", ids[2]);
    heart(ids[2]); // the keeper is the third frame, not the first

    const review = buildYearReview(["GAL"], "u", 2024)!;
    expect(review.itemIds).toContain(ids[2]);
    expect(review.itemIds).not.toContain(ids[0]);
    expect(review.itemIds).not.toContain(ids[1]);
    expect(review.count).toBe(14); // 16 shots, 3 of one scene → 14 distinct
  });

  it("caps how much of the film is video, however loved the clips are", async () => {
    const photos = await shots("GAL", "pic", "2024-07-10T10:00:00Z", 12);
    const clips = await shots("GAL", "clip", "2024-07-20T10:00:00Z", 6, "mp4");
    for (const id of clips) heart(id); // every video is liked
    expect(photos).toHaveLength(12);

    const review = buildYearReview(["GAL"], "u", 2024, { maxItems: 12 })!;
    const kinds = db.prepare(`SELECT kind FROM gallery_details WHERE item_id IN (${review.itemIds.map(() => "?").join(", ")})`)
      .all(...review.itemIds) as { kind: string }[];
    expect(kinds.filter((k) => k.kind === "video")).toHaveLength(2); // round(12 * 0.2)
    expect(review.subtitle).toBe("10 photos & 2 videos · 1 month");
  });

  it("names the people the year was actually about, ignoring auto clusters", async () => {
    const ids = await shots("GAL", "fam", "2024-07-10T10:00:00Z", 16);
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p-emma', 'Emma')").run();
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p-auto', '')").run();
    const face = db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'scan')");
    ids.slice(0, 6).forEach((id, i) => face.run(`f${i}`, id, "p-emma"));
    face.run("fa", ids[10], "p-auto");

    const review = buildYearReview(["GAL"], "u", 2024)!;
    expect(review.subtitle).toContain("with Emma");
    expect(review.subtitle).not.toContain("with  &"); // the unnamed cluster stays out
  });

  it("draws only on libraries the viewer can reach", async () => {
    await shots("PRIV", "priv", "2024-07-10T10:00:00Z", 16);
    expect(buildYearReview(["GAL"], "u", 2024)).toBeNull();
    expect(buildYearReview(["GAL", "PRIV"], "u", 2024)!.count).toBe(16);
  });
});

describe("gallery likes filter", () => {
  const query = (likes: string[]) =>
    queryGalleryTimeline("u", ["GAL"], {
      q: "", kinds: [], filters: { ...EMPTY_GALLERY_FILTERS, likes }, limit: 50, offset: 0
    });

  it("cuts the timeline by mine / anyone's / not liked", async () => {
    const ids = await shots("GAL", "f", "2024-07-10T10:00:00Z", 4);
    heart(ids[0]);          // u
    heart(ids[1]);          // u
    heart(ids[2], "v");     // someone else in the house

    expect(query(["mine"]).assets.map((a) => a.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(query(["anyone"]).total).toBe(3);
    expect(query(["none"]).assets.map((a) => a.id)).toEqual([ids[3]]);
    // OR within the facet, like every other filter list.
    expect(query(["mine", "none"]).total).toBe(3);
    // Every option selected means "everything", same as none selected.
    expect(query(["mine", "anyone", "none"]).total).toBe(4);
    expect(query([]).total).toBe(4);
  });

  it("keeps the total in step with the page (the count query has no saves join)", async () => {
    const ids = await shots("GAL", "t", "2024-07-10T10:00:00Z", 5);
    heart(ids[0]);
    const page = query(["mine"]);
    expect(page.total).toBe(1);
    expect(page.assets).toHaveLength(1);
    expect(page.assets[0].saved).toBe(true);
  });
});
