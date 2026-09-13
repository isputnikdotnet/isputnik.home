import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { getAppStorageSetting } from "../src/core/app-storage.js";
import {
  BACKUP_PATH_SETTINGS_KEY,
  getSystemDataPath,
  resolveBackupPath,
  resolveMetadataPath,
  saveSystemDataPath,
  suggestedSystemDataPath
} from "../src/core/system-data.js";
import {
  configuredThumbnailPathValue,
  getConfiguredThumbnailPath,
  thumbnailPathSettingKey,
  thumbnailPathSource
} from "../src/modules/library/shared/thumbnail.js";
import { getTrashRootSetting } from "../src/modules/library/shared/trash-settings.js";
import {
  setBackupFolder,
  setSystemDataPath,
  setThumbnailFolder,
  SystemDataError,
  systemDataView,
  validateSystemDataPath
} from "../src/modules/library/system-data.js";
import { systemDataRoutesPlugin } from "../src/modules/library/system-data-routes.js";
import { convertStorageSettings } from "../src/modules/library/system-data-upgrade.js";
import { waitForStorageMoves } from "../src/modules/library/shared/storage-move.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// System data (docs/system-data-plan.md, phase 2): the one folder the app needs,
// the folders that follow it or keep a place of their own, the checks a candidate
// folder has to pass, and the startup conversion that moves no file.

let base = "";

