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

// Min centroid cosine for a rebuilt group to reclaim an anchored person when there's
// no face overlap (e.g. after a full rescan re-detected every face). High enough to
// avoid handing a name to a different person.
const NAME_REMATCH = 0.55;
// Second-stage merge: after mutual-kNN, clusters whose CENTROIDS agree this strongly
// are the same person split by k-NN saturation (burst/near-duplicate photos crowd the
// top-K lists, so cross-era links never become mutual). For this recogniser different
// people centre around 0.1–0.3 and same-person groups ≥ ~0.55, so 0.58 is safe.
export const CLUSTER_MERGE = 0.58;
// A leftover 1–2-face group joins an anchored person when it's at least this close to
// the person's centroid — mops up the singleton tail without risking larger groups.
const ATTACH_SINGLETON = 0.5;
// A face must be at least this similar to its person's centroid to be eligible as the
// avatar. Real clusters carry some contamination (group-photo bystanders, the odd
// mis-merge); without this a sharp but WRONG face (high det_score, low centroid
// similarity) becomes the avatar — the reported "wrong person on the folder".
const COVER_MIN_SIM = 0.5;

export interface FaceVec {
  id: string;
  emb: Float32Array;
}

// Cooperative yield: hands the single Node thread back to the event loop so queued
// HTTP work runs, then resumes. Clustering is CPU-heavy JS (tens of seconds on a big
// library); without this it would block every request until it finished.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Mutual k-NN connected components. Returns groups of face ids (singletons included).
// O(n²) in face count. It's async and yields to the event loop periodically: on a large
// library this pass runs for tens of seconds, and it MUST NOT block the single Node
// thread the whole time or the web UI freezes (reported on Unraid). The yields don't
// change the maths — the grouping is identical to a straight synchronous run.
export async function mutualKnnClusters(faces: FaceVec[], k: number, floor: number): Promise<string[][]> {
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
    // Hand the event loop a turn often (early rows each scan ~all others, so a coarse
    // interval would still block for ~1s a time). Every 16 rows keeps the max pause
    // imperceptible; the ~n/16 setImmediate calls are negligible against the n² work.
    if ((i & 15) === 15) await yieldToEventLoop();
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

// Second clustering stage: agglomerative merge over CLUSTER centroids. Mutual-kNN
// fragments one person into per-era/per-event components when near-duplicate faces
// saturate each other's top-K lists; centroids average that noise out, so components
// of the same person score far above what two different people ever reach. Repeatedly
// merges the single closest pair (≥ threshold) and re-centres, until no pair clears it.
//
// The naive version recomputes EVERY cluster pair each round — O(g³), which was minutes
// of a frozen server on a large library (esp. with a few huge "hub" people). This keeps
// a max-heap of only the merge-CANDIDATE pairs (cosine ≥ threshold; far fewer than g²
// for real faces) with lazy invalidation by a per-cluster version stamp, so each merge
// only pushes the new cluster's pairs — no cascading rescans, hub or not. The pair
// chosen each round and the final grouping are identical to the naive version (verified
// on real libraries); cosine ties between distinct 512-d centroids don't occur.
export async function mergeClustersByCentroid(groups: string[][], embById: Map<string, Float32Array>, threshold: number): Promise<string[][]> {
  const centre = (ids: string[]) => centroidOf(ids.map((id) => embById.get(id)!).filter(Boolean));
  const g = groups.length;
  const ids = groups.map((grp) => grp.slice());
  const centroids = groups.map((grp) => centre(grp));
  const alive = new Array(g).fill(true);
  const version = new Int32Array(g); // bumped when a cluster changes, to stale old heap entries

  const sim = (a: number, b: number): number =>
    centroids[a].length === centroids[b].length && centroids[a].length > 0
      ? cosineSimilarity(centroids[a], centroids[b]) : -Infinity;

  // Binary max-heap of candidate pairs [sim, a, b, versionA, versionB].
  type Entry = [number, number, number, number, number];
  const heap: Entry[] = [];
  const swap = (i: number, j: number) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; swap(i, p); i = p; } };
  const down = (i: number) => {
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1; const r = 2 * i + 2; let m = i;
      if (l < n && heap[l][0] > heap[m][0]) m = l;
      if (r < n && heap[r][0] > heap[m][0]) m = r;
      if (m === i) break;
      swap(i, m); i = m;
    }
  };
  const pushPair = (a: number, b: number) => {
    const s = sim(a, b);
    if (s >= threshold) { heap.push([s, a, b, version[a], version[b]]); up(heap.length - 1); }
  };

  // Seed with every current candidate pair. O(g²) cosines, yielded so it never freezes.
  for (let i = 0; i < g; i += 1) {
    if (!alive[i]) continue;
    for (let j = i + 1; j < g; j += 1) if (alive[j]) pushPair(i, j);
    if ((i & 15) === 15) await yieldToEventLoop();
  }

  let sinceYield = 0;
  while (heap.length > 0) {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) { heap[0] = last; down(0); }
    const [, a, b, va, vb] = top;
    // Skip a pair whose endpoints have since merged away or changed.
    if (!alive[a] || !alive[b] || version[a] !== va || version[b] !== vb) continue;

    // Valid global-closest pair (≥ threshold): merge b into a and re-centre.
    ids[a] = [...ids[a], ...ids[b]];
    centroids[a] = centre(ids[a]);
    alive[b] = false;
    version[a] += 1;
    for (let x = 0; x < g; x += 1) if (x !== a && alive[x]) pushPair(a, x);
    if ((sinceYield += 1) >= 64) { sinceYield = 0; await yieldToEventLoop(); }
  }

  const out: string[][] = [];
  for (let i = 0; i < g; i += 1) if (alive[i]) out.push(ids[i]);
  return out;
}

