import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestEbookGroup } from "../src/modules/library/ebook/scanner.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import type { FolderContext } from "../src/modules/library/shared/structure-inference.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const AUTO = normalizeLibrarySettings("ebook", JSON.stringify({ auto_series: true }));
const OFF = normalizeLibrarySettings("ebook", "{}");
const numberedPair: FolderContext = { bookCount: 2, numberedBookCount: 2 };

interface FileEntry { absolutePath: string; relativePath: string; fileName: string; extension: string; size: number }
const fileEntry = (relativePath: string, size = 100): FileEntry => ({
  absolutePath: `/src/EB/${relativePath}`,
  relativePath,
  fileName: relativePath.split("/").pop()!,
  extension: `.${relativePath.split(".").pop()}`,
  size
});

// fileMetaEnabled=false keeps ingest off disk (no EPUB/FB2 read), so series here
// come purely from the folder heuristic — exactly what we want to exercise.
const seriesRows = () => db.prepare(`
  SELECT s.name AS name, si.position AS position, si.source AS source
  FROM series_items si
  JOIN series s ON s.id = si.series_id
  JOIN library_items li ON li.id = si.item_id
  WHERE li.library_id = 'EB'
  ORDER BY si.position
`).all() as { name: string; position: number; source: string }[];

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("EB", { createdBy: "u1", type: "ebook" });
  grant("group", EVERYONE_GROUP_ID, "EB", "member");
});

describe("ebook scan series inference", () => {
  it("groups a numbered folder into one series with positions", async () => {
    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], AUTO, false, numberedPair);
    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/2. Своя игра.fb2")], AUTO, false, numberedPair);

    expect(seriesRows()).toEqual([
      { name: "Ар-Деко", position: 1, source: "scan" },
      { name: "Ар-Деко", position: 2, source: "scan" }
    ]);
    expect((db.prepare("SELECT COUNT(*) c FROM series WHERE library_id = 'EB'").get() as { c: number }).c).toBe(1);
  });

  it("assigns nothing when auto_series is off", async () => {
    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], OFF, false, numberedPair);
    expect(seriesRows()).toHaveLength(0);
  });

  it("clears scan-derived series when auto_series is turned off and rescanned", async () => {
    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], AUTO, false, numberedPair);
    expect(seriesRows()).toHaveLength(1);
    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], OFF, false, numberedPair);
    expect(seriesRows()).toHaveLength(0);
  });

  it("leaves a loose book standalone", async () => {
    await ingestEbookGroup("EB", [fileEntry("Вне закона.fb2")], AUTO, false, { bookCount: 5, numberedBookCount: 0 });
    expect(seriesRows()).toHaveLength(0);
  });

  it("preserves a hand-pinned series across a rescan", async () => {
    const id = await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], AUTO, false, numberedPair);

    // User pins a different series by hand (series_source = 'manual').
    db.prepare("INSERT INTO series (id, library_id, name, sort_name) VALUES ('S1', 'EB', 'Pinned', 'pinned')").run();
    db.prepare("DELETE FROM series_items WHERE item_id = ?").run(id);
    db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES ('S1', ?, 5, 'manual')").run(id);
    db.prepare("UPDATE library_items SET series_source = 'manual' WHERE id = ?").run(id);

    await ingestEbookGroup("EB", [fileEntry("Ар-Деко/1. Ар-Деко.fb2")], AUTO, false, numberedPair);

    expect(seriesRows()).toEqual([{ name: "Pinned", position: 5, source: "manual" }]);
  });
});
