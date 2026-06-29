// Face clustering: a GLOBAL mutual-kNN grouping. Two faces are linked only when each
// is among the other's k most-similar neighbours (above a floor) — this resists the
// "hub" chaining that makes a centroid/greedy approach merge different people. The
// pure clusterer (mutualKnnClusters) is split from the DB layer so it's unit-testable.
//
// Every clustering pass rebuilds groups from scratch over all of a library's faces and
// reconciles them with existing people, so a named person keeps its identity (by
// majority face overlap) and user removals (exclusions) are re-applied.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { blobToEmbedding, embeddingToBlob, centroidOf, cosineSimilarity } from "./embedding.js";
import { faceThreshold, faceGroupingK } from "./settings.js";
import { FACE_EMBEDDING_MODEL } from "./model-id.js";

// Min centroid cosine for a rebuilt group to reclaim a named person when there's no
// face overlap (e.g. after a full rescan re-detected every face). High enough to avoid
// handing a name to a different person.
const NAME_REMATCH = 0.55;

export interface FaceVec {
  id: string;
  emb: Float32Array;
}

// Mutual k-NN connected components. Returns groups of face ids (singletons included).
// O(n²) in face count — fine for a per-library recompute (the user triggers it); a
// very large library would want an ANN index, noted for later.
export function mutualKnnClusters(faces: FaceVec[], k: number, floor: number): string[][] {
  const n = faces.length;
  if (n === 0) return [];
  const dim = faces[0].emb.length;

  // Pack L2-normalised vectors into one flat buffer so cosine is a tight dot product.
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i += 1) {
    const e = faces[i].emb;
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += e[d] * e[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) flat[i * dim + d] = e[d] / norm;
  }

  const neighbours: { j: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    const bi = i * dim;
    for (let j = i + 1; j < n; j += 1) {
      const bj = j * dim;
      let w = 0;
      for (let d = 0; d < dim; d += 1) w += flat[bi + d] * flat[bj + d];
      if (w >= floor) { neighbours[i].push({ j, w }); neighbours[j].push({ j: i, w }); }
    }
  }
  const topk = neighbours.map((list) => {
    list.sort((a, b) => b.w - a.w);
    return new Set(list.slice(0, k).map((x) => x.j));
  });

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < n; i += 1) for (const j of topk[i]) if (j > i && topk[j].has(i)) parent[find(i)] = find(j);

  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const g = groups.get(root) ?? groups.set(root, []).get(root)!;
    g.push(faces[i].id);
  }
  return [...groups.values()];
}

// Recompute a person's aggregates from its current member faces (see also the
// post-merge/untag callers). face_count counts all non-rejected faces; centroid comes
// from scan-face embeddings (NULL when none); cover is the best scan face with a crop.
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

