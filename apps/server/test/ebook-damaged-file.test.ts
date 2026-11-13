import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { enqueueEbookScan, extractEpubMetadata, processEbookScanQueue } from "../src/modules/library/ebook/scanner.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// Issue #105: one damaged EPUB ("Invalid CEN header") stopped the whole ebook
// scan. AdmZip opens such a file without complaint and throws only on the first
// read of an entry, which sat outside the extractor's try; nothing in the scan
// loop caught it either, so every retry failed and the library ended on "error".

function goodEpub(title: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from(
    `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`, "utf8"
  ));
  zip.addFile("content.opf", Buffer.from(
    `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title>${title}</dc:title></metadata></package>`, "utf8"
  ));
  return zip.toBuffer();
}

// A readable EPUB whose central directory entries are broken: the end record still
// points at them, so the archive opens, and reading an entry fails.
function damagedEpub(): Buffer {
  const bytes = Buffer.from(goodEpub("Never read"));
  const central = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (let at = bytes.indexOf(central); at !== -1; at = bytes.indexOf(central, at + 4)) {
    bytes.fill(0, at, at + 4);
  }
  return bytes;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-damaged-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a damaged EPUB", () => {
  it("is the kind of file that throws on read, not on open", () => {
    const file = path.join(dir, "Bad.epub");
    fs.writeFileSync(file, damagedEpub());
    const zip = new AdmZip(file);
    expect(() => zip.getEntry("META-INF/container.xml")?.getData()).toThrow();
  });

  it("gives no metadata instead of throwing", () => {
    const file = path.join(dir, "Bad.epub");
    fs.writeFileSync(file, damagedEpub());
    expect(extractEpubMetadata(file)).toBeNull();
  });

  it("does not stop the library scan: the book is titled from its file name and the rest is scanned", async () => {
    fs.writeFileSync(path.join(dir, "Bad.epub"), damagedEpub());
    fs.writeFileSync(path.join(dir, "Good.epub"), goodEpub("A Good Book"));
    resetDb();
    makeUser("u1");
    // A library source must sit inside a storage root, and outside thumbnail storage.
    const thumbs = fs.mkdtempSync(path.join(os.tmpdir(), "ebook-damaged-thumbs-"));
    db.prepare("DELETE FROM storage_roots").run();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('library.thumbnail_path', ?)").run(thumbs);
    db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'u1')").run(dir);
    makeLibrary("EB", { createdBy: "u1", type: "ebook" });
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'EB'").run(dir);

    const jobId = enqueueEbookScan("EB");
    await processEbookScanQueue();

    const job = db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(jobId) as { status: string; error: string | null };
    expect(job).toEqual({ status: "completed", error: null });
    const library = db.prepare("SELECT scan_status FROM libraries WHERE id = 'EB'").get() as { scan_status: string };
    expect(library.scan_status).toBe("idle");
    const titles = (db.prepare(`
      SELECT m.title FROM library_items i JOIN item_metadata m ON m.item_id = i.id
      WHERE i.library_id = 'EB' ORDER BY m.title
    `).all() as { title: string }[]).map((row) => row.title);
    expect(titles).toEqual(["A Good Book", "Bad"]);
    fs.rmSync(thumbs, { recursive: true, force: true });
  });
});
