// Shared series helpers. Series are per-library; membership + ordering live in
// series_items (position REAL, source 'scan' | 'manual'). A book the user has
// curated by hand is flagged library_items.series_source = 'manual' and must
// survive rescans untouched — applyScannedSeries enforces that.
import { nanoid } from "nanoid";
import { db } from "../../../db.js";

function seriesSortName(name: string): string {
  return name.trim().toLowerCase().replace(/^(the|a|an)\s+/i, "");
}

export function upsertSeries(libraryId: string, name: string): { id: string } {
  const trimmed = name.trim();
  db.prepare("INSERT OR IGNORE INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, trimmed, seriesSortName(trimmed));
  return db.prepare("SELECT id FROM series WHERE library_id = ? AND name = ?").get(libraryId, trimmed) as { id: string };
}

// Apply a scan-derived series to a book, unless the user pinned it by hand.
// Passing a null name clears the book's scanned series (e.g. it's no longer in a
// series-shaped folder). Manual series (series_source = 'manual') are left alone.
export function applyScannedSeries(bookId: string, libraryId: string, seriesName: string | null, position: number | null): void {
  const row = db.prepare("SELECT series_source FROM library_items WHERE id = ?")
    .get(bookId) as { series_source?: string } | undefined;
  if (row?.series_source === "manual") return;

  db.prepare("DELETE FROM series_items WHERE item_id = ?").run(bookId);
  if (seriesName && seriesName.trim()) {
    const series = upsertSeries(libraryId, seriesName);
    db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES (?, ?, ?, 'scan')")
      .run(series.id, bookId, position);
  }
}
