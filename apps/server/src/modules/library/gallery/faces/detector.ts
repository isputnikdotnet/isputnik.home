// Where faces are found: the face engine container when one is paired
// (docs/face-engine-plan.md), else the models in this process when the ONNX
// runtime is installed (a source checkout; the image until H2), else nowhere —
// and a scan says so before it starts rather than failing photo by photo.
//
// The scanner asks one function and gets one shape back, crops included, so the
// loop that writes faces has no idea which did the work.
import fs from "node:fs";
import path from "node:path";
import { resolveAppSecret } from "../../../apps/pairing.js";
import { FACE_EMBEDDING_MODEL } from "./model-id.js";
import { FaceEngineError, faceEngineClient, type FaceEngineClient, type FaceEngineHealth } from "./engine-client.js";
import { decodePhotoToJpeg } from "../media.js";
import type { DetectedFace } from "./arcface.js";

export interface FoundFace extends DetectedFace {
  /** The 160 px WebP avatar for this face, or null when none could be made. */
  crop: Buffer | null;
}

/** Which of the two did the work, for the log and the settings page. */
export type DetectorKind = "container" | "in-process";

export interface FaceEngineStatus {
  where: DetectorKind | "none";
  /** The container's version when it answers; null otherwise. */
  version: string | null;
  model: string | null;
  gpu: boolean | null;
  /** Why no faces can be found right now, in words the settings page shows. */
  reason: string | null;
}

/** Thrown for a photo the detector could not read; the scanner records it as a failed attempt. */
export class UndecodableError extends Error {}

/** Thrown when no detector is available at all; the scan stops rather than failing every photo. */
export class NoDetectorError extends Error {}

/** What sharp's media types are called on the wire, by extension. */
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".gif": "image/gif", ".avif": "image/avif"
};

export interface DetectorOptions {
  /** Where the engine is; the install's pairing by default. Tests point at a stand-in. */
  target?: () => { upstream: string; secret: string };
  fetch?: typeof fetch;
  /** The in-process path, or null when the runtime is not to be tried (tests). */
  inProcess?: InProcess | null;
}

/** The in-process detector, loaded on first use so nothing here imports onnxruntime. */
interface InProcess {
  available(): Promise<boolean>;
  detect(absolutePath: string): Promise<FoundFace[]>;
}

async function loadInProcess(): Promise<InProcess> {
  // Both lazy: arcface.ts itself imports the runtime only when a model is loaded.
  const [arcface, thumbnails] = await Promise.all([import("./arcface.js"), import("./thumbnails.js")]);
  return {
    async available() {
      try {
        await arcface.ensureFaceEngine();
        return true;
      } catch {
        return false;
      }
    },
    async detect(absolutePath) {
      const image = await arcface.decodeUpright(absolutePath);
      const faces = await arcface.detectFacesFromRaw(image);
      const found: FoundFace[] = [];
      for (const face of faces) found.push({ ...face, crop: await thumbnails.cropFaceToBuffer(image, face.box) });
      return found;
    }
  };
}

export interface FaceDetector {
  /** How faces would be found right now, and why not. Probes the container. */
  status(): Promise<FaceEngineStatus>;
  /** Refuses with NoDetectorError when nothing can find faces. Called once per scan. */
  ensure(): Promise<DetectorKind>;
  /** The faces in one photo on disk, with their crops. */
  detect(absolutePath: string): Promise<FoundFace[]>;
  /** The container's client, for the settings page's probe. */
  readonly engine: FaceEngineClient;
}