// Recompute a person's aggregates from its current member faces (see also the
// post-merge/untag callers). face_count counts all non-rejected faces; centroid comes
// from scan-face embeddings (NULL when none); cover is the best non-rejected scan face
// with a crop on a live (non-trashed) photo — NULL when none qualifies, so a rejected
// or stale cover clears instead of sticking as the person's avatar. cover_face_id is
// the person's GLOBAL canonical avatar; the People list picks its own per-viewer crop
// from accessible libraries only (same det_score ordering), so nothing leaks across
// library access.
export function recomputeClusterCentroid(clusterId: string): void {
  const faceCount = (db.prepare(
    "SELECT COUNT(DISTINCT gf.item_id) n FROM gallery_faces gf JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL WHERE gf.person_id = ? AND gf.assignment != 'rejected'"
  ).get(clusterId) as { n: number }).n;
  // Load the person's scan faces once: embeddings drive the centroid; det_score, crop
  // and photo-liveness drive the avatar pick below.
  const rows = db.prepare(`
    SELECT gf.id AS id, gf.det_score AS det, gf.embedding AS embedding, gf.thumb_storage_key AS thumb,
      (li.id IS NOT NULL) AS live
    FROM gallery_faces gf
    LEFT JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL
    WHERE gf.person_id = ? AND gf.source = 'scan' AND gf.assignment != 'rejected' AND gf.embedding IS NOT NULL
  `).all(clusterId) as { id: string; det: number; embedding: Buffer; thumb: string | null; live: number }[];
  const embeddings = rows.map((r) => blobToEmbedding(r.embedding));
  const centroid = embeddings.length > 0 ? centroidOf(embeddings) : null;
  const centroidBlob = centroid ? embeddingToBlob(centroid) : null;

  // Avatar: the CLEAREST face (highest det_score) that is genuinely representative of the
  // person — cosine to the centroid ≥ COVER_MIN_SIM — so a sharp but mis-clustered face
  // can't hijack it. Only faces on a live photo with a crop qualify. If none clear the
  // bar (a tiny/degenerate cluster), fall back to the single most-central such face.
  let coverFace: string | null = null;
  if (centroid) {
    const eligible = rows
      .map((r, i) => ({ id: r.id, det: r.det, thumb: r.thumb, live: r.live, sim: cosineSimilarity(embeddings[i], centroid) }))
      .filter((r) => r.live && r.thumb);
    const representative = eligible.filter((r) => r.sim >= COVER_MIN_SIM);
    if (representative.length > 0) coverFace = representative.reduce((a, b) => (b.det > a.det ? b : a)).id;
    else if (eligible.length > 0) coverFace = eligible.reduce((a, b) => (b.sim > a.sim ? b : a)).id;
  }
  db.prepare(
    "UPDATE gallery_people SET centroid = ?, face_count = ?, cover_face_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
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
export async function clusterGalleryFaces(): Promise<{ clusters: number; assigned: number }> {
  const k = faceGroupingK();
  const floor = faceThreshold();

  // Prune unnamed people that have no faces left — leftovers from earlier scans/regroups
  // or a previous embedding model. Runs unconditionally so junk can't accumulate.
  const pruneEmpty = () => db.prepare(`
    DELETE FROM gallery_people WHERE name = '' AND linked_person_id IS NULL
      AND id NOT IN (SELECT person_id FROM gallery_faces WHERE person_id IS NOT NULL AND assignment != 'rejected')
  `).run();

  // Only cluster faces from the CURRENT embedding model — never mix embedding spaces
  // (e.g. a 512-d ArcFace vector with a stale 1024-d one) which would corrupt cosine.
  const rows = db.prepare(
    "SELECT id, person_id, embedding FROM gallery_faces WHERE source = 'scan' AND assignment != 'rejected' AND embedding IS NOT NULL AND embedding_model = ?"
  ).all(FACE_EMBEDDING_MODEL) as { id: string; person_id: string | null; embedding: Buffer }[];
  if (rows.length === 0) {
    pruneEmpty();
    return { clusters: 0, assigned: 0 };
  }

  const faces: FaceVec[] = rows.map((r) => ({ id: r.id, emb: blobToEmbedding(r.embedding) }));
  const embById = new Map(faces.map((f) => [f.id, f.emb]));
  const oldPersonOf = new Map(rows.map((r) => [r.id, r.person_id]));
  // Anchored people must survive with their id + name: named, bridged to global
  // people, or curated (a user merge target). Keep their stored centroid for the
  // rescan-rematch fallback.
  const anchoredRows = db.prepare(
    "SELECT id, centroid FROM gallery_people WHERE name != '' OR linked_person_id IS NOT NULL OR curated = 1"
  ).all() as { id: string; centroid: Buffer | null }[];
  const anchored = new Set(anchoredRows.map((r) => r.id));
  const anchoredCentroids = anchoredRows.filter((r) => r.centroid).map((r) => ({ id: r.id, vec: blobToEmbedding(r.centroid!) }));

  const groups = (await mergeClustersByCentroid(await mutualKnnClusters(faces, k, floor), embById, CLUSTER_MERGE))
    .sort((a, b) => b.length - a.length);

  // Assign each group a person id. Several groups may map to the SAME anchored person —
  // they re-union into it, which is what makes manual merges durable across reclustering:
  //   1. by plurality of its faces' previous anchored person (recompute case), else
  //   2. by centroid similarity to an anchored person (rescan case — faces are new;
  //      1–2-face leftovers use the lower ATTACH_SINGLETON bar to mop up the tail),
  //   3. otherwise a fresh unnamed person.
  const groupPlan = groups.map((faceIds) => {
    const tally = new Map<string, number>();
    for (const fid of faceIds) {
      const p = oldPersonOf.get(fid);
      if (p && anchored.has(p)) tally.set(p, (tally.get(p) ?? 0) + 1);
    }
    let claim: string | null = null;
    let best = 0;
    for (const [p, c] of tally) if (c > best) { best = c; claim = p; }
    if (!claim && anchoredCentroids.length > 0) {
      const groupCentroid = centroidOf(faceIds.map((fid) => embById.get(fid)!).filter(Boolean));
      let bestSim = faceIds.length <= 2 ? ATTACH_SINGLETON : NAME_REMATCH;
      for (const a of anchoredCentroids) {
        // Skip a stale centroid from a different embedding model (different dimension).
        if (a.vec.length !== groupCentroid.length) continue;
        const sim = cosineSimilarity(groupCentroid, a.vec);
        if (sim >= bestSim) { bestSim = sim; claim = a.id; }
      }
    }
    return { faceIds, personId: claim ?? nanoid(16) };
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
    // regroup, or stale clusters from a previous embedding model).
    pruneEmpty();
  })();

  return { clusters: groupPlan.length, assigned: faces.length };
}
