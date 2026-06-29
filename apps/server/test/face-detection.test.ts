import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { detectFaces, ensureFaceEngine } from "../src/modules/library/gallery/faces/arcface.js";

// Real detection exercises the native onnxruntime backend + vendored ONNX models. That
// needs the native binary to load (it can't on, say, a platform with no prebuilt
// binding), so we probe once and no-op the assertions when the engine is unavailable
// rather than failing the whole suite in such environments.
let engineAvailable = false;

beforeAll(async () => {
  try {
    await ensureFaceEngine();
    engineAvailable = true;
  } catch (err) {
    console.warn("face engine unavailable, skipping detection test:", err instanceof Error ? err.message : err);
  }
}, 120_000);

describe("face detection (ArcFace / onnxruntime)", () => {
  it("finds faces with 512-d ArcFace embeddings and normalised boxes", async () => {
    if (!engineAvailable) return;
    const sample = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "faces-sample.jpg");

    const faces = await detectFaces(sample);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.embedding.length).toBe(512);
      // L2-normalised → unit length.
      let norm = 0; for (const v of face.embedding) norm += v * v;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 3);
      expect(face.box).toHaveLength(4);
      for (const v of face.box) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(-0.5); expect(v).toBeLessThan(1.5); }
      expect(face.score).toBeGreaterThan(0);
    }
  }, 120_000);
});
