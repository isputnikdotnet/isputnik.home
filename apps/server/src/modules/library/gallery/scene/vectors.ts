// How a scene vector is kept: one signed byte per number, the vector scaled so
// its own largest value becomes ±127. A quarter of the size of 32-bit floats on
// disk and in the search cache, where it matters: every vector of every visible
// library is compared on each search.
//
// Measured on the benchmark's photos (isputnik.faces bench/scene/storage-check.ts):
// a search over these returns 97.7% of the same top 20 as over the full vectors,
// with no score off by more than 0.003. Scaling every vector by one fixed factor
// instead kept only 94%: one number in each vector is far larger than the rest,
// and a fixed scale spends most of its range on nothing.
//
// The scale is not stored. A stored vector's length is recomputed when it is
// loaded, and a score is the dot product divided by that length: the cosine, as
// with the originals.

export interface StoredVector {
  values: Int8Array;
  /** The stored vector's own length, so a dot product can be made a cosine. */
  norm: number;
}

/** A unit vector from the engine, as the bytes to store. */
export function encodeSceneVector(vector: Float32Array): Buffer {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const bytes = new Int8Array(vector.length);
  if (max > 0) {
    for (let i = 0; i < vector.length; i += 1) bytes[i] = Math.round((vector[i] / max) * 127);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Stored bytes, ready to score against. A copy: the row's buffer is not kept alive. */
export function decodeSceneVector(blob: Buffer): StoredVector {
  const values = new Int8Array(blob.byteLength);
  values.set(new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength));
  let sum = 0;
  for (const value of values) sum += value * value;
  return { values, norm: Math.sqrt(sum) || 1 };
}

/** How well a photo fits what was typed: the cosine of the two, -1..1. `query`
 *  is the engine's unit vector for the text. */
export function sceneScore(query: Float32Array, stored: StoredVector): number {
  const { values } = stored;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += query[i] * values[i];
  return sum / stored.norm;
}
