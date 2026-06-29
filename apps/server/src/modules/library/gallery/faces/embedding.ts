// Pure helpers for storing and comparing face embeddings. Embeddings are L2-normalised
// Float32 vectors, so cosine similarity is just their dot product. No DB or ML here —
// kept dependency-free so it's trivially unit-testable.

// Float32Array → BLOB for SQLite (a copy bound synchronously by better-sqlite3).
export function embeddingToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

// BLOB → Float32Array. Copies into a fresh, 4-byte-aligned ArrayBuffer because a
// pooled Node Buffer can have an offset that isn't a multiple of 4 (which would make
// the Float32Array constructor throw).
export function blobToEmbedding(blob: Buffer): Float32Array {
  const aligned = new ArrayBuffer(blob.length);
  new Uint8Array(aligned).set(blob);
  return new Float32Array(aligned);
}

// Cosine similarity. For L2-normalised inputs this is the dot product; we normalise
// defensively anyway so it's correct for any inputs.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Mean of several embeddings, L2-normalised — a cluster centroid.
export function centroidOf(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const sum = new Float32Array(dim);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) sum[i] += vector[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) sum[i] /= norm;
  return sum;
}
