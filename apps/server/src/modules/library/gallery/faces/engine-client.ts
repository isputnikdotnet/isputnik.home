// This server's calls to the face engine (isputnik.faces, docs/face-engine-plan.md):
// a photo's bytes go out, its faces come back — boxes, vectors and a crop each —
// and the engine keeps nothing. Signed like any gateway request, in the system
// identity, since a scan runs in the background in nobody's name.
import type { User } from "../../../../db.js";
import { identityHeaders } from "../../../apps/gateway.js";
import { appConfigured, appDefinition } from "../../../apps/registry.js";
import type { DetectedFace } from "./arcface.js";

const FACES = appDefinition("faces");

/** A photo straight off a camera takes about a second; the first one of a cold
 *  engine loads the models first. Long enough for a big one on a slow box. */
const DETECT_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The identity background calls go out with: an admin, by role. */
const SYSTEM_ACTOR = {
  id: "system:home",
  display_name: "isputnik.home",
  role: "admin",
  language: "en",
  theme: "system"
} as unknown as User;

export class FaceEngineError extends Error {
  constructor(message: string, readonly status: number, readonly kind: "unavailable" | "undecodable" | "refused" | "other") {
    super(message);
  }
}

export interface FaceEngineTarget {
  upstream: string;
  secret: string;
}

/** What the engine says about itself (GET /faces/api/health). */
export interface FaceEngineHealth {
  ok: boolean;
  version: string | null;
  model: string | null;
  modelsPresent: boolean;
  loaded: boolean;
  providers: string[] | null;
  gpu: boolean | null;
}

interface DetectWire {
  model: string;
  width: number;
  height: number;
  faces: { box: [number, number, number, number]; score: number; embedding: string; crop: string | null }[];
}

export interface RemoteDetection {
  model: string;
  width: number;
  height: number;
  faces: (DetectedFace & { crop: Buffer | null })[];
}

export interface FaceEngineClient {
  /** Whether an address and a secret are set — not whether it answers. */
  configured(): boolean;
  health(): Promise<FaceEngineHealth>;
  /** The faces in one photo. `type` is the bytes' media type (image/jpeg, …). */
  detect(bytes: Buffer, type: string, options?: { crops?: boolean }): Promise<RemoteDetection>;
}

const fetchImpl: typeof fetch = (...args) => fetch(...args);

/** A client for whichever engine `target` names when a call is made, so a secret
 *  paired on Settings › Apps is used at once. Tests hand in their own fetch. */
export function faceEngineClient(target: () => FaceEngineTarget, doFetch: typeof fetch = fetchImpl): FaceEngineClient {
  const base = () => {
    const { upstream, secret } = target();
    const configured = appConfigured(FACES, upstream, secret);
    if (!configured.enabled) throw new FaceEngineError(configured.reason ?? "The face engine is not set up.", 503, "unavailable");
    return { upstream, secret };
  };
  const headers = (secret: string) => identityHeaders(SYSTEM_ACTOR, secret, { ip: "127.0.0.1", requestId: `home-${Date.now().toString(36)}` });
  return {
    configured() {
      const { upstream, secret } = target();
      return appConfigured(FACES, upstream, secret).enabled;
    },
    async health() {
      const { upstream } = base();
      let response: Response;
      try {
        response = await doFetch(`${upstream}${FACES.prefix}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      } catch (err) {
        throw new FaceEngineError(`The face engine did not answer (${err instanceof Error ? err.message : String(err)}).`, 502, "unavailable");
      }
      if (!response.ok) throw new FaceEngineError(`The face engine answered ${response.status}.`, 502, "unavailable");
      const body = (await response.json().catch(() => ({}))) as Partial<FaceEngineHealth>;
      return {
        ok: body.ok === true,
        version: body.version ?? null,
        model: body.model ?? null,
        modelsPresent: body.modelsPresent === true,
        loaded: body.loaded === true,
        providers: Array.isArray(body.providers) ? body.providers : null,
        gpu: typeof body.gpu === "boolean" ? body.gpu : null
      };
    },
    async detect(bytes, type, options = {}) {
      const { upstream, secret } = base();
      let response: Response;
      try {
        response = await doFetch(`${upstream}${FACES.prefix}/api/detect${options.crops === false ? "?crops=0" : ""}`, {
          method: "POST",
          headers: { ...headers(secret), "content-type": type },
          // A copy with its own ArrayBuffer: a Buffer's slice of the pool is
          // not what fetch's BodyInit types accept.
          body: new Blob([new Uint8Array(bytes)], { type }),
          signal: AbortSignal.timeout(DETECT_TIMEOUT_MS)
        });
      } catch (err) {
        throw new FaceEngineError(`The face engine did not answer (${err instanceof Error ? err.message : String(err)}).`, 502, "unavailable");
      }
      if (response.status === 401) throw new FaceEngineError("The face engine refused this server's secret. Check Settings › Apps.", 502, "refused");
      const payload = (await response.json().catch(() => ({}))) as Partial<DetectWire> & { error?: string };
      if (response.status === 415 || response.status === 422) {
        throw new FaceEngineError(payload.error ?? `The face engine could not read the photo (${response.status}).`, 422, "undecodable");
      }
      if (response.status === 503) throw new FaceEngineError(payload.error ?? "The face engine has no models.", 503, "unavailable");
      if (!response.ok || !Array.isArray(payload.faces)) {
        throw new FaceEngineError(payload.error ?? `The face engine answered ${response.status}.`, 502, "other");
      }
      return {
        model: payload.model ?? "",
        width: payload.width ?? 0,
        height: payload.height ?? 0,
        faces: payload.faces.map((face) => {
          const raw = Buffer.from(face.embedding, "base64");
          // A copy: a Float32Array over a Buffer slice would alias the pool.
          const embedding = new Float32Array(raw.byteLength / 4);
          embedding.set(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
          return { box: face.box, score: face.score, embedding, crop: face.crop ? Buffer.from(face.crop, "base64") : null };
        })
      };
    }
  };
}
