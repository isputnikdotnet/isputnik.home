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
  getClipRenderItem,
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

  // The title card's own settings. The defaults reproduce the card every movie opened
  // with before they existed, so an untouched slideshow renders exactly as it did.
  it("defaults the title card to the old fixed one, and saves every change to it", () => {
    const slideshow = getSlideshow(createSlideshow(creator, "Summer").id)!;
    expect(slideshow).toMatchObject({
      title_enabled: 1, title_text: null, title_subtitle_mode: "count",
      title_subtitle: null, title_seconds: 3, title_background: "black", title_photo_item_id: null
    });

    updateSlideshow(slideshow.id, {
      titleEnabled: false, titleText: "Sicily", titleSubtitleMode: "custom", titleSubtitle: "August 2026",
      titleSeconds: 6, titleBackground: "collage", titlePhotoItemId: a
    });
    expect(getSlideshow(slideshow.id)!).toMatchObject({
      title_enabled: 0, title_text: "Sicily", title_subtitle_mode: "custom",
      title_subtitle: "August 2026", title_seconds: 6, title_background: "collage", title_photo_item_id: a
    });

    // Null on a nullable field means "back to the default"; leaving a field out means
    // "don't touch it" — the two must not be the same thing.
    updateSlideshow(slideshow.id, { titleText: null, titleSeconds: 4 });
    expect(getSlideshow(slideshow.id)!).toMatchObject({
      title_text: null, title_subtitle: "August 2026", title_seconds: 4, title_background: "collage"
    });
  });

  // The closing card defaults OFF: an untouched slideshow renders the movie it
  // always did, ending on the last photo with the 2-second music tail.
  it("defaults the closing card off, and saves every change to it", () => {
    const slideshow = getSlideshow(createSlideshow(creator, "Summer").id)!;
    expect(slideshow).toMatchObject({
      closing_enabled: 0, closing_text: null, closing_lines: null,
      closing_seconds: 5, closing_background: "black", closing_photo_item_id: null
    });

    updateSlideshow(slideshow.id, {
      closingEnabled: true, closingText: "Конец", closingLines: "Filmed by Dad\nMusic: our song",
      closingSeconds: 8, closingBackground: "blur", closingPhotoItemId: a
    });
    expect(getSlideshow(slideshow.id)!).toMatchObject({
      closing_enabled: 1, closing_text: "Конец", closing_lines: "Filmed by Dad\nMusic: our song",
      closing_seconds: 8, closing_background: "blur", closing_photo_item_id: a
    });

    // The same null-vs-omitted contract as the opening card.
    updateSlideshow(slideshow.id, { closingText: null });
    expect(getSlideshow(slideshow.id)!).toMatchObject({
      closing_text: null, closing_lines: "Filmed by Dad\nMusic: our song", closing_enabled: 1
    });
  });

  // Opening/closing clips: any accessible gallery VIDEO, deliberately not
  // restricted to slideshow members (an intro is usually shot for the purpose).
  it("saves and clears the opening/closing clip ids", async () => {
    const clip = (await ingestGalleryAsset("GAL", asset("intro.mp4", "2024-05-01T10:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "Summer");
    updateSlideshow(slideshow.id, { introItemId: clip, outroItemId: clip });
    expect(getSlideshow(slideshow.id)!).toMatchObject({ intro_item_id: clip, outro_item_id: clip });
    updateSlideshow(slideshow.id, { introItemId: null });
    expect(getSlideshow(slideshow.id)!).toMatchObject({ intro_item_id: null, outro_item_id: clip });
  });

  it("resolves a clip only as a VIDEO the given libraries can reach", async () => {
    const clip = (await ingestGalleryAsset("GAL", asset("intro.mp4", "2024-05-01T10:00:00Z"), false))!;
    const privClip = (await ingestGalleryAsset("PRIV", asset("secret.mp4", "2024-05-02T10:00:00Z"), false))!;
    expect(getClipRenderItem(["GAL"], clip)).toMatchObject({ id: clip, kind: "video" });
    expect(getClipRenderItem(["GAL"], a)).toBeNull(); // a photo is not a clip
    expect(getClipRenderItem(["GAL"], privClip)).toBeNull(); // out of reach
    expect(getClipRenderItem([], clip)).toBeNull();
    expect(getClipRenderItem(["GAL"], null)).toBeNull();
  });

  it("a deleted clip clears itself from the slideshow", async () => {
    const clip = (await ingestGalleryAsset("GAL", asset("intro.mp4", "2024-05-01T10:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "Summer");
    updateSlideshow(slideshow.id, { introItemId: clip });
    db.prepare("DELETE FROM library_items WHERE id = ?").run(clip);
    expect(getSlideshow(slideshow.id)!.intro_item_id).toBeNull(); // FK ON DELETE SET NULL
  });

  it("marks a rendered movie out of date when the title card changes", () => {
    const slideshow = createSlideshow(creator, "Summer");
    db.prepare("UPDATE gallery_slideshows SET render_status = 'ready', render_stale = 0 WHERE id = ?").run(slideshow.id);
    updateSlideshow(slideshow.id, { titleBackground: "blur" });
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(1);
  });

  it("update validates the cover is a member", () => {
    const slideshow = createSlideshow(creator, "Summer");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a]);
    expect(updateSlideshow(slideshow.id, { coverItemId: b })).toBe(false); // b not in the slideshow
    expect(updateSlideshow(slideshow.id, { coverItemId: a })).toBe(true);
    expect(getSlideshow(slideshow.id)!.cover_item_id).toBe(a);
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
