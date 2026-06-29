// Greedy face clustering. The pure assignment step (assignFaces) is split from the DB
// layer so it can be unit-tested with synthetic vectors. The strategy is incremental:
// only faces not yet attached to a person are placed, and existing clusters (including
// ones the user has named) are never broken up — a new face either joins the nearest
// cluster above the similarity threshold or starts its own.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { blobToEmbedding, embeddingToBlob, centroidOf, cosineSimilarity } from "./embedding.js";
import { faceThreshold } from "./settings.js";

export interface FaceToCluster {
  id: string;
  embedding: Float32Array;
}

export interface ClusterCentroid {
  id: string;
  vec: Float32Array;
}

export interface FaceAssignment {
  faceId: string;
  clusterId: string;
  created: boolean;
}

// Place each face into the nearest existing centroid at/above `threshold`, else start
// a new cluster (whose centroid seeds from that face for the rest of this pass). Pure:
// no DB, deterministic for a given input order.
export function assignFaces(
  faces: FaceToCluster[],
  existing: ClusterCentroid[],
  threshold: number,
  makeId: () => string
): FaceAssignment[] {
  const centroids: ClusterCentroid[] = existing.map((c) => ({ id: c.id, vec: c.vec }));
  const out: FaceAssignment[] = [];
  for (const face of faces) {
    let bestId: string | null = null;
    let best = -Infinity;
    for (const c of centroids) {
      const score = cosineSimilarity(face.embedding, c.vec);
      if (score > best) { best = score; bestId = c.id; }
    }
    if (bestId && best >= threshold) {
      out.push({ faceId: face.id, clusterId: bestId, created: false });
    } else {
      const id = makeId();
      centroids.push({ id, vec: face.embedding });
      out.push({ faceId: face.id, clusterId: id, created: true });
    }
  }
  return out;
}

// Recompute a person's aggregates: distinct-item count over ALL non-rejected faces
// (manual + scan), and a centroid derived from its scan-face embeddings (NULL when it
// has none — i.e. a purely manual person stays a non-cluster). Cover face is the
// highest-scoring scan face that has a crop thumbnail, if any.
export function recomputeClusterCentroid(clusterId: string): void {
  const faceCount = (db.prepare(
    "SELECT COUNT(DISTINCT gf.item_id) n FROM gallery_faces gf JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL WHERE gf.person_id = ? AND gf.assignment != 'rejected'"
  ).get(clusterId) as { n: number }).n;
  const scanRows = db.prepare(
    "SELECT embedding FROM gallery_faces WHERE person_id = ? AND source = 'scan' AND assignment != 'rejected' AND embedding IS NOT NULL"
  ).all(clusterId) as { embedding: Buffer }[];
  const centroidBlob = scanRows.length > 0 ? embeddingToBlob(centroidOf(scanRows.map((r) => blobToEmbedding(r.embedding)))) : null;
  const coverFace = (db.prepare(
    "SELECT id FROM gallery_faces WHERE person_id = ? AND source = 'scan' AND thumb_storage_key IS NOT NULL ORDER BY det_score DESC LIMIT 1"
  ).get(clusterId) as { id: string } | undefined)?.id ?? null;
  db.prepare(
    "UPDATE gallery_people SET centroid = ?, face_count = ?, cover_face_id = COALESCE(?, cover_face_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(centroidBlob, faceCount, coverFace, clusterId);
}

// Cluster every not-yet-assigned auto face, then tidy up. An "auto cluster" is a
// gallery_people row with a non-NULL centroid (manual whole-photo people keep a NULL
// centroid and are never touched here).
export function clusterGalleryFaces(): { newClusters: number; assigned: number } {
  const threshold = faceThreshold();
  const existing = (db.prepare("SELECT id, centroid FROM gallery_people WHERE centroid IS NOT NULL").all() as { id: string; centroid: Buffer }[])
    .map((e) => ({ id: e.id, vec: blobToEmbedding(e.centroid) }));
  const faceRows = db.prepare(
    "SELECT id, embedding FROM gallery_faces WHERE source = 'scan' AND person_id IS NULL AND assignment != 'rejected' AND embedding IS NOT NULL ORDER BY id"
  ).all() as { id: string; embedding: Buffer }[];
  if (faceRows.length === 0) return { newClusters: 0, assigned: 0 };

  const faces = faceRows.map((r) => ({ id: r.id, embedding: blobToEmbedding(r.embedding) }));
  const created: string[] = [];
  const assignments = assignFaces(faces, existing, threshold, () => {
    const id = nanoid(16);
    created.push(id);
    return id;
  });

  const touched = new Set<string>();
  db.transaction(() => {
    for (const id of created) {
      db.prepare("INSERT INTO gallery_people (id, name, centroid) VALUES (?, '', NULL)").run(id);
    }
    const update = db.prepare("UPDATE gallery_faces SET person_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    for (const a of assignments) {
      update.run(a.clusterId, a.faceId);
      touched.add(a.clusterId);
    }
    for (const id of touched) recomputeClusterCentroid(id);

    // Re-apply user removals: reject any freshly-grouped face the user has excluded
    // from that person, then recompute those people. This is what makes a "not this
    // person" correction survive a full rescan (which re-detects every face anew).
    const violating = db.prepare(`
      SELECT gf.id AS id, gf.person_id AS person_id
      FROM gallery_faces gf
      JOIN gallery_face_exclusions ex ON ex.item_id = gf.item_id AND ex.person_id = gf.person_id
      WHERE gf.source = 'scan' AND gf.assignment != 'rejected' AND gf.person_id IS NOT NULL
    `).all() as { id: string; person_id: string }[];
    if (violating.length > 0) {
      const reject = db.prepare("UPDATE gallery_faces SET assignment = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
      const affected = new Set<string>();
      for (const v of violating) { reject.run(v.id); affected.add(v.person_id); }
      for (const id of affected) recomputeClusterCentroid(id);
    }

    // Drop unnamed auto clusters that ended up empty (e.g. after a forced rescan).
    db.prepare("DELETE FROM gallery_people WHERE name = '' AND face_count = 0 AND linked_person_id IS NULL").run();
  })();

  return { newClusters: created.length, assigned: assignments.length };
}
