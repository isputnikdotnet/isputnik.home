import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestEbookGroup, ebookGroupKey } from "../src/modules/library/ebook/scanner.js";
import { queryEbookCatalog } from "../src/modules/library/ebook/catalog.js";
import { buildAcquisitionFeed, type AcquisitionSpec, type LinkCtx } from "../src/modules/library/ebook/opds.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import type { CatalogFilters } from "../src/modules/library/shared/catalog-core.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const EMPTY: CatalogFilters = { authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: [] };
const SETTINGS = normalizeLibrarySettings("ebook", "{}");
const CTX: LinkCtx = { origin: "http://home.test", tokenInPath: null };
const ALL_SPEC: AcquisitionSpec = { base: "/all", title: "All ebooks", id: "urn:isputnik:ebooks:all", sort: "title" };

// A synthetic walked file. `ingestEbookGroup` reads the filesystem only for EPUB
// metadata extraction, so non-EPUB groups (or fileMetaEnabled=false) never touch disk.
interface FileEntry { absolutePath: string; relativePath: string; fileName: string; extension: string; size: number }
const fileEntry = (relativePath: string, size = 100): FileEntry => ({
  absolutePath: `/src/EB/${relativePath}`,
  relativePath,
  fileName: relativePath.split("/").pop()!,
  extension: `.${relativePath.split(".").pop()}`,
  size
});

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("EB", { createdBy: "u1", type: "ebook" });
  grant("group", EVERYONE_GROUP_ID, "EB", "member");
});

describe("ebookGroupKey", () => {
  it("keys by directory + basename, so formats of one book share a key", () => {
    expect(ebookGroupKey("Dune.epub")).toBe("Dune");
    expect(ebookGroupKey("Dune.pdf")).toBe("Dune");
    expect(ebookGroupKey("sci-fi/Dune.fb2")).toBe("sci-fi/Dune");
    expect(ebookGroupKey("Dune.epub")).not.toBe(ebookGroupKey("Other.epub"));
  });
});

describe("multi-format ebook ingest", () => {
  it("folds several formats of one book into a single item with a document each", async () => {
    await ingestEbookGroup("EB", [fileEntry("Dune.pdf", 500), fileEntry("Dune.fb2", 300)], SETTINGS, false);
    const items = db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = 'EB'").all() as { id: string; folder_path: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].folder_path).toBe("Dune");
    const docs = db.prepare("SELECT format FROM document_files WHERE item_id = ? AND status = 'available' ORDER BY format").all(items[0].id) as { format: string }[];
    expect(docs.map((d) => d.format)).toEqual(["fb2", "pdf"]);
  });

  it("a rescan upserts in place and drops a format that disappeared", async () => {
    const id = await ingestEbookGroup("EB", [fileEntry("Dune.pdf"), fileEntry("Dune.fb2")], SETTINGS, false);
    await ingestEbookGroup("EB", [fileEntry("Dune.pdf")], SETTINGS, false); // fb2 gone this pass
    expect((db.prepare("SELECT COUNT(*) c FROM library_items WHERE library_id = 'EB'").get() as { c: number }).c).toBe(1);
    const available = db.prepare("SELECT format FROM document_files WHERE item_id = ? AND status = 'available'").all(id) as { format: string }[];
    expect(available.map((d) => d.format)).toEqual(["pdf"]);
    const missing = db.prepare("SELECT format FROM document_files WHERE item_id = ? AND status = 'missing'").all(id) as { format: string }[];
    expect(missing.map((d) => d.format)).toEqual(["fb2"]);
  });

  it("surfaces one catalog row with EPUB primary and every format listed", async () => {
    await ingestEbookGroup("EB", [fileEntry("Dune.pdf"), fileEntry("Dune.epub")], SETTINGS, false);
    const { books, total } = queryEbookCatalog("u1", ["EB"], { q: "", sort: "title", limit: 50, offset: 0, filters: EMPTY });
    expect(total).toBe(1);
    const book = books[0] as { format: string; formats: string[]; fileCount: number; documents: { format: string }[] };
    expect(book.format).toBe("epub");                  // EPUB preferred regardless of insert order
    expect([...book.formats].sort()).toEqual(["epub", "pdf"]);
    expect(book.documents[0].format).toBe("epub");     // ordered EPUB-first
    expect(book.fileCount).toBe(2);
  });

  it("emits one OPDS acquisition link per format", async () => {
    const id = await ingestEbookGroup("EB", [fileEntry("Dune.pdf"), fileEntry("Dune.epub")], SETTINGS, false);
    const xml = buildAcquisitionFeed({ id: "u1", role: "member" }, CTX, ALL_SPEC, {});
    const epubDoc = db.prepare("SELECT id FROM document_files WHERE item_id = ? AND format = 'epub'").get(id) as { id: string };
    const pdfDoc = db.prepare("SELECT id FROM document_files WHERE item_id = ? AND format = 'pdf'").get(id) as { id: string };
    expect(xml).toContain(`http://home.test/opds/document/${id}/${epubDoc.id}`);
    expect(xml).toContain(`http://home.test/opds/document/${id}/${pdfDoc.id}`);
    expect(xml).toContain('type="application/epub+zip"');
    expect(xml).toContain('type="application/pdf"');
  });
});
