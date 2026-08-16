// A full backup carrying the thumbnail cache runs to gigabytes, and the reader it
// used to go through (adm-zip) loads the whole archive into one Buffer. Node caps
// that at 2 GiB — "File size (3311608571) is greater than 2 GiB" — so restore failed
// on exactly the large backups people most need back. These read by streaming.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractFromZip, isBackupDatabaseEntry, zipHasEntry } from "../src/modules/backups/zip-read.js";

let workdir: string;

// A zip on disk, built the way the backup route builds one.
async function makeZip(name: string, files: Record<string, string>): Promise<string> {
  const target = path.join(workdir, name);
  const out = fs.createWriteStream(target);
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.pipe(out);
  for (const [entryName, content] of Object.entries(files)) {
    archive.append(content, { name: entryName });
  }
  const done = new Promise<void>((resolve, reject) => {
    out.on("close", () => resolve());
    archive.on("error", reject);
  });
  await archive.finalize();
  await done;
  return target;
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-zip-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("finding the database inside a backup", () => {
  it("sees one at the root and one under a wrapping folder", async () => {
    const flat = await makeZip("flat.zip", { "database.sqlite": "db", "thumbnails/a.jpg": "a" });
    const nested = await makeZip("nested.zip", { "isputnik-20260101/database.sqlite": "db" });

    expect(await zipHasEntry(flat, isBackupDatabaseEntry)).toBe(true);
    expect(await zipHasEntry(nested, isBackupDatabaseEntry)).toBe(true);
  });

  it("says no when the zip is not a backup", async () => {
    const zip = await makeZip("holiday.zip", { "photos/beach.jpg": "x", "notes.txt": "y" });
    expect(await zipHasEntry(zip, isBackupDatabaseEntry)).toBe(false);
  });

  it("never loads the archive into memory", async () => {
    const zip = await makeZip("big.zip", { "database.sqlite": "db", "thumbnails/a.jpg": "a" });
    const readFileSync = vi.spyOn(fs, "readFileSync");

    await zipHasEntry(zip, isBackupDatabaseEntry);
    await extractFromZip(zip, (name) => (isBackupDatabaseEntry(name) ? path.join(workdir, "out.sqlite") : null));

    // The regression itself: the moment the archive goes through readFileSync, any
    // backup past 2 GiB throws instead of restoring.
    expect(readFileSync.mock.calls.some(([target]) => target === zip)).toBe(false);
    readFileSync.mockRestore();
  });
});

describe("extracting the entries a restore asks for", () => {
  it("writes only what it claims, into folders it creates", async () => {
    const zip = await makeZip("full.zip", {
      "database.sqlite": "the database",
      "thumbnails/covers/one.jpg": "cover one",
      "thumbnails/covers/two.jpg": "cover two",
      "metadata/skip-me.json": "{}"
    });
    const cache = path.join(workdir, "cache");

    const written = await extractFromZip(zip, (name) =>
      name.startsWith("thumbnails/") ? path.join(cache, name.slice("thumbnails/".length)) : null
    );

    expect(written).toBe(2);
    expect(fs.readFileSync(path.join(cache, "covers", "one.jpg"), "utf8")).toBe("cover one");
    expect(fs.readFileSync(path.join(cache, "covers", "two.jpg"), "utf8")).toBe("cover two");
    expect(fs.existsSync(path.join(cache, "skip-me.json"))).toBe(false);
  });

  it("reports nothing written when the entry isn't there", async () => {
    const zip = await makeZip("coverless.zip", { "database.sqlite": "db" });
    const written = await extractFromZip(zip, (name) =>
      name.startsWith("thumbnails/") ? path.join(workdir, "cache", name) : null
    );
    expect(written).toBe(0);
  });
});
