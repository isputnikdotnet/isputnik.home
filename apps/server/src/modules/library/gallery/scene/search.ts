// The search itself (docs/scene-search-plan.md, S3): what a person typed becomes a
// vector, every described photo of the libraries they may open is scored against
// it, and the best come back in order.
//
// This file ranks; it grants nothing. It only ever looks at the libraries it is
// handed, and the ids it returns still go through the gallery's own access-checked
// queries before anything reaches a browser (scene/routes.ts).
import { db } from "../../../../db.js";
import { SCENE_DIMENSIONS, SCENE_MODEL } from "./model-id.js";
import { sceneEngine } from "./engine-client.js";
import { sceneVectorsVersion } from "./scanner.js";

// ── Where "looks like it" ends ──────────────────────────────────────────────
// Scores are cosines from SigLIP, which run low: on the benchmark's photos the
// best match for something really there scored 0.07–0.14, and the best "match"
// for something not there at all 0.03–0.06 (tried on the 319 demo photos: at a floor
// of 0.05, "a dog" found two photos though there is no dog; at 0.06 it finds none,
// but the nonsense word "asdf" still finds three. No floor is clean). So: nothing under the floor, nothing
// far below the best hit (a strong first result means the weak ones are noise),
// and never more than a screenful or two. Provisional: set from 317 demo photos,
// to be revisited against a real library.
export const SCENE_SCORE_FLOOR = 0.06;
export const SCENE_SCORE_OF_BEST = 0.6;
export const SCENE_MAX_RESULTS = 120;

export interface SceneHit {
  itemId: string;
  score: number;
}

// One library's vectors, side by side in one block: the scoring loop walks it
// without touching an object per photo.
interface LibraryVectors {
  version: number;
  ids: string[];
  values: Int8Array;
  norms: Float32Array;
}

const libraries = new Map<string, LibraryVectors>();
let idleTimer: NodeJS.Timeout | null = null;
/** A family searches in bursts: keep the vectors while they do, let go after. */
const CACHE_IDLE_MS = 10 * 60 * 1000;

function vectorsOf(libraryId: string): LibraryVectors {
  const version = sceneVectorsVersion();
  const cached = libraries.get(libraryId);
  if (cached && cached.version === version) return cached;
  const rows = db.prepare(`
    SELECT v.item_id AS id, v.vector AS vector
    FROM gallery_scene_vectors v
    JOIN library_items li ON li.id = v.item_id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND v.model = ? AND length(v.vector) = ${SCENE_DIMENSIONS}
  `).all(libraryId, SCENE_MODEL) as { id: string; vector: Buffer }[];
  const values = new Int8Array(rows.length * SCENE_DIMENSIONS);
  const norms = new Float32Array(rows.length);
  rows.forEach((row, index) => {
    const bytes = new Int8Array(row.vector.buffer, row.vector.byteOffset, SCENE_DIMENSIONS);
    values.set(bytes, index * SCENE_DIMENSIONS);
    let sum = 0;
    for (const value of bytes) sum += value * value;
    norms[index] = Math.sqrt(sum) || 1;
  });
  const loaded = { version, ids: rows.map((row) => row.id), values, norms };
  libraries.set(libraryId, loaded);
  return loaded;
}

function touchCache(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { libraries.clear(); idleTimer = null; }, CACHE_IDLE_MS);
  idleTimer.unref?.();
}

/** Forget every cached vector (tests; a library removed). */
export function clearSceneSearchCache(): void {
  libraries.clear();
  queries.clear();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// What was typed lately, as vectors: paging, a filter change or a second person
// searching the same thing should not go back to the engine.
const queries = new Map<string, Float32Array>();
const QUERY_CACHE_SIZE = 64;

async function queryVector(text: string): Promise<Float32Array> {
  const key = text.toLowerCase();
  const cached = queries.get(key);
  if (cached) {
    queries.delete(key);
    queries.set(key, cached);
    return cached;
  }
  const vector = await sceneEngine().embedText(text);
  queries.set(key, vector);
  if (queries.size > QUERY_CACHE_SIZE) queries.delete(queries.keys().next().value as string);
  return vector;
}

const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every described photo in `libraryIds` that looks like `text`, best first.
 *  Throws what the engine throws when it cannot turn the text into a vector. */
export async function rankScenes(libraryIds: readonly string[], text: string): Promise<SceneHit[]> {
  if (libraryIds.length === 0) return [];
  const query = await queryVector(text);
  touchCache();

  const hits: SceneHit[] = [];
  for (const libraryId of libraryIds) {
    const { ids, values, norms } = vectorsOf(libraryId);
    for (let index = 0; index < ids.length; index += 1) {
      const offset = index * SCENE_DIMENSIONS;
      let sum = 0;
      for (let i = 0; i < SCENE_DIMENSIONS; i += 1) sum += query[i] * values[offset + i];
      const score = sum / norms[index];
      if (score >= SCENE_SCORE_FLOOR) hits.push({ itemId: ids[index], score });
    }
    // A big library is tens of milliseconds of arithmetic: let a waiting request in.
    await yieldToOthers();
  }
  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) return hits;
  const least = hits[0].score * SCENE_SCORE_OF_BEST;
  const kept = hits.filter((hit) => hit.score >= least);
  // Twice what is shown: some may yet fall to a filter or to access.
  return kept.slice(0, SCENE_MAX_RESULTS * 2);
}
