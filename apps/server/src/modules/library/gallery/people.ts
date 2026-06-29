// People-in-photos queries and mutations for the gallery. Phase 1 is manual
// whole-photo tagging: a `gallery_people` row is a named person, and tagging a photo
// inserts a `gallery_faces` row with a NULL box. The optional face-recognition pass
// (Phase 2) reuses the same tables with real boxes + embeddings.
//
// Everything here is scoped to the gallery libraries a user can access — a person is
// global, but their photo list and face counts only ever include accessible,
// non-deleted assets, so a viewer never learns a person appears in a library they
// can't see.
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog.js";
import { recomputeClusterCentroid } from "./faces/cluster.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface GalleryPersonSummary {
  id: string;
  name: string;
  faceCount: number;
  coverUrl: string | null;
}

// People with at least one accessible, non-deleted tagged asset. The cover is the
// most recently-taken such asset's thumbnail (window-function pick, mirroring the
// Folder view). Hidden people are omitted unless asked for.
export function listGalleryPeople(libIds: string[], includeHidden = false): GalleryPersonSummary[] {
  if (libIds.length === 0) return [];
  const libIn = inClause(libIds.length);
  const rows = db.prepare(`
    -- One row per (person, item): an auto pass can leave several face rows for the
    -- same person in one photo, so DISTINCT collapses them before counting. taken_at
    -- and cover are functionally dependent on item_id, so the row stays unique.
    WITH accessible AS (
      SELECT DISTINCT gf.person_id AS person_id, li.id AS item_id,
        gd.taken_at AS taken_at, im.cover_storage_key AS cover
      FROM gallery_faces gf
      JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL AND li.library_id IN (${libIn})
      JOIN gallery_details gd ON gd.item_id = li.id
      LEFT JOIN item_metadata im ON im.item_id = li.id
      WHERE gf.person_id IS NOT NULL AND gf.assignment != 'rejected'
    ),
    ranked AS (
      SELECT person_id, cover,
        ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY datetime(taken_at) DESC) AS rn,
        COUNT(*) OVER (PARTITION BY person_id) AS cnt
      FROM accessible
    )
    SELECT gp.id, gp.name, ranked.cover AS cover, ranked.cnt AS cnt
    FROM gallery_people gp
    JOIN ranked ON ranked.person_id = gp.id AND ranked.rn = 1
    ${includeHidden ? "" : "WHERE gp.hidden = 0"}
    ORDER BY (gp.name = '') ASC, ranked.cnt DESC, gp.name COLLATE NOCASE
  `).all(...libIds) as { id: string; name: string; cover: string | null; cnt: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    faceCount: r.cnt,
    coverUrl: r.cover ? `/api/library/covers/${r.cover}` : null
  }));
}

export function getGalleryPersonRow(personId: string): { id: string; name: string; hidden: number } | null {
  const row = db.prepare("SELECT id, name, hidden FROM gallery_people WHERE id = ?").get(personId) as
    | { id: string; name: string; hidden: number }
    | undefined;
  return row ?? null;
}

// A person's accessible photos, newest-first, paged. Returns null when the person
// doesn't exist; an existing person with no accessible photos returns an empty page.
export function getGalleryPersonPhotos(
  userId: string,
  libIds: string[],
  personId: string,
  limit: number,
  offset: number
) {
  const person = getGalleryPersonRow(personId);
  if (!person) return null;
  if (libIds.length === 0) return { person: { id: person.id, name: person.name }, assets: [], total: 0 };
  const libIn = inClause(libIds.length);
  const itemFilter = `
    library_items.id IN (
      SELECT gf.item_id FROM gallery_faces gf
      WHERE gf.person_id = ? AND gf.assignment != 'rejected'
    )
    AND library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL`;
  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE ${itemFilter}
  `).get(personId, ...libIds) as { n: number }).n;
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${itemFilter}
    ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, personId, ...libIds, limit, offset) as GalleryAssetRow[];
  return { person: { id: person.id, name: person.name }, assets: rows.map(mapAsset), total };
}

function recomputeFaceCount(personId: string) {
  db.prepare(`
    UPDATE gallery_people SET
      face_count = (
        SELECT COUNT(DISTINCT gf.item_id) FROM gallery_faces gf
        JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL
        WHERE gf.person_id = ? AND gf.assignment != 'rejected'
      ),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(personId, personId);
}