export function createFaceDetector(options: DetectorOptions = {}): FaceDetector {
  const target = options.target ?? (() => {
    const resolved = resolveAppSecret("faces");
    return { upstream: resolved.upstream, secret: resolved.secret };
  });
  const engine = faceEngineClient(target, options.fetch);
  let inProcessPromise: Promise<InProcess | null> | null = null;
  const inProcess = () => {
    inProcessPromise ??= options.inProcess === undefined ? loadInProcess() : Promise.resolve(options.inProcess);
    return inProcessPromise;
  };

  /** Which path to use for this call: the container when paired, else in-process. */
  const choose = async (): Promise<DetectorKind | null> => {
    if (engine.configured()) return "container";
    const local = await inProcess();
    return local && await local.available() ? "in-process" : null;
  };

  const containerProblem = (health: FaceEngineHealth): string | null => {
    if (!health.ok) return "The face engine answered, but says it is not well.";
    if (!health.modelsPresent) return "The face engine has no models: it needs a rebuilt image, or the recogniser fetched.";
    if (health.model && health.model !== FACE_EMBEDDING_MODEL) {
      return `The face engine runs a different model (${health.model}) than this server's faces were made with (${FACE_EMBEDDING_MODEL}); faces found by it could not be grouped with the rest.`;
    }
    return null;
  };

  return {
    engine,
    async status() {
      if (engine.configured()) {
        try {
          const health = await engine.health();
          const reason = containerProblem(health);
          return { where: reason ? "none" : "container", version: health.version, model: health.model, gpu: health.gpu, reason };
        } catch (err) {
          return { where: "none", version: null, model: null, gpu: null, reason: err instanceof Error ? err.message : String(err) };
        }
      }
      const local = await inProcess();
      if (local && await local.available()) return { where: "in-process", version: null, model: FACE_EMBEDDING_MODEL, gpu: null, reason: null };
      return { where: "none", version: null, model: null, gpu: null, reason: "Face recognition needs the isputnik.faces container: pair it on Control panel → Settings › Apps." };
    },
    async ensure() {
      const kind = await choose();
      if (!kind) throw new NoDetectorError("Face recognition needs the isputnik.faces container: pair it on Control panel → Settings › Apps.");
      if (kind === "container") {
        let health: FaceEngineHealth;
        try {
          health = await engine.health();
        } catch (err) {
          throw new NoDetectorError(err instanceof Error ? err.message : String(err));
        }
        const problem = containerProblem(health);
        if (problem) throw new NoDetectorError(problem);
      }
      return kind;
    },
    async detect(absolutePath) {
      const kind = await choose();
      if (!kind) throw new NoDetectorError("No face engine is available.");
      if (kind === "in-process") {
        const local = (await inProcess())!;
        return local.detect(absolutePath);
      }
      // The original bytes for what sharp opens; anything else (BMP, HEIC) goes
      // through the same ffmpeg fallback the thumbnailer uses, as a JPEG.
      const extension = path.extname(absolutePath).toLowerCase();
      let bytes: Buffer;
      let type = TYPES[extension];
      if (type) {
        bytes = await fs.promises.readFile(absolutePath);
      } else {
        const converted = await decodePhotoToJpeg(absolutePath);
        if (!converted) throw new UndecodableError(`Could not decode ${path.basename(absolutePath)}.`);
        bytes = converted;
        type = "image/jpeg";
      }
      try {
        const answer = await engine.detect(bytes, type);
        return answer.faces;
      } catch (err) {
        if (err instanceof FaceEngineError && err.kind === "undecodable") {
          // The container's sharp could not open it (a JPEG in name only): one
          // more try through ffmpeg before giving it up.
          if (type !== "image/jpeg" || extension === ".jpg" || extension === ".jpeg") {
            const converted = await decodePhotoToJpeg(absolutePath).catch(() => null);
            if (converted) {
              try {
                return (await engine.detect(converted, "image/jpeg")).faces;
              } catch (again) {
                if (again instanceof FaceEngineError && again.kind === "undecodable") throw new UndecodableError(again.message);
                throw again;
              }
            }
          }
          throw new UndecodableError(err.message);
        }
        throw err;
      }
    }
  };
}

let shared: FaceDetector | null = null;

/** The detector the scanner and the settings page share. */
export function faceDetector(): FaceDetector {
  shared ??= createFaceDetector();
  return shared;
}

/** Tests put a stand-in in place; null restores the real one. */
export function setFaceDetector(detector: FaceDetector | null): void {
  shared = detector;
}
