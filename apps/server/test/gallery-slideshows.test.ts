import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import {
  createSlideshow,
  updateSlideshow,
  deleteSlideshow,
  addSlideshowItems,
  removeSlideshowItems,
  reorderSlideshowItems,
  listSlideshows,
  getSlideshow,
  getSlideshowItems,
  canEditSlideshow
} from "../src/modules/library/gallery/slideshows.js";
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

const creator = { id: "creator", role: "member" };
const viewer = { id: "viewer", role: "member" };
const admin = { id: "boss", role: "admin" };
const GAL_LIBS = ["GAL", "PRIV"];
let a = "";
let b = "";
let c = "";
let priv = "";

beforeEach(async () => {
  resetDb();
  makeUser("creator");
  makeUser("viewer");
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "creator", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "creator", type: "gallery" });
  grant("user", "creator", "PRIV", "manager");
  a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-03-01T10:00:00Z"), false))!;
  b = (await ingestGalleryAsset("GAL", asset("b.jpg", "2024-01-01T10:00:00Z"), false))!;
  c = (await ingestGalleryAsset("GAL", asset("c.jpg", "2024-02-01T10:00:00Z"), false))!;
  priv = (await ingestGalleryAsset("PRIV", asset("priv.jpg", "2024-04-01T10:00:00Z"), false))!;
});

describe("slideshow edit rights", () => {
  it("creator and admins can edit; other members cannot", () => {
    const slideshow = createSlideshow(creator, "Summer");
    expect(canEditSlideshow(slideshow, creator)).toBe(true);
    expect(canEditSlideshow(slideshow, admin)).toBe(true);
    expect(canEditSlideshow(slideshow, viewer)).toBe(false);
  });

  it("defaults: crossfade transition, 4s per slide, draft render state", () => {
    const slideshow = getSlideshow(createSlideshow(creator, "Summer").id)!;
    expect(slideshow.transition).toBe("crossfade");
    expect(slideshow.slide_seconds).toBe(4);
    expect(slideshow.render_status).toBe("draft");
  });
});

describe("slideshow membership", () => {
  it("adds accessible items once, skips inaccessible/unknown/duplicates", () => {
    const slideshow = createSlideshow(creator, "Summer");
    const viewerLibs = new Set(["GAL"]);
    expect(addSlideshowItems(slideshow.id, viewerLibs, [a, b, priv, "nope"])).toEqual({ added: 2, skipped: 2 });
    expect(addSlideshowItems(slideshow.id, viewerLibs, [a])).toEqual({ added: 0, skipped: 1 });
    expect(removeSlideshowItems(slideshow.id, [a])).toBe(1);
  });

  it("delete cascades memberships but never the photos", () => {
    const slideshow = createSlideshow(creator, "Summer");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a, b]);
    expect(deleteSlideshow(slideshow.id)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_slideshow_items WHERE slideshow_id = ?").get(slideshow.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE id = ?").get(a) as { n: number }).n).toBe(1);
  });
});

describe("slideshow presentation settings", () => {
  it("updates name, transition and per-slide duration", () => {
    const slideshow = createSlideshow(creator, "Summer");
    expect(updateSlideshow(slideshow.id, { name: "Best of 2024", transition: "kenburns", slideSeconds: 6 })).toBe(true);
    const after = getSlideshow(slideshow.id)!;
    expect(after.name).toBe("Best of 2024");
    expect(after.transition).toBe("kenburns");
    expect(after.slide_seconds).toBe(6);
  });
});

describe("slideshow ordering", () => {
  it("keeps items in presentation (append) order, then honors an explicit reorder", () => {
    const slideshow = createSlideshow(creator, "Summer");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a, c, b]); // appended in this order

    const appended = getSlideshowItems("creator", ["GAL"], getSlideshow(slideshow.id)!, 50, 0);
    expect(appended.total).toBe(3);
    expect(appended.assets.map((x) => x.id)).toEqual([a, c, b]);

    reorderSlideshowItems(slideshow.id, [b, a, c]);
    const reordered = getSlideshowItems("creator", ["GAL"], getSlideshow(slideshow.id)!, 50, 0);
    expect(reordered.assets.map((x) => x.id)).toEqual([b, a, c]);
  });

  it("reorder ignores unknown ids and appends omitted members after the listed ones", () => {
    const slideshow = createSlideshow(creator, "Summer");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a, b, c]);

    // Only mention c; a and b keep their relative order after it. "nope" ignored.
    reorderSlideshowItems(slideshow.id, [c, "nope"]);
    const after = getSlideshowItems("creator", ["GAL"], getSlideshow(slideshow.id)!, 50, 0);
    expect(after.assets.map((x) => x.id)).toEqual([c, a, b]);
  });
});

describe("slideshow visibility", () => {
  it("hides an effectively-empty slideshow from members but not its creator or admins", () => {
    const slideshow = createSlideshow(creator, "Private");
    addSlideshowItems(slideshow.id, new Set(GAL_LIBS), [priv]); // only a PRIV item

    expect(listSlideshows(viewer, ["GAL"]).map((row) => row.id)).not.toContain(slideshow.id);
    expect(listSlideshows(creator, GAL_LIBS).map((row) => row.id)).toContain(slideshow.id);
    expect(listSlideshows(admin, GAL_LIBS).map((row) => row.id)).toContain(slideshow.id);
  });

  it("counts only the viewer's visible items and paging filters by access", () => {
    const slideshow = createSlideshow(creator, "Mixed");
    addSlideshowItems(slideshow.id, new Set(GAL_LIBS), [a, b, c, priv]);

    const forViewer = listSlideshows(viewer, ["GAL"]).find((row) => row.id === slideshow.id)!;
    expect(forViewer.itemCount).toBe(3); // priv invisible
    expect(forViewer.canEdit).toBe(false);

    const page = getSlideshowItems("viewer", ["GAL"], getSlideshow(slideshow.id)!, 2, 0);
    expect(page.total).toBe(3);
    expect(page.assets).toHaveLength(2);
  });
});