export function createGalleryPerson(name: string): GalleryPersonSummary {
  const id = nanoid(16);
  db.prepare("INSERT INTO gallery_people (id, name) VALUES (?, ?)").run(id, name.trim());
  return { id, name: name.trim(), faceCount: 0, coverUrl: null };
}

// Find an existing person by name (case-insensitive). Used so tagging by name links
// to the same person instead of spawning a duplicate when the client didn't resolve
// an id first.
export function findGalleryPersonByName(name: string): { id: string; name: string } | null {
  const row = db.prepare("SELECT id, name FROM gallery_people WHERE name = ? COLLATE NOCASE")
    .get(name.trim()) as { id: string; name: string } | undefined;
  return row ?? null;
}

export function renameGalleryPerson(personId: string, name: string): boolean {
  const res = db.prepare(
    "UPDATE gallery_people SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(name.trim(), personId);
  return res.changes > 0;
}

export function setGalleryPersonHidden(personId: string, hidden: boolean): boolean {
  const res = db.prepare(
    "UPDATE gallery_people SET hidden = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(hidden ? 1 : 0, personId);
  return res.changes > 0;
}

// Deleting a person removes its manual whole-photo tags (pure links, worthless once
// the person is gone) and unlinks any auto-detected faces (ON DELETE SET NULL keeps
// the box + embedding so they can re-cluster later). Either way no asset is lost.
export function deleteGalleryPerson(personId: string): boolean {
  return db.transaction(() => {
    db.prepare("DELETE FROM gallery_faces WHERE person_id = ? AND box_x IS NULL AND source = 'manual'").run(personId);
    const res = db.prepare("DELETE FROM gallery_people WHERE id = ?").run(personId);
    return res.changes > 0;
  })();
}

// Merge one person into another: move all of the source's faces (manual tags and
// auto-detected) to the target, delete the source, and recompute the target's
// aggregates. Used to fix a person who got split into two clusters, or to fold an
// auto cluster into an already-named person. Returns false if either id is unknown.
export function mergeGalleryPeople(sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return false;
  const source = getGalleryPersonRow(sourceId);
  const target = getGalleryPersonRow(targetId);
  if (!source || !target) return false;
  db.transaction(() => {
    db.prepare("UPDATE gallery_faces SET person_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE person_id = ?").run(targetId, sourceId);
    db.prepare("DELETE FROM gallery_people WHERE id = ?").run(sourceId);
    recomputeClusterCentroid(targetId);
  })();
  return true;
}

// Tag one photo with a person (manual, whole-photo). Idempotent: re-tagging the same
// person on the same photo is a no-op. Returns false if the person doesn't exist.
export function tagAssetPerson(itemId: string, personId: string): boolean {
  const person = db.prepare("SELECT id FROM gallery_people WHERE id = ?").get(personId) as { id: string } | undefined;
  if (!person) return false;
  const existing = db.prepare(
    "SELECT id FROM gallery_faces WHERE item_id = ? AND person_id = ? AND box_x IS NULL AND source = 'manual'"
  ).get(itemId, personId) as { id: string } | undefined;
  if (!existing) {
    db.prepare(
      "INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'manual')"
    ).run(nanoid(16), itemId, personId);
    recomputeFaceCount(personId);
  }
  return true;
}

// Remove a person from a photo — works for both how a person got attached:
//   • manual whole-photo tags are deleted outright;
//   • auto-detected faces are marked 'rejected', so they leave the cluster, stop
//     counting, and are NOT re-clustered back to the same person on the next pass.
// Recomputes the person's aggregates afterwards. This is the single "not this person
// in this photo" action used by both the lightbox chip and the person page.
export function untagAssetPerson(itemId: string, personId: string): void {
  const changed = db.transaction(() => {
    const del = db.prepare(
      "DELETE FROM gallery_faces WHERE item_id = ? AND person_id = ? AND box_x IS NULL AND source = 'manual'"
    ).run(itemId, personId).changes;
    const rejected = db.prepare(
      "UPDATE gallery_faces SET assignment = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ? AND person_id = ? AND source = 'scan' AND assignment != 'rejected'"
    ).run(itemId, personId).changes;
    return del + rejected;
  })();
  if (changed > 0) recomputeClusterCentroid(personId);
}
