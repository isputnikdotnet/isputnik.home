import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { detectFaces, ensureFaceEngine } from "../src/modules/library/gallery/faces/human-session.js";

const requireCjs = createRequire(import.meta.url);

// Real face detection exercises the native tfjs-node backend + bundled models. That
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

describe("face detection (native engine)", () => {
  it("finds faces with 1024-d embeddings and normalised boxes in a real photo", async () => {
    if (!engineAvailable) return;
    // human ships a montage of real faces under assets/samples.jpg.
    const distPath = requireCjs.resolve("@vladmandic/human");
    const sample = path.join(path.dirname(distPath), "..", "assets", "samples.jpg");

    const faces = await detectFaces(sample);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.embedding.length).toBe(1024);
      expect(face.box).toHaveLength(4);
      // Normalised, but a face at the very edge can have a box slightly outside [0,1].
      for (const v of face.box) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(-0.5); expect(v).toBeLessThan(1.5); }
      expect(face.score).toBeGreaterThan(0);
    }
  }, 120_000);
});
