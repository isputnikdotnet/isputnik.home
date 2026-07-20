import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { suggestGalleryMemories } from "../src/modules/library/gallery/memories.js";
import { createSlideshow, getSlideshow, getSlideshowItems, addSlideshowItems } from "../src/modules/library/gallery/slideshows.js";
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

// Ingest N photos spaced `stepMinutes` apart starting at `startIso`, in library `lib`.
async function burst(lib: string, prefix: string, startIso: string, n: number, stepMinutes = 8): Promise<string[]> {
  const start = Date.parse(startIso);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const iso = new Date(start + i * stepMinutes * 60_000).toISOString();
    ids.push((await ingestGalleryAsset(lib, asset(`${prefix}-${i}.jpg`, iso), false))!);
  }
  return ids;
}

const user = { id: "u", role: "member" };

beforeEach(() => {
  resetDb();
  makeUser("u");
  makeLibrary("GAL", { createdBy: "u", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "u", type: "gallery" });
});

describe("memory suggestions", () => {
  it("returns nothing when there are too few dated photos", async () => {
    await burst("GAL", "a", "2024-08-24T10:00:00Z", 3);
    expect(suggestGalleryMemories(["GAL"])).toEqual([]);
  });

  it("clusters a same-day burst into one moment titled by its date", async () => {
    await burst("GAL", "beach", "2024-08-24T10:00:00Z", 8);
    const out = suggestGalleryMemories(["GAL"]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(8);
    expect(out[0].title).toBe("August 24, 2024");
    expect(out[0].subtitle).toBe("8 photos");
    expect(out[0].itemIds).toHaveLength(8);
    expect(out[0].id.startsWith("mem-")).toBe(true);
  });

  it("splits moments on a large time gap", async () => {
    await burst("GAL", "jan", "2024-01-01T09:00:00Z", 6);
    await burst("GAL", "aug", "2024-08-24T10:00:00Z", 7);
    const out = suggestGalleryMemories(["GAL"]);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.count).sort()).toEqual([6, 7]);
  });

  it("only clusters items in the passed (accessible) libraries", async () => {
    await burst("PRIV", "priv", "2024-08-24T10:00:00Z", 8);
    expect(suggestGalleryMemories(["GAL"])).toEqual([]); // PRIV not in scope
    expect(suggestGalleryMemories(["GAL", "PRIV"])).toHaveLength(1);
  });

  it("names user-named people in the subtitle, ignoring auto (empty-name) clusters", async () => {
    const ids = await burst("GAL", "party", "2024-08-24T10:00:00Z", 8);
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p-emma', 'Emma')").run();
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p-auto', '')").run(); // auto cluster
    const face = db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'scan')");
    face.run("f1", ids[0], "p-emma");
    face.run("f2", ids[1], "p-emma");
    face.run("f3", ids[2], "p-auto"); // auto person must not surface
    const out = suggestGalleryMemories(["GAL"]);
    expect(out[0].subtitle).toBe("8 photos · with Emma");
  });
});

describe("create slideshow from a memory", () => {
  it("carries source metadata and seeds items in chronological order", async () => {
    const ids = await burst("GAL", "trip", "2024-08-24T10:00:00Z", 6);
    const suggestion = suggestGalleryMemories(["GAL"])[0];

    const slideshow = createSlideshow(user, suggestion.title, { kind: "memory", ref: suggestion.id });
    expect(getSlideshow(slideshow.id)!.source_kind).toBe("memory");
    expect(getSlideshow(slideshow.id)!.source_ref).toBe(suggestion.id);

    addSlideshowItems(slideshow.id, new Set(["GAL"]), suggestion.itemIds);
    const { assets } = getSlideshowItems("u", ["GAL"], getSlideshow(slideshow.id)!, 50, 0);
    expect(assets.map((a) => a.id)).toEqual(ids); // append order = chronological suggestion order
  });
});
