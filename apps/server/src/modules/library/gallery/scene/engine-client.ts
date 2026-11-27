// This server's calls to the engine for what a photo SHOWS (isputnik.faces 0.2.0,
// docs/scene-search-plan.md): a picture or a typed phrase goes out, a vector comes
// back, and the engine keeps nothing. The same container, address and secret as
// face detection (faces/engine-client.ts), signed the same way.
import { identityHeaders } from "../../../apps/gateway.js";
import { appConfigured, appDefinition } from "../../../apps/registry.js";
import { resolveAppSecret } from "../../../apps/pairing.js";
import { SYSTEM_ACTOR } from "../faces/engine-client.js";
import { SCENE_DIMENSIONS, SCENE_MODEL } from "./model-id.js";

const FACES = appDefinition("faces");

/** The model looks at a thumbnail: a second is slow. The first call of a cold
 *  engine loads the model first. */
const EMBED_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const NOT_PAIRED = "Search by what a photo shows needs the isputnik.faces container: pair it on Control panel → Settings › Apps.";

export type SceneEngineProblem = "unavailable" | "undecodable" | "refused" | "other";

export class SceneEngineError extends Error {
  constructor(message: string, readonly kind: SceneEngineProblem) {
    super(message);
  }
}

/** Thrown when nothing can describe photos right now; a scan stops instead of
 *  failing photo by photo, and a settings change says why. */
export class NoSceneEngineError extends Error {}

export interface SceneEngineStatus {
  available: boolean;
  /** The container's version when it answers. */
  version: string | null;
  /** Why not, in words the settings page shows; null when available. */
  reason: string | null;
}

interface HealthWire {
  ok?: boolean;
  version?: string;
  scene?: { model?: string; dimensions?: number; modelsPresent?: boolean; loaded?: boolean };
}

interface EmbedWire {
  model?: string;
  dimensions?: number;
  embedding?: string;
  error?: string;
}

export interface SceneEngine {
  /** Whether photos can be described right now, and why not. Probes the container. */
  status(): Promise<SceneEngineStatus>;
  /** Refuses with NoSceneEngineError when they cannot. Called once per scan. */
  ensure(): Promise<void>;
  /** The vector for one picture. `type` is the bytes' media type. */
  embedImage(bytes: Buffer, type: string): Promise<Float32Array>;
  /** The vector for what a person typed, in the same space. */
  embedText(text: string): Promise<Float32Array>;
}

export interface SceneEngineOptions {
  /** Where the engine is; the install's pairing by default. Tests point at a stand-in. */
  target?: () => { upstream: string; secret: string };
  fetch?: typeof fetch;
}

const fetchImpl: typeof fetch = (...args) => fetch(...args);

function problemIn(health: HealthWire): string | null {
  if (health.ok !== true) return "The isputnik.faces container answered, but says it is not well.";
  if (!health.scene) return "The isputnik.faces container is older than 0.2.0 and cannot describe photos yet: update it.";
  if (health.scene.modelsPresent !== true) return "The isputnik.faces container has no scene model: it needs a rebuilt image.";
  if (health.scene.model !== SCENE_MODEL) {
    return `The isputnik.faces container runs a different scene model (${health.scene.model ?? "unnamed"}) than this server expects (${SCENE_MODEL}): update whichever is older.`;
  }
  return null;
}

export function createSceneEngine(options: SceneEngineOptions = {}): SceneEngine {
  const target = options.target ?? (() => {
    const resolved = resolveAppSecret("faces");
    return { upstream: resolved.upstream, secret: resolved.secret };
  });
  const doFetch = options.fetch ?? fetchImpl;

  const base = () => {
    const { upstream, secret } = target();
    if (!appConfigured(FACES, upstream, secret).enabled) throw new NoSceneEngineError(NOT_PAIRED);
    return { upstream, secret };
  };
  const headers = (secret: string) => identityHeaders(SYSTEM_ACTOR, secret, { ip: "127.0.0.1", requestId: `home-${Date.now().toString(36)}` });

  const health = async (): Promise<HealthWire> => {
    const { upstream } = base();
    let response: Response;
    try {
      response = await doFetch(`${upstream}${FACES.prefix}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (err) {
      throw new NoSceneEngineError(`The isputnik.faces container did not answer (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (!response.ok) throw new NoSceneEngineError(`The isputnik.faces container answered ${response.status}.`);
    return (await response.json().catch(() => ({}))) as HealthWire;
  };

  const vectorFrom = async (response: Response): Promise<Float32Array> => {
    if (response.status === 401) throw new SceneEngineError("The isputnik.faces container refused this server's secret. Check Settings › Apps.", "refused");
    const payload = (await response.json().catch(() => ({}))) as EmbedWire;
    if (response.status === 415 || response.status === 422) {
      throw new SceneEngineError(payload.error ?? `The engine could not read the picture (${response.status}).`, "undecodable");
    }
    // 404: an engine from before 0.2.0 has no such route. 503: no model in it.
    if (response.status === 404 || response.status === 503) {
      throw new SceneEngineError(payload.error ?? "The isputnik.faces container cannot describe photos: update it.", "unavailable");
    }
    if (!response.ok || typeof payload.embedding !== "string") {
      throw new SceneEngineError(payload.error ?? `The engine answered ${response.status}.`, "other");
    }
    // A vector from another model would be stored under this server's model id
    // and silently never match anything: refuse it here.
    if (payload.model !== SCENE_MODEL) {
      throw new SceneEngineError(`The engine answered with model ${payload.model ?? "unnamed"}, not ${SCENE_MODEL}.`, "unavailable");
    }
    const raw = Buffer.from(payload.embedding, "base64");
    if (raw.byteLength !== SCENE_DIMENSIONS * 4) {
      throw new SceneEngineError(`The engine answered ${raw.byteLength / 4} numbers, not ${SCENE_DIMENSIONS}.`, "other");
    }
    // A copy: a Float32Array over a Buffer slice would alias the pool.
    const vector = new Float32Array(SCENE_DIMENSIONS);
    vector.set(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
    return vector;
  };

  const post = async (route: string, init: { headers: Record<string, string>; body: BodyInit }): Promise<Float32Array> => {
    const { upstream, secret } = base();
    let response: Response;
    try {
      response = await doFetch(`${upstream}${FACES.prefix}/api/embed/${route}`, {
        method: "POST",
        headers: { ...headers(secret), ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
      });
    } catch (err) {
      throw new SceneEngineError(`The isputnik.faces container did not answer (${err instanceof Error ? err.message : String(err)}).`, "unavailable");
    }
    return vectorFrom(response);
  };

  return {
    async status() {
      try {
        const answer = await health();
        const reason = problemIn(answer);
        return { available: reason === null, version: answer.version ?? null, reason };
      } catch (err) {
        return { available: false, version: null, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async ensure() {
      const problem = problemIn(await health());
      if (problem) throw new NoSceneEngineError(problem);
    },
    embedImage(bytes, type) {
      // A copy with its own ArrayBuffer: a Buffer's slice of the pool is not what
      // fetch's BodyInit types accept.
      return post("image", { headers: { "content-type": type }, body: new Blob([new Uint8Array(bytes)], { type }) });
    },
    embedText(text) {
      return post("text", { headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    }
  };
}

let shared: SceneEngine | null = null;

/** The engine the scanner, the settings page and search share. */
export function sceneEngine(): SceneEngine {
  shared ??= createSceneEngine();
  return shared;
}

/** Tests put a stand-in in place; null restores the real one. */
export function setSceneEngine(engine: SceneEngine | null): void {
  shared = engine;
}
