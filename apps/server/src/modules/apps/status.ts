// How each container stands, for Control panel → Apps → Installed: whether it is
// set up, whether it answers, and whether it takes this app's signature. Probed
// when the page asks, never in the background — the page is drawn around the
// answer, so the timeouts are short: a container that is down says so in a
// moment, not a minute.
import type { FastifyRequest } from "fastify";
import { forwardedFrom, identityHeaders } from "./gateway.js";
import { appConfigured, type AppDefinition } from "./registry.js";

const PROBE_TIMEOUT_MS = 4000;

export interface ServerProbe {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface AppStatus {
  id: string;
  kind: AppDefinition["kind"];
  /** Where the container answers on this origin — its admin events and log are under it. */
  prefix: string;
  configured: boolean;
  reason: string | null;
  url: string | null;
  secretSet: boolean;
  /** true / false (the two secrets differ) / null — asked only of a server that answers. */
  secretAccepted: boolean | null;
  server: ServerProbe | null;
}

/** Whether the container answers its health check, and which version it runs. */
export async function probeServer(app: AppDefinition, upstream: string): Promise<ServerProbe> {
  try {
    const response = await fetch(`${upstream}${app.prefix}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, version: null, error: `HTTP ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; version?: string };
    return { ok: body.ok === true, version: body.version ?? null, error: body.ok === true ? null : "Unexpected answer" };
  } catch (err) {
    return { ok: false, version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether the container takes this app's signature: one signed call as the
 *  admin asking. Health alone answers the same with any secret, so a mismatch
 *  looked "on" while every member got "Not signed in". null = not known (the
 *  call itself failed — the health probe says why). */
export async function probeSecret(app: AppDefinition, upstream: string, secret: string, request: FastifyRequest): Promise<boolean | null> {
  try {
    const response = await fetch(`${upstream}${app.signedProbePath}`, {
      headers: identityHeaders(request.user!, secret, forwardedFrom(request)),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

/** The whole answer for one container. The secret itself never leaves the
 *  server; only whether one is set. */
export async function appStatus(app: AppDefinition, upstream: string, secret: string, request: FastifyRequest): Promise<AppStatus> {
  const configured = appConfigured(app, upstream, secret);
  const server = configured.enabled ? await probeServer(app, upstream) : null;
  return {
    id: app.id,
    kind: app.kind,
    prefix: app.prefix,
    configured: configured.enabled,
    reason: configured.reason ?? null,
    url: upstream || null,
    secretSet: Boolean(secret),
    secretAccepted: server?.ok ? await probeSecret(app, upstream, secret, request) : null,
    server
  };
}
