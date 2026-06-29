// In-process face detection + embedding via @vladmandic/human on the tfjs-node
// (native CPU) backend. Everything is lazy: the heavy native backend and the models
// load only on the first detectFaces() call, so a server that never runs a face scan
// pays nothing. Models ship inside the human npm package (blazeface + facemesh +
// faceres → a 1024-d embedding), so there is no download and nothing to vendor.
//
// Three environment quirks are handled here (see the gotchas in docs/gallery-faces):
//   1. tfjs-node@4 calls util.is* helpers removed in Node 23+ → shimmed below.
//   2. tfjs-node loads models through a file:// URL; on Windows the URL must be
//      "file://C:/..." (drive right after), not pathToFileURL's "file:///C:/...".
//   3. (Windows binding/DLL layout is fixed by scripts/fix-tfjs-node-win.mjs.)
import { createRequire } from "node:module";
import util from "node:util";
import path from "node:path";
import sharp from "sharp";

// Define the removed util.is* helpers before tfjs-node is required (no-op on Node 22).
const utilShims: Record<string, (v: unknown) => boolean> = {
  isNullOrUndefined: (v) => v == null,
  isNull: (v) => v === null,
  isUndefined: (v) => v === undefined,
  isArray: Array.isArray,
  isString: (v) => typeof v === "string",
  isNumber: (v) => typeof v === "number",
  isObject: (v) => v !== null && typeof v === "object",
  isFunction: (v) => typeof v === "function",
  isBoolean: (v) => typeof v === "boolean",
  isBuffer: Buffer.isBuffer,
  isRegExp: (v) => v instanceof RegExp,
  isDate: (v) => v instanceof Date,
  isPrimitive: (v) => v === null || (typeof v !== "object" && typeof v !== "function")
};
for (const [key, fn] of Object.entries(utilShims)) {
  const target = util as unknown as Record<string, unknown>;
  if (typeof target[key] !== "function") target[key] = fn;
}

const requireCjs = createRequire(import.meta.url);

export const FACE_EMBEDDING_MODEL = "human/faceres";

export interface DetectedFace {
  /** Bounding box as [x, y, width, height], each normalised to 0..1 of the image. */
  box: [number, number, number, number];
  /** Detector confidence, 0..1. */
  score: number;
  /** 1024-d face descriptor, L2-normalised so cosine similarity is a dot product. */
  embedding: Float32Array;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let humanPromise: Promise<any> | null = null;

function modelBaseUrl(modelsDir: string): string {
  // tfjs-node strips "file://" then treats the remainder as the path. On Windows the
  // drive must come right after (file://C:/x); pathToFileURL's file:///C:/x breaks.
  return process.platform === "win32"
    ? `file://${modelsDir.replace(/\\/g, "/")}/`
    : `file://${modelsDir}/`;
}

async function getHuman(): Promise<any> {
  if (!humanPromise) {
    humanPromise = (async () => {
      // human's package.json "exports" keys lack a leading "./", so the explicit
      // dist subpath isn't resolvable — but the bare specifier resolves via the
      // "node" export condition straight to dist/human.node.js.
      const distPath = requireCjs.resolve("@vladmandic/human");
      const modelsDir = path.join(path.dirname(distPath), "..", "models");
      const mod = requireCjs(distPath);
      const Human = mod.Human ?? mod.default ?? mod;
      const human = new Human({
        backend: "tensorflow",
        modelBasePath: modelBaseUrl(modelsDir),
        cacheSensitivity: 0,
        // Only the face detector, mesh (for alignment) and description (the embedding)
        // — everything else off, since we just want boxes + descriptors.
        face: {
          enabled: true,
          detector: { rotation: false, maxDetected: 50, minConfidence: 0.3, return: false },
          mesh: { enabled: true },
          description: { enabled: true },
          iris: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false }
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        filter: { enabled: false }
      });
      await human.load();
      return human;
    })().catch((err) => {
      humanPromise = null; // allow a later retry after a transient load failure
      throw err;
    });
  }
  return humanPromise;
}

function l2normalize(vector: number[]): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** True once the backend + models are known to load (or throws the load error). */
export async function ensureFaceEngine(): Promise<void> {
  await getHuman();
}

// Detect every face in one image and return its normalised box + embedding. Decodes
// with sharp (applying EXIF orientation) and downscales to ≤1024px for speed; boxes
// come back normalised so they map onto the upright full-size image regardless.
export async function detectFaces(absolutePath: string): Promise<DetectedFace[]> {
  const human = await getHuman();
  let tensor: any = null;
  try {
    const { data, info } = await sharp(absolutePath)
      .rotate()
      .removeAlpha()
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    tensor = human.tf.tensor(new Uint8Array(data), [1, info.height, info.width, info.channels], "int32");
    const result = await human.detect(tensor);
    const faces: DetectedFace[] = [];
    for (const face of result.face ?? []) {
      if (!Array.isArray(face.embedding) || !Array.isArray(face.boxRaw)) continue;
      faces.push({
        box: face.boxRaw as [number, number, number, number],
        score: typeof face.faceScore === "number" ? face.faceScore : (face.score ?? 0),
        embedding: l2normalize(face.embedding)
      });
    }
    return faces;
  } finally {
    if (tensor) human.tf.dispose(tensor);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
