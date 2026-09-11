// Shared series helpers. Series are per-library; membership + ordering live in
// series_items (position REAL, source 'scan' | 'manual'). A book the user curated
// by hand is flagged library_items.series_source = 'manual' and must survive
// rescans untouched — applyScannedSeries enforces that.
import { nanoid } from "nanoid";
import { stmt } from "../../../db/statement-cache.js";
import type { LibraryItemRow, SeriesRow } from "../../../db/rows.js";

function seriesSortName(name: string): string {
  return name.trim().toLowerCase().replace(/^(the|a|an)\s+/i, "");
}

export function upsertSeries(libraryId: string, name: string): { id: string } {
  const trimmed = name.trim();
  stmt("INSERT OR IGNORE INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, trimmed, seriesSortName(trimmed));
  return stmt("SELECT id FROM series WHERE library_id = ? AND name = ?").get(libraryId, trimmed) as Pick<SeriesRow, "id">;
}

// Apply a scan-derived series to a book unless the user pinned it by hand. A null
// name clears the book's scanned series; a 'manual' series is left untouched.
export function applyScannedSeries(bookId: string, libraryId: string, seriesName: string | null, position: number | null): void {
  const row = stmt("SELECT series_source FROM library_items WHERE id = ?")
    .get(bookId) as Pick<LibraryItemRow, "series_source"> | undefined;
  if (row?.series_source === "manual") return;

  stmt("DELETE FROM series_items WHERE item_id = ?").run(bookId);
  if (seriesName && seriesName.trim()) {
    const series = upsertSeries(libraryId, seriesName);
    stmt("INSERT INTO series_items (series_id, item_id, position, source) VALUES (?, ?, ?, 'scan')")
      .run(series.id, bookId, position);
  }
}
