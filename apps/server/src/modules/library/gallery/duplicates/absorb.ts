import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { applyItemAlphaIndex } from "../../shared/alphabet-index.js";
import { recomputeFaceCount } from "../people.js";
import { ID_CHUNK } from "./items.js";

// ────────────────────────────────────────────────────────────────────────────
//  Admin actions
// ────────────────────────────────────────────────────────────────────────────

const inList = (ids: string[]): string => ids.map(() => "?").join(",");

// Which of the losers' face rows should move to the keeper. Identical copies were each
// face-scanned independently, so moving every row would leave the keeper with the same
// face two or three times over — visible as repeated entries on a People page.
//
//  - keeper has no faces yet → take the richest single donor's rows wholesale, so the
//    keeper ends up exactly as one scanned copy was.
//  - keeper already has faces → take only rows naming a person the keeper doesn't
//    already have, one row per person. Everything else is a redundant detection and is
//    left to cascade away with the copy.
function pickFaceRowsToMove(keeperId: string, loserIds: string[]): string[] {
  const rows = db.prepare(
    `SELECT id, item_id, person_id FROM gallery_faces WHERE item_id IN (${inList(loserIds)}) ORDER BY item_id, id`
  ).all(...loserIds) as { id: string; item_id: string; person_id: string | null }[];
  if (rows.length === 0) return [];

  const keeperFaces = db.prepare(
    "SELECT person_id FROM gallery_faces WHERE item_id = ?"
  ).all(keeperId) as { person_id: string | null }[];

  if (keeperFaces.length === 0) {
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byItem.get(row.item_id);
      if (bucket) bucket.push(row.id); else byItem.set(row.item_id, [row.id]);
    }
    return [...byItem.values()].reduce((best, ids) => (ids.length > best.length ? ids : best), [] as string[]);
  }

  const seen = new Set(keeperFaces.map((f) => f.person_id).filter((id): id is string => Boolean(id)));
  const move: string[] = [];
  for (const row of rows) {
    if (!row.person_id || seen.has(row.person_id)) continue;
    seen.add(row.person_id);
    move.push(row.id);
  }
  return move;
}

