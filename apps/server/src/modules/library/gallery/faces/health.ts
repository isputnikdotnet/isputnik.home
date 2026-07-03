// Clustering-health diagnostic: does the grouping UNDER-MERGE — i.e. is the same
// person scattered across several clusters that never merged? Every person already
// stores a centroid, so we can answer that directly from centroids (no re-embedding,
// no photo reads): compare every pair of people, and report how many sit just under
// the automatic merge line (CLUSTER_MERGE). A pile-up there is the signature of
// under-merging. We also return the strongest candidate pairs so the admin can eyeball
// "yes, that's the same person" and merge them in one click.
import { db } from "../../../../db.js";
import { blobToEmbedding } from "./embedding.js";
import { listGalleryPeople } from "../people.js";
import { CLUSTER_MERGE } from "./cluster.js";

// Pair-similarity bands, all below/at the auto-merge line. Different people score near
// 0.1–0.3 with this recogniser and the same person ≥ ~0.55, so anything ≥ POSSIBLE is
// worth a look and ≥ LIKELY is very probably one person split in two.
const LIKELY = 0.52;
const POSSIBLE = 0.45;
// "Has a likely twin": floor for counting a person as probably-duplicated.
const TWIN = 0.5;

// Hand the single Node thread back to the event loop, like the clusterer — the O(n²)
// pass over a big library runs for a few seconds and must not freeze the web UI.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ClusterHealthPerson {
  id: string;
  name: string;
  faceCount: number;
  coverUrl: string | null;
}

export interface ClusterHealthPair {
  // `a` is the suggested survivor of a merge (named, else the larger cluster); `b` is
  // the one that would be folded into it.
  a: ClusterHealthPerson;
  b: ClusterHealthPerson;
  similarity: number;
}

export interface ClusterHealth {
  mergeLine: number; // the automatic merge threshold (CLUSTER_MERGE)
  totalPeople: number; // people with a centroid that were compared
  peopleWithTwin: number; // distinct people that have another cluster ≥ TWIN
  bands: { nearCertain: number; likely: number; possible: number }; // pair counts per band
  pairs: ClusterHealthPair[]; // strongest disjoint merge suggestions, highest first
}

// Compare every pair of people-with-a-centroid within the given libraries. `maxPairs`
// caps the suggestion list only; the band counts always cover every pair.
export async function computeClusterHealth(libIds: string[], maxPairs = 60): Promise<ClusterHealth> {
  // Display metadata (name / count / avatar) from the same source the People page uses,
  // so a suggestion shows exactly the avatars the admin recognises.
  const meta = listGalleryPeople(libIds, true);
  const centroidById = new Map(
    (db.prepare("SELECT id, centroid FROM gallery_people WHERE centroid IS NOT NULL").all() as { id: string; centroid: Buffer }[])
      .map((r) => [r.id, r.centroid] as const)
  );

  // Only people that are both displayable and have a centroid. Normalise each centroid
  // up front so the inner-loop cosine is a plain dot product.
  const people = meta
    .filter((m) => centroidById.has(m.id))
    .map((m) => {
      const vec = blobToEmbedding(centroidById.get(m.id)!);
      let norm = 0;
      for (let d = 0; d < vec.length; d += 1) norm += vec[d] * vec[d];
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < vec.length; d += 1) vec[d] /= norm;
      return { id: m.id, name: m.name, faceCount: m.faceCount, coverUrl: m.coverUrl, vec };
    });

  const n = people.length;
  const bands = { nearCertain: 0, likely: 0, possible: 0 };
  const twin = new Set<string>();
  const candidates: { i: number; j: number; sim: number }[] = [];

  for (let i = 0; i < n; i += 1) {
    const a = people[i].vec;
    for (let j = i + 1; j < n; j += 1) {
      const b = people[j].vec;
      // Skip a stale centroid from a different embedding model (different dimension).
      if (a.length !== b.length || a.length === 0) continue;
      let s = 0;
      for (let d = 0; d < a.length; d += 1) s += a[d] * b[d];
      if (s < POSSIBLE) continue;
      if (s >= CLUSTER_MERGE) bands.nearCertain += 1;
      else if (s >= LIKELY) bands.likely += 1;
      else bands.possible += 1;
      if (s >= TWIN) { twin.add(people[i].id); twin.add(people[j].id); }
      candidates.push({ i, j, sim: s });
    }
    if ((i & 15) === 15) await yieldToEventLoop();
  }

  // Suggest disjoint merges: walk pairs strongest-first and take each only if neither
  // person is already spoken for, so the admin gets a clean one-per-person worklist
  // rather than a hub person repeated down the page.
  candidates.sort((x, y) => y.sim - x.sim);
  const used = new Set<string>();
  const pairs: ClusterHealthPair[] = [];
  for (const c of candidates) {
    if (pairs.length >= maxPairs) break;
    const pa = people[c.i];
    const pb = people[c.j];
    if (used.has(pa.id) || used.has(pb.id)) continue;
    used.add(pa.id);
    used.add(pb.id);
    // Survivor first: keep the named person, else the larger cluster.
    const aNamed = pa.name.trim() !== "";
    const bNamed = pb.name.trim() !== "";
    const survivorFirst = aNamed !== bNamed ? aNamed : pa.faceCount >= pb.faceCount;
    const [s1, s2] = survivorFirst ? [pa, pb] : [pb, pa];
    pairs.push({
      a: { id: s1.id, name: s1.name, faceCount: s1.faceCount, coverUrl: s1.coverUrl },
      b: { id: s2.id, name: s2.name, faceCount: s2.faceCount, coverUrl: s2.coverUrl },
      similarity: c.sim
    });
  }

  return { mergeLine: CLUSTER_MERGE, totalPeople: n, peopleWithTwin: twin.size, bands, pairs };
}
