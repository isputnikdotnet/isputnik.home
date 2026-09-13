import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { runMigrationsFrom } from "../src/db/migrate.js";
import { getHouseLibrary, HOUSE_FOLDERS, safeFolderName, setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { getRecordingsLibrary } from "../src/modules/stories/settings.js";
import { getFamilyUploadLibrary } from "../src/modules/familytree/settings.js";
import { createLibraryRecord } from "../src/modules/library/shared/library-crud.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// The "App files" library (docs/photo-review-plan.md, phase 0): one house
// setting that stories, the family tree and slideshow movies all read through
// to, and the migration that carries the old per-feature choices over.

// What an Inbox looked like before migration 75, for the migration tests below.
const INBOX_POLICY = JSON.stringify({ mode: "managed", inbox: true });

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeLibrary("gal", { createdBy: "admin", type: "gallery" });
  makeLibrary("inbox", { createdBy: "admin", type: "gallery", role: "inbox" });
});

describe("the house library", () => {
  it("is not set until an admin chooses one, and every reader agrees", () => {
    expect(getHouseLibrary()).toBeNull();
    expect(getRecordingsLibrary()).toBeNull();
    expect(getFamilyUploadLibrary()).toBeNull();

    const result = setHouseLibrary("gal", "admin");
    expect(result.ok).toBe(true);
    expect(getHouseLibrary()?.id).toBe("gal");
    expect(getRecordingsLibrary()?.id).toBe("gal");
    expect(getFamilyUploadLibrary()).toEqual({ id: "gal", name: "gal", folder: HOUSE_FOLDERS.familyTree });
  });

  it("refuses a Photo Inbox and a library that is not there", () => {
    expect(setHouseLibrary("inbox", "admin")).toMatchObject({ ok: false, status: 409 });
    expect(setHouseLibrary("nope", "admin")).toMatchObject({ ok: false, status: 404 });
    expect(getHouseLibrary()).toBeNull();
  });

  it("opts the chosen library into audio, and reads as unset once the library is gone", () => {
    db.prepare("UPDATE libraries SET settings_json = ? WHERE id = 'gal'").run(JSON.stringify({ scan_extensions: ["jpg"] }));
    setHouseLibrary("gal", "admin");
    const settings = normalizeLibrarySettings("gallery", (db.prepare("SELECT settings_json FROM libraries WHERE id = 'gal'").get() as { settings_json: string }).settings_json);
    expect(settings.scan_extensions).toContain("jpg");
    expect(settings.scan_extensions).toContain("mp3");
    db.prepare("DELETE FROM libraries WHERE id = 'gal'").run();
    expect(getHouseLibrary()).toBeNull();
  });

  it("clears with null", () => {
    setHouseLibrary("gal", "admin");
    expect(setHouseLibrary(null, "admin")).toEqual({ ok: true, library: null });
    expect(getHouseLibrary()).toBeNull();
  });
});

describe("migration 71 carries the old choice over", () => {
  // A hand-made database with just the two tables the migration reads.
  function legacyDb(settings: Record<string, unknown>, libraries: { id: string; policy: string }[]) {
    const scratch = new Database(":memory:");
    scratch.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
      CREATE TABLE libraries (id TEXT PRIMARY KEY, type TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '{}');
    `);
    for (const [key, value] of Object.entries(settings)) {
      scratch.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    }
    for (const library of libraries) {
      scratch.prepare("INSERT INTO libraries (id, type, policy_json) VALUES (?, 'gallery', ?)").run(library.id, library.policy);
    }
    return scratch;
  }
  const houseOf = (scratch: Database.Database) => {
    const row = scratch.prepare("SELECT value FROM app_settings WHERE key = 'house_library'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as { libraryId: string | null }).libraryId : undefined;
  };

  it("prefers the recordings library, then the family-tree one", () => {
    const both = legacyDb(
      { stories_settings: { recordingsLibraryId: "rec" }, family_tree_settings: { galleryLibraryId: "fam" } },
      [{ id: "rec", policy: "{}" }, { id: "fam", policy: "{}" }]
    );
    runMigrationsFrom(both, 70);
    expect(houseOf(both)).toBe("rec");

    const familyOnly = legacyDb({ family_tree_settings: { galleryLibraryId: "fam", defaultPersonId: null } }, [{ id: "fam", policy: "{}" }]);
    runMigrationsFrom(familyOnly, 70);
    expect(houseOf(familyOnly)).toBe("fam");
  });

  it("skips a library that is gone or has become an Inbox, and leaves nothing when neither was set", () => {
    const stale = legacyDb(
      { stories_settings: { recordingsLibraryId: "gone" }, family_tree_settings: { galleryLibraryId: "box" } },
      [{ id: "box", policy: INBOX_POLICY }]
    );
    runMigrationsFrom(stale, 70);
    expect(houseOf(stale)).toBeUndefined();

    const fresh = legacyDb({}, []);
    runMigrationsFrom(fresh, 70);
    expect(houseOf(fresh)).toBeUndefined();
  });

  it("never overwrites a house library already chosen", () => {
    const chosen = legacyDb(
      { house_library: { libraryId: "mine" }, stories_settings: { recordingsLibraryId: "rec" } },
      [{ id: "rec", policy: "{}" }, { id: "mine", policy: "{}" }]
    );
    runMigrationsFrom(chosen, 70);
    expect(houseOf(chosen)).toBe("mine");
  });
});

describe("setting up a Photo Inbox in one step", () => {
  let base = "";
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "house-inbox-"));
    db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(base);
    // Creating a library insists on thumbnail storage being configured first.
    const thumbs = path.join(base, "thumbs");
    fs.mkdirSync(thumbs);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, thumbs);
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it("turns what the admin typed into a folder name, or refuses", () => {
    expect(safeFolderName("Photo Inbox")).toBe("Photo Inbox");
    expect(safeFolderName("Scans: box 3?")).toBe("Scans box 3");
    expect(safeFolderName("Mum's prints...")).toBe("Mum's prints");
    expect(safeFolderName("///")).toBeNull();
    expect(safeFolderName("..")).toBeNull();
  });

  it("creates the library over a new folder inside the container as the Photo Inbox", () => {
    const folder = path.join(base, safeFolderName("Photo Inbox")!);
    fs.mkdirSync(folder, { recursive: true });
    const create = () => createLibraryRecord({
      type: "gallery",
      data: { name: "Photo Inbox", sourcePath: folder, visibility: "public", publicRole: "viewer", mode: "managed" },
      userId: "admin",
      ip: "127.0.0.1",
      role: "inbox"
    });
    // There is one Inbox: while another library holds the role, making a second is refused.
    expect(create()).toMatchObject({ status: 409 });
    db.prepare("DELETE FROM libraries WHERE id = 'inbox'").run();
    const result = createLibraryRecord({
      type: "gallery",
      data: { name: "Photo Inbox", sourcePath: folder, visibility: "public", publicRole: "viewer", mode: "managed" },
      userId: "admin",
      ip: "127.0.0.1",
      role: "inbox"
    });
    expect(result).toMatchObject({ libraryId: expect.any(String) });
    if (!("libraryId" in result)) return;
    const row = db.prepare("SELECT role FROM libraries WHERE id = ?").get(result.libraryId) as { role: string | null };
    expect(row.role).toBe("inbox");
    // An Inbox cannot be the house library.
    expect(setHouseLibrary(result.libraryId, "admin")).toMatchObject({ ok: false, status: 409 });
  });
});