function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
function setting(key: string): string | null {
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
function libraryAt(id: string, source: string, role?: "inbox" | "app-files"): void {
  makeLibrary(id, { createdBy: "admin", type: "gallery", role });
  fs.mkdirSync(source, { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(source, id);
}

/** Runs `fn` with BACKUP_PATH unset (the test sandbox pins it), then puts it back. */
async function withoutBackupEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.BACKUP_PATH;
  delete process.env.BACKUP_PATH;
  try { return await fn(); } finally { if (saved !== undefined) process.env.BACKUP_PATH = saved; }
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "system-data-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("which folder wins", () => {
  it("thumbnails: a folder of their own, else system data, else none", () => {
    expect(thumbnailPathSource()).toBeNull();
    expect(() => getConfiguredThumbnailPath()).toThrowError(/Choose system data/);

    saveSystemDataPath(path.join(base, "sys"), "admin");
    expect(thumbnailPathSource()).toEqual({ path: path.join(base, "sys", "thumbnails"), source: "system" });

    setSetting(thumbnailPathSettingKey, path.join(base, "own"));
    expect(thumbnailPathSource()).toEqual({ path: path.join(base, "own"), source: "setting" });
  });

  it("backups: a folder of their own, else BACKUP_PATH, else system data, else data/backups", async () => {
    expect(resolveBackupPath()).toEqual({ path: config.backupPath, source: "env" });
    setSetting(BACKUP_PATH_SETTINGS_KEY, path.join(base, "own-backups"));
    expect(resolveBackupPath()).toEqual({ path: path.join(base, "own-backups"), source: "setting" });
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(BACKUP_PATH_SETTINGS_KEY);

    await withoutBackupEnv(() => {
      expect(resolveBackupPath().source).toBe("default");
      saveSystemDataPath(path.join(base, "sys"), "admin");
      expect(resolveBackupPath()).toEqual({ path: path.join(base, "sys", "backups"), source: "system" });
    });
  });

  it("metadata: system data once it is set", () => {
    if (config.metadataPath) return; // METADATA_PATH pins it; nothing to see here
    expect(resolveMetadataPath()).toBeNull();
    saveSystemDataPath(path.join(base, "sys"), "admin");
    expect(resolveMetadataPath()).toEqual({ path: path.join(base, "sys", "metadata"), source: "system" });
  });

  it("the bin is its own setting, never App storage's", () => {
    setSetting("app_storage", JSON.stringify({ path: path.join(base, "app"), rooms: { trash: "app" } }));
    expect(getTrashRootSetting()).toBeNull();
  });
});

describe("a candidate folder", () => {
  it("must be absolute, is made when missing, and must be writable", () => {
    expect(() => validateSystemDataPath("relative/sys")).toThrowError(SystemDataError);
    const made = validateSystemDataPath(path.join(base, "new", "sys"));
    expect(fs.statSync(made).isDirectory()).toBe(true);
  });

  it("stays outside every library and holds none but the app's own", () => {
    libraryAt("PHOTOS", path.join(base, "media", "Photos"));
    expect(() => validateSystemDataPath(path.join(base, "media", "Photos", "sys"))).toThrowError(/inside the library/);
    expect(() => validateSystemDataPath(path.join(base, "media"))).toThrowError(/inside that folder/);

    libraryAt("INBOX", path.join(base, "sys", "app-storage", "Photo Inbox"), "inbox");
    expect(validateSystemDataPath(path.join(base, "sys"))).toBe(path.join(base, "sys"));
  });

  it("is not a container itself", () => {
    fs.mkdirSync(path.join(base, "media"));
    db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('sr', 'Media', ?, 'admin')").run(path.join(base, "media"));
    expect(() => validateSystemDataPath(path.join(base, "media"))).toThrowError(/container "Media"/);
  });
});

describe("changing folders", () => {
  it("choosing system data makes its folders; changing it carries what follows it", async () => {
    const first = path.join(base, "sys1");
    const view = setSystemDataPath(first, "admin");
    expect(view.path).toBe(first);
    for (const folder of ["thumbnails", "backups", "metadata"]) expect(fs.existsSync(path.join(first, folder))).toBe(true);

    fs.mkdirSync(path.join(first, "thumbnails", "lib1"), { recursive: true });
    fs.writeFileSync(path.join(first, "thumbnails", "lib1", "a.webp"), "THUMB");
    const second = path.join(base, "sys2");
    setSystemDataPath(second, "admin");
    await waitForStorageMoves();
    expect(configuredThumbnailPathValue()).toBe(path.join(second, "thumbnails"));
    expect(fs.readFileSync(path.join(second, "thumbnails", "lib1", "a.webp"), "utf8")).toBe("THUMB");
    expect(fs.existsSync(path.join(first, "thumbnails", "lib1"))).toBe(false);
  });

  it("leaves a folder of its own where it is when system data changes", async () => {
    setSystemDataPath(path.join(base, "sys1"), "admin");
    const own = path.join(base, "own-thumbs");
    setThumbnailFolder(own, "admin");
    fs.writeFileSync(path.join(own, "keep.webp"), "X");
    setSystemDataPath(path.join(base, "sys2"), "admin");
    await waitForStorageMoves();
    expect(configuredThumbnailPathValue()).toBe(own);
    expect(fs.existsSync(path.join(own, "keep.webp"))).toBe(true);
  });

  it("thumbnails go to a folder of their own and back, carried both ways", async () => {
    setSystemDataPath(path.join(base, "sys"), "admin");
    fs.writeFileSync(path.join(base, "sys", "thumbnails", "t.webp"), "T");
    const own = path.join(base, "fast-disk");
    expect(setThumbnailFolder(own, "admin").thumbnails).toMatchObject({ path: own, source: "setting" });
    await waitForStorageMoves();
    expect(fs.existsSync(path.join(own, "t.webp"))).toBe(true);

    expect(setThumbnailFolder(null, "admin").thumbnails).toMatchObject({ path: path.join(base, "sys", "thumbnails"), source: "system" });
    await waitForStorageMoves();
    expect(fs.existsSync(path.join(base, "sys", "thumbnails", "t.webp"))).toBe(true);
  });

  it("refuses to send thumbnails back when there is nothing to send them back to", () => {
    if (config.thumbnailPath) return;
    expect(() => setThumbnailFolder(null, "admin")).toThrowError(/Choose system data first/);
  });

  it("backups go to a folder of their own, the backups already made with them", async () => {
    const before = resolveBackupPath().path;
    fs.mkdirSync(before, { recursive: true });
    const name = "isputnik-20260912-030000.zip";
    fs.writeFileSync(path.join(before, name), "ZIP");
    const own = path.join(base, "offsite");
    const view = setBackupFolder(own, "admin");
    expect(view.backups).toMatchObject({ path: own, source: "setting" });
    await waitForStorageMoves();
    expect(fs.readFileSync(path.join(own, name), "utf8")).toBe("ZIP");
    expect(systemDataView().backups.count).toBe(1);
  });

  it("will not change system data under a running move", () => {
    setSystemDataPath(path.join(base, "sys1"), "admin");
    fs.writeFileSync(path.join(base, "sys1", "thumbnails", "t.webp"), "T");
    setSystemDataPath(path.join(base, "sys2"), "admin");
    expect(() => setSystemDataPath(path.join(base, "sys3"), "admin")).toThrowError(/storage move is running/);
    return waitForStorageMoves();
  });
});

describe("the 4.6 conversion moves no file", () => {
  it("leaves a fresh install alone", () => {
    if (config.thumbnailPath) return;
    expect(convertStorageSettings()).toBeNull();
    expect(getSystemDataPath()).toBeNull();
  });

  it("does nothing once system data is set", () => {
    saveSystemDataPath(path.join(base, "sys"), "admin");
    libraryAt("PHOTOS", path.join(base, "media", "Photos"));
    expect(convertStorageSettings()).toBeNull();
  });

  it("takes a thumbnail folder called thumbnails as system data's, and drops the setting it repeats", () => {
    libraryAt("PHOTOS", path.join(base, "media", "Photos"));
    setSetting(thumbnailPathSettingKey, path.join(base, "config", "thumbnails"));
    const result = convertStorageSettings();
    expect(result?.systemData).toBe(path.join(base, "config"));
    expect(setting(thumbnailPathSettingKey)).toBeNull();
    expect(thumbnailPathSource()).toEqual({ path: path.join(base, "config", "thumbnails"), source: "system" });
  });

  it("does not make a media share system data, and keeps the thumbnails where they were", () => {
    libraryAt("PHOTOS", path.join(base, "Demo", "media", "Photos"));
    setSetting(thumbnailPathSettingKey, path.join(base, "Demo", "thumbnails"));
    const result = convertStorageSettings();
    expect(result?.systemData).toBe(suggestedSystemDataPath());
    expect(configuredThumbnailPathValue()).toBe(path.join(base, "Demo", "thumbnails"));
  });

  it("turns App storage's bin, thumbnails and backups rooms into settings of their own", async () => {
    libraryAt("PHOTOS", path.join(base, "media", "Photos"));
    const app = path.join(base, "media", "iSputnik");
    setSetting("app_storage", JSON.stringify({ path: app, rooms: { trash: "app", thumbnails: "app", backups: "app", renders: "own", maps: "own" } }));
    await withoutBackupEnv(() => {
      const result = convertStorageSettings();
      expect(result?.droppedRooms.sort()).toEqual(["backups", "thumbnails", "trash"]);
      expect(configuredThumbnailPathValue()).toBe(path.join(app, "Thumbnails"));
      expect(resolveBackupPath()).toEqual({ path: path.join(app, "Backups"), source: "setting" });
    });
    expect(getTrashRootSetting()).toBe(path.join(app, "Recycle Bin"));
    expect(getAppStorageSetting()).toEqual({ path: app, rooms: { renders: "own", maps: "own" } });
    expect(JSON.parse(setting("app_storage")!).rooms).toEqual({ renders: "own", maps: "own" });
  });

  it("keeps BACKUP_PATH as it is rather than copying it into a setting", () => {
    libraryAt("PHOTOS", path.join(base, "media", "Photos"));
    setSetting(thumbnailPathSettingKey, path.join(base, "config", "thumbnails"));
    convertStorageSettings();
    expect(setting(BACKUP_PATH_SETTINGS_KEY)).toBeNull();
    expect(resolveBackupPath().source).toBe("env");
  });
});

describe("the routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [systemDataRoutesPlugin] }));
  });

  it("reads, refuses a bad folder, and sets a good one", async () => {
    const cookie = await signIn("admin");
    const read = await app.inject({ method: "GET", url: "/api/storage/system-data", headers: { cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: null, suggested: suggestedSystemDataPath() });

    const bad = await app.inject({ method: "PUT", url: "/api/storage/system-data", headers: { cookie }, payload: { path: "not/absolute" } });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({ method: "PUT", url: "/api/storage/system-data", headers: { cookie }, payload: { path: path.join(base, "sys") } });
    expect(good.statusCode).toBe(200);
    expect(good.json().path).toBe(path.join(base, "sys"));

    const space = await app.inject({ method: "GET", url: `/api/storage/disk-space?path=${encodeURIComponent(path.join(base, "not-yet"))}`, headers: { cookie } });
    expect(space.json().space.total).toBeGreaterThan(0);
  });

  it("is for admins only", async () => {
    makeUser("kid");
    const cookie = await signIn("kid");
    const read = await app.inject({ method: "GET", url: "/api/storage/system-data", headers: { cookie } });
    expect(read.statusCode).toBe(403);
  });
});