// Move everything the losing copies carry onto the copy being kept, BEFORE they are
// trashed (trashing hard-deletes the row and cascades these links away). Only ever
// additive: a value already on the keeper is never overwritten.
//
// Face rows move too (see pickFaceRowsToMove), which is safe here precisely because
// tier 1 groups are byte-identical — the normalised boxes describe the same pixels
// either way. Their crop files stay where they are and remain referenced by the moved
// row; because the row is no longer attached to the loser, trashBook's face-crop cleanup
// correctly leaves them alone. (This does NOT generalise to the near-identical tier,
// where a resized copy's boxes would not transfer.)
export function absorbDuplicateMetadata(
  keeperId: string,
  loserIds: string[],
  // Only ever true for tier 1. A near-identical copy is a DIFFERENT image — resized or
  // re-cropped — so its normalised face boxes describe the wrong pixels on the keeper.
  options: { moveFaces?: boolean } = {}
): void {
  if (loserIds.length === 0) return;
  const { moveFaces = true } = options;
  const losers = inList(loserIds);
  const args = [keeperId, ...loserIds];

  const affectedPeople = (db.prepare(
    `SELECT DISTINCT person_id FROM gallery_faces
     WHERE person_id IS NOT NULL AND item_id IN (${losers}, ?)`
  ).all(...loserIds, keeperId) as { person_id: string }[]).map((r) => r.person_id);
  const faceIdsToMove = moveFaces ? pickFaceRowsToMove(keeperId, loserIds) : [];

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id)
       SELECT tag_id, 'library_item', ? FROM taggables
       WHERE entity_type = 'library_item' AND entity_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO gallery_album_items (album_id, item_id, position)
       SELECT album_id, ?, position FROM gallery_album_items WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO gallery_slideshow_items (slideshow_id, item_id, position, dwell_seconds)
       SELECT slideshow_id, ?, position, dwell_seconds FROM gallery_slideshow_items WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO family_tree_photos (person_id, item_id, position, added_by)
       SELECT person_id, ?, position, added_by FROM family_tree_photos WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO family_tree_event_photos (event_id, item_id, position, added_by)
       SELECT event_id, ?, position, added_by FROM family_tree_event_photos WHERE item_id IN (${losers})`
    ).run(...args);

    // Tables with their own id column need a fresh id per row, so they're copied in JS.
    const collections = db.prepare(
      `SELECT collection_id, position FROM collection_items
       WHERE entity_type = 'library_item' AND entity_id IN (${losers})`
    ).all(...loserIds) as { collection_id: string; position: number }[];
    const insertCollection = db.prepare(
      "INSERT OR IGNORE INTO collection_items (id, collection_id, entity_type, entity_id, position) VALUES (?, ?, 'library_item', ?, ?)"
    );
    for (const row of collections) insertCollection.run(nanoid(16), row.collection_id, keeperId, row.position);

    const saves = db.prepare(
      `SELECT user_id, note FROM item_saves WHERE item_id IN (${losers})`
    ).all(...loserIds) as { user_id: string; note: string | null }[];
    const insertSave = db.prepare("INSERT OR IGNORE INTO item_saves (id, user_id, item_id, note) VALUES (?, ?, ?, ?)");
    for (const row of saves) insertSave.run(nanoid(16), row.user_id, keeperId, row.note);

    const shares = db.prepare(
      `SELECT user_id, permission, created_by, expires_at FROM shares
       WHERE module = 'gallery' AND revoked_at IS NULL AND resource_id IN (${losers})`
    ).all(...loserIds) as { user_id: string; permission: string; created_by: string; expires_at: string | null }[];
    const insertShare = db.prepare(
      "INSERT OR IGNORE INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at) VALUES (?, 'gallery', ?, ?, ?, ?, ?)"
    );
    for (const row of shares) insertShare.run(nanoid(16), keeperId, row.user_id, row.permission, row.created_by, row.expires_at);

    for (let i = 0; i < faceIdsToMove.length; i += ID_CHUNK) {
      const chunk = faceIdsToMove.slice(i, i + ID_CHUNK);
      db.prepare(`UPDATE gallery_faces SET item_id = ? WHERE id IN (${inList(chunk)})`).run(keeperId, ...chunk);
    }

    // An album whose cover was a losing copy would otherwise be left coverless by the
    // ON DELETE SET NULL.
    db.prepare(`UPDATE gallery_albums SET cover_item_id = ? WHERE cover_item_id IN (${losers})`).run(...args);

    // Hand-edited values, taken from the best-scoring loser that has them and only
    // where the keeper has none of its own.
    const keeperMeta = db.prepare(
      "SELECT source, title, sort_title, description FROM item_metadata WHERE item_id = ?"
    ).get(keeperId) as { source: string; title: string | null; sort_title: string | null; description: string | null } | undefined;
    if (keeperMeta?.source !== "manual") {
      const donor = db.prepare(
        `SELECT title, sort_title, description FROM item_metadata
         WHERE source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { title: string | null; sort_title: string | null; description: string | null } | undefined;
      if (donor) {
        db.prepare(`
          INSERT INTO item_metadata (item_id, source, title, sort_title, description)
          VALUES (?, 'manual', ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            source = 'manual', title = excluded.title,
            sort_title = excluded.sort_title, description = excluded.description,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        `).run(keeperId, donor.title, donor.sort_title, donor.description);
        applyItemAlphaIndex(keeperId);
      }
    }

    const keeperDetails = db.prepare(
      "SELECT taken_at_source, gps_source FROM gallery_details WHERE item_id = ?"
    ).get(keeperId) as { taken_at_source: string; gps_source: string } | undefined;

    if (keeperDetails && keeperDetails.taken_at_source !== "manual") {
      const donor = db.prepare(
        `SELECT taken_at FROM gallery_details WHERE taken_at_source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { taken_at: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET taken_at = ?, taken_at_source = 'manual' WHERE item_id = ?")
          .run(donor.taken_at, keeperId);
      }
    }

    // Scanned camera info, where the keeper has none. A film scanner writes the make and
    // model onto its low-resolution index scan and not onto the full-size one, so the
    // copy worth keeping is routinely the copy without them — and losing the camera with
    // the preview would be a real, if small, loss for nothing.
    const keeperCamera = db.prepare(
      "SELECT camera_make, camera_model, taken_at FROM gallery_details WHERE item_id = ?"
    ).get(keeperId) as { camera_make: string | null; camera_model: string | null; taken_at: string | null } | undefined;
    if (keeperCamera && !keeperCamera.camera_make && !keeperCamera.camera_model) {
      const donor = db.prepare(
        `SELECT camera_make, camera_model FROM gallery_details
         WHERE item_id IN (${losers}) AND (camera_make IS NOT NULL OR camera_model IS NOT NULL) LIMIT 1`
      ).get(...loserIds) as { camera_make: string | null; camera_model: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET camera_make = ?, camera_model = ? WHERE item_id = ?")
          .run(donor.camera_make, donor.camera_model, keeperId);
      }
    }
    // Likewise a taken-at the keeper simply doesn't have. Only when it has none: a
    // scanned date it does have is its own, and 'manual' is handled above.
    if (keeperCamera && !keeperCamera.taken_at) {
      const donor = db.prepare(
        `SELECT taken_at FROM gallery_details WHERE item_id IN (${losers}) AND taken_at IS NOT NULL LIMIT 1`
      ).get(...loserIds) as { taken_at: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET taken_at = ? WHERE item_id = ?").run(donor.taken_at, keeperId);
      }
    }

    if (keeperDetails && keeperDetails.gps_source !== "manual") {
      const donor = db.prepare(
        `SELECT gps_lat, gps_lng FROM gallery_details WHERE gps_source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { gps_lat: number | null; gps_lng: number | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual' WHERE item_id = ?")
          .run(donor.gps_lat, donor.gps_lng, keeperId);
      }
    }
  })();

  // Two items collapsing into one changes each person's distinct-item tally.
  for (const personId of affectedPeople) recomputeFaceCount(personId);
}
