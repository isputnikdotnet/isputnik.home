// In-process face detection + embedding using InsightFace "buffalo_s" ONNX models on
// onnxruntime-node (native CPU): SCRFD detector → 5-point alignment (similarity warp to
// 112×112) → ArcFace MobileFaceNet → 512-d embedding. ArcFace's accuracy lives in the
// alignment, so the warp is essential. Everything is lazy: the models load on the first
// detectFaces() call, so a server that never runs a face scan pays nothing.
//
// Models are vendored at apps/server/models/face/ (det_500m.onnx, w600k_mbf.onnx) and
// loaded from there — no download, nothing leaves the machine.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { FACE_EMBEDDING_MODEL } from "./model-id.js";

export { FACE_EMBEDDING_MODEL };

export interface DetectedFace {
  /** [x, y, width, height], normalised 0..1 of the image. */
  box: [number, number, number, number];
  score: number;
  /** 512-d ArcFace descriptor, L2-normalised (cosine = dot product). */
  embedding: Float32Array;
}

// ArcFace canonical 5-point template for a 112×112 aligned face.
const ARC_TEMPLATE: [number, number][] = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.3655]
];
const DET_SIZE = 640;
// Cap the working image: a face that survives the size gate is still ≥~90px here, plenty
// for the 112-px ArcFace crop, and capping makes the decode (shrink-on-load) much faster.
const WORK_MAX = 2048;
const SCRFD_STRIDES = [
  { s: 8, score: "443", bbox: "446", kps: "449" },
  { s: 16, score: "468", bbox: "471", kps: "474" },
  { s: 32, score: "493", bbox: "496", kps: "499" }
];

function modelsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "apps/server/models/face"), // dev (repo root) + Docker (/app)
    path.resolve(process.cwd(), "models/face"),             // cwd = apps/server
    path.resolve(process.cwd(), "../models/face")
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, "w600k_mbf.onnx"))) ?? candidates[0];
}

let enginePromise: Promise<{ det: ort.InferenceSession; rec: ort.InferenceSession }> | null = null;
function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const dir = modelsDir();
      const [det, rec] = await Promise.all([
        ort.InferenceSession.create(path.join(dir, "det_500m.onnx")),
        ort.InferenceSession.create(path.join(dir, "w600k_mbf.onnx"))
      ]);
      return { det, rec };
    })().catch((err) => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

export async function ensureFaceEngine(): Promise<void> { await getEngine(); }

// Least-squares similarity transform mapping the 5 detected keypoints onto the ArcFace
// template: returns the forward affine [[a,-b,tx],[b,a,ty]].
function similarityTransform(src: [number, number][]) {
  const ATA = Array.from({ length: 4 }, () => new Float64Array(4));
  const ATc = new Float64Array(4);
  for (let i = 0; i < 5; i += 1) {
    const [x, y] = src[i];
    const [X, Y] = ARC_TEMPLATE[i];
    const r1 = [x, -y, 1, 0];
    const r2 = [y, x, 0, 1];
    for (let u = 0; u < 4; u += 1) {
      for (let v = 0; v < 4; v += 1) ATA[u][v] += r1[u] * r1[v] + r2[u] * r2[v];
      ATc[u] += r1[u] * X + r2[u] * Y;
    }
  }
  const M = ATA.map((row, i) => [...row, ATc[i]]);
  for (let c = 0; c < 4; c += 1) {
    let piv = c;
    for (let r = c + 1; r < 4; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 4; r += 1) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= 4; k += 1) M[r][k] -= f * M[c][k]; }
  }
  return { a: M[0][4] / M[0][0], b: M[1][4] / M[1][1], tx: M[2][4] / M[2][2], ty: M[3][4] / M[3][3] };
}

// Inverse-warp the full-image RGB into an aligned 112×112 ArcFace input tensor.
function warpToArcInput(rgb: Buffer | Uint8Array, W: number, H: number, t: { a: number; b: number; tx: number; ty: number }): Float32Array {
  const det = t.a * t.a + t.b * t.b;
  const ai = t.a / det;
  const bi = t.b / det;
  const tix = -(ai * t.tx + bi * t.ty);
  const tiy = -(-bi * t.tx + ai * t.ty);
  const inp = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let Y = 0; Y < 112; Y += 1) {
    for (let X = 0; X < 112; X += 1) {
      const sx = ai * X + bi * Y + tix;
      const sy = -bi * X + ai * Y + tiy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      let r = 0, g = 0, b = 0;
      if (x0 >= 0 && y0 >= 0 && x0 < W - 1 && y0 < H - 1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * W + x0) * 3, i10 = (y0 * W + x0 + 1) * 3, i01 = ((y0 + 1) * W + x0) * 3, i11 = ((y0 + 1) * W + x0 + 1) * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r = rgb[i00] * w00 + rgb[i10] * w10 + rgb[i01] * w01 + rgb[i11] * w11;
        g = rgb[i00 + 1] * w00 + rgb[i10 + 1] * w10 + rgb[i01 + 1] * w01 + rgb[i11 + 1] * w11;
        b = rgb[i00 + 2] * w00 + rgb[i10 + 2] * w10 + rgb[i01 + 2] * w01 + rgb[i11 + 2] * w11;
      }
      const pi = Y * 112 + X;
      inp[pi] = (r - 127.5) / 127.5;
      inp[plane + pi] = (g - 127.5) / 127.5;
      inp[2 * plane + pi] = (b - 127.5) / 127.5;
    }
  }
  return inp;
}