// Reject any scan face whose (item, person) the user has excluded ("not this person"),
// and report the affected people so callers can recompute them. Makes removals durable.
function enforceExclusions(): Set<string> {
  const violating = db.prepare(`
    SELECT gf.id AS id, gf.person_id AS person_id
    FROM gallery_faces gf
    JOIN gallery_face_exclusions ex ON ex.item_id = gf.item_id AND ex.person_id = gf.person_id
    WHERE gf.source = 'scan' AND gf.assignment != 'rejected' AND gf.person_id IS NOT NULL
  `).all() as { id: string; person_id: string }[];
  const affected = new Set<string>();
  if (violating.length > 0) {
    const reject = db.prepare("UPDATE gallery_faces SET assignment = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    for (const v of violating) { reject.run(v.id); affected.add(v.person_id); }
  }
  return affected;
}

// Rebuild every person from scratch over a library's faces (or all libraries). Named
// people keep their id+name by claiming the new group that holds the plurality of
// their old faces; unnamed groups get fresh rows. Exclusions are re-applied.
export function clusterGalleryFaces(): { clusters: number; assigned: number } {
  const k = faceGroupingK();
  const floor = faceThreshold();

  // Only cluster faces from the CURRENT embedding model — never mix embedding spaces
  // (e.g. a 512-d ArcFace vector with a stale 1024-d one) which would corrupt cosine.
  const rows = db.prepare(
    "SELECT id, person_id, embedding FROM gallery_faces WHERE source = 'scan' AND assignment != 'rejected' AND embedding IS NOT NULL AND embedding_model = ?"
  ).all(FACE_EMBEDDING_MODEL) as { id: string; person_id: string | null; embedding: Buffer }[];
  if (rows.length === 0) return { clusters: 0, assigned: 0 };

  const faces: FaceVec[] = rows.map((r) => ({ id: r.id, emb: blobToEmbedding(r.embedding) }));
  const embById = new Map(faces.map((f) => [f.id, f.emb]));
  const oldPersonOf = new Map(rows.map((r) => [r.id, r.person_id]));
  // Anchored people must survive with their id + name (named or bridged to global
  // people). Keep their stored centroid for the rescan-rematch fallback.
  const anchoredRows = db.prepare("SELECT id, centroid FROM gallery_people WHERE name != '' OR linked_person_id IS NOT NULL").all() as { id: string; centroid: Buffer | null }[];
  const anchored = new Set(anchoredRows.map((r) => r.id));
  const anchoredCentroids = anchoredRows.filter((r) => r.centroid).map((r) => ({ id: r.id, vec: blobToEmbedding(r.centroid!) }));

  const groups = mutualKnnClusters(faces, k, floor).sort((a, b) => b.length - a.length);

  // Assign each group a person id (largest group first; each anchor claimed once):
  //   1. by plurality of its faces' previous anchored person (recompute case), else
  //   2. by centroid similarity to an anchored person (rescan case — faces are new),
  //   3. otherwise a fresh unnamed person.
  const takenAnchor = new Set<string>();
  const groupPlan = groups.map((faceIds) => {
    const tally = new Map<string, number>();
    for (const fid of faceIds) {
      const p = oldPersonOf.get(fid);
      if (p && anchored.has(p) && !takenAnchor.has(p)) tally.set(p, (tally.get(p) ?? 0) + 1);
    }
    let claim: string | null = null;
    let best = 0;
    for (const [p, c] of tally) if (c > best) { best = c; claim = p; }
    if (!claim && anchoredCentroids.length > 0) {
      const groupCentroid = centroidOf(faceIds.map((fid) => embById.get(fid)!).filter(Boolean));
      let bestSim = NAME_REMATCH;
      for (const a of anchoredCentroids) {
        // Skip a stale centroid from a different embedding model (different dimension).
        if (takenAnchor.has(a.id) || a.vec.length !== groupCentroid.length) continue;
        const sim = cosineSimilarity(groupCentroid, a.vec);
        if (sim >= bestSim) { bestSim = sim; claim = a.id; }
      }
    }
    if (claim) { takenAnchor.add(claim); return { faceIds, personId: claim }; }
    return { faceIds, personId: nanoid(16) };
  });

  db.transaction(() => {
    const personExists = db.prepare("SELECT 1 FROM gallery_people WHERE id = ?");
    const insertPerson = db.prepare("INSERT INTO gallery_people (id, name, centroid) VALUES (?, '', NULL)");
    const reassign = db.prepare("UPDATE gallery_faces SET person_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    const touched = new Set<string>();
    for (const plan of groupPlan) {
      if (!personExists.get(plan.personId)) insertPerson.run(plan.personId);
      for (const fid of plan.faceIds) reassign.run(plan.personId, fid);
      touched.add(plan.personId);
    }

    for (const id of enforceExclusions()) touched.add(id);
    // Recompute touched groups plus any anchored person that may have lost its faces.
    for (const id of new Set([...touched, ...anchored])) recomputeClusterCentroid(id);
    // Drop unnamed, non-anchored people that have no faces left at all (orphans from a
    // regroup, or stale clusters from a previous embedding model). Keyed on real faces,
    // not the cached face_count, so a model migration tidies up cleanly.
    db.prepare(`
      DELETE FROM gallery_people WHERE name = '' AND linked_person_id IS NULL
        AND id NOT IN (SELECT person_id FROM gallery_faces WHERE person_id IS NOT NULL AND assignment != 'rejected')
    `).run();
  })();

  return { clusters: groupPlan.length, assigned: faces.length };
}
