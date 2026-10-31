// This server's calls to the video engine's admin API (docs/video-architecture.md →
// How they talk). Home manages the video libraries and the engine keeps what is in
// them, so creating, changing, deleting and rescanning a library are calls made
// here, signed like any gateway request, in the admin's name — or, for the
// background sync, in a system identity the engine's log can name.
import type { User } from "../../../db.js";
import { identityHeaders } from "../../apps/gateway.js";
import { appConfigured, appDefinition } from "../../apps/registry.js";

const VIDEO = appDefinition("video");

/** Library changes are small JSON; the folder picker one directory. Neither should take long. */
const CALL_TIMEOUT_MS = 10_000;

/** The identity background calls go out with: an admin, by role. */
const SYSTEM_ACTOR = {
  id: "system:home",
  display_name: "isputnik.home",
  role: "admin",
  language: "en",
  theme: "system"
} as unknown as User;

export class EngineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface EngineTarget {
  upstream: string;
  secret: string;
}

export interface EngineClient {
  call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, options?: { body?: unknown; actor?: User | null; requestId?: string }): Promise<T>;
}

/** A client for whichever engine `target` names when a call is made, so a
 *  secret paired on Settings › Apps is used at once. `path` is under /video/api. */
export function engineClient(target: () => EngineTarget): EngineClient {
  return {
    async call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, options: { body?: unknown; actor?: User | null; requestId?: string } = {}): Promise<T> {
      const { upstream, secret } = target();
      const configured = appConfigured(VIDEO, upstream, secret);
      if (!configured.enabled) throw new EngineError(configured.reason ?? "The video app is not set up.", 503);
      const actor = options.actor && options.actor.role === "admin" ? options.actor : SYSTEM_ACTOR;
      let response: Response;
      try {
        response = await fetch(`${upstream}${VIDEO.prefix}/api${path}`, {
          method,
          headers: {
            ...identityHeaders(actor, secret, { ip: "127.0.0.1", requestId: options.requestId ?? `home-${Date.now().toString(36)}` }),
            ...(options.body === undefined ? {} : { "content-type": "application/json" })
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
      } catch (err) {
        throw new EngineError(`The video app did not answer (${err instanceof Error ? err.message : String(err)}).`, 502);
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401) throw new EngineError("The video app refused this server's secret. Check Settings › Apps.", 502);
      if (!response.ok) {
        // The engine's own 4xx (a folder that is not there, a kind that cannot
        // change) is the admin's to read; anything else is the container's problem.
        const status = response.status >= 400 && response.status < 500 ? response.status : 502;
        throw new EngineError(payload.error ?? `The video app answered ${response.status}.`, status);
      }
      return payload as T;
    }
  };
}