interface Detection { box: [number, number, number, number]; kps: [number, number][]; score: number }

function decodeScrfd(out: ort.InferenceSession.OnnxValueMapType, scale: number, threshold: number): Detection[] {
  const dets: Detection[] = [];
  for (const { s, score, bbox, kps } of SCRFD_STRIDES) {
    const sc = out[score].data as Float32Array;
    const bb = out[bbox].data as Float32Array;
    const kp = out[kps].data as Float32Array;
    const fw = Math.ceil(DET_SIZE / s);
    const fh = Math.ceil(DET_SIZE / s);
    const na = 2;
    for (let y = 0; y < fh; y += 1) {
      for (let x = 0; x < fw; x += 1) {
        for (let a = 0; a < na; a += 1) {
          const idx = (y * fw + x) * na + a;
          if (sc[idx] < threshold) continue;
          const cx = x * s, cy = y * s;
          const box: [number, number, number, number] = [
            (cx - bb[idx * 4] * s) / scale, (cy - bb[idx * 4 + 1] * s) / scale,
            (cx + bb[idx * 4 + 2] * s) / scale, (cy + bb[idx * 4 + 3] * s) / scale
          ];
          const pts: [number, number][] = [];
          for (let k = 0; k < 5; k += 1) pts.push([(cx + kp[idx * 10 + 2 * k] * s) / scale, (cy + kp[idx * 10 + 2 * k + 1] * s) / scale]);
          dets.push({ box, kps: pts, score: sc[idx] });
        }
      }
    }
  }
  // Greedy NMS.
  dets.sort((p, q) => q.score - p.score);
  const iou = (A: number[], B: number[]) => {
    const xx1 = Math.max(A[0], B[0]), yy1 = Math.max(A[1], B[1]), xx2 = Math.min(A[2], B[2]), yy2 = Math.min(A[3], B[3]);
    const inter = Math.max(0, xx2 - xx1) * Math.max(0, yy2 - yy1);
    return inter / ((A[2] - A[0]) * (A[3] - A[1]) + (B[2] - B[0]) * (B[3] - B[1]) - inter);
  };
  const keep: Detection[] = [];
  for (const d of dets) if (keep.every((k) => iou(k.box, d.box) < 0.4)) keep.push(d);
  return keep;
}

function l2(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

// One decoded, EXIF-upright, size-capped image. Decode it ONCE per photo and reuse it
// for detection and every face crop — re-decoding per face was the scan bottleneck.
export interface DecodedImage { rgb: Buffer; width: number; height: number }

export async function decodeUpright(absolutePath: string): Promise<DecodedImage> {
  const { data, info } = await sharp(absolutePath).rotate()
    .resize(WORK_MAX, WORK_MAX, { fit: "inside", withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

// Detect every face in a pre-decoded image and return its normalised box + aligned
// ArcFace embedding. The detector input is resized from the already-decoded raw buffer
// (no second file decode), and the alignment warp samples that same buffer.
export async function detectFacesFromRaw(image: DecodedImage): Promise<DetectedFace[]> {
  const { det, rec } = await getEngine();
  const { rgb, width: W, height: H } = image;
  if (!W || !H) return [];

  const scale = Math.min(DET_SIZE / W, DET_SIZE / H);
  const rw = Math.round(W * scale);
  const rh = Math.round(H * scale);
  const { data: pad } = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(rw, rh, { fit: "fill" })
    .extend({ top: 0, left: 0, bottom: DET_SIZE - rh, right: DET_SIZE - rw, background: { r: 0, g: 0, b: 0 } })
    .raw().toBuffer({ resolveWithObject: true });

  const inp = new Float32Array(3 * DET_SIZE * DET_SIZE);
  const dplane = DET_SIZE * DET_SIZE;
  for (let i = 0; i < dplane; i += 1) {
    inp[i] = (pad[i * 3] - 127.5) / 128;
    inp[dplane + i] = (pad[i * 3 + 1] - 127.5) / 128;
    inp[2 * dplane + i] = (pad[i * 3 + 2] - 127.5) / 128;
  }
  const detOut = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, DET_SIZE, DET_SIZE]) });
  const dets = decodeScrfd(detOut, scale, 0.5);

  const faces: DetectedFace[] = [];
  for (const d of dets) {
    const aligned = warpToArcInput(rgb, W, H, similarityTransform(d.kps));
    const recOut = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", aligned, [1, 3, 112, 112]) });
    const embedding = l2(Float32Array.from(recOut[rec.outputNames[0]].data as Float32Array));
    const [x1, y1, x2, y2] = d.box;
    faces.push({
      box: [Math.max(0, x1 / W), Math.max(0, y1 / H), Math.max(0, (x2 - x1) / W), Math.max(0, (y2 - y1) / H)],
      score: d.score,
      embedding
    });
  }
  return faces;
}

// Convenience: decode + detect in one call (used by the test and any one-off caller).
// The scanner decodes once itself and shares the buffer with the thumbnail crops.
export async function detectFaces(absolutePath: string): Promise<DetectedFace[]> {
  return detectFacesFromRaw(await decodeUpright(absolutePath));
}
