// The containers that run beside this server (docs/apps-platform-plan.md). Each
// is reached only through the gateway, under its own prefix; none faces the
// network. The registry is code, not data: a container is something this release
// knows how to talk to. What an install sets is where it is and its secret.
//
// An "app" draws its own pages (games); an "engine" has none and this app draws
// them (video, later). Both are reached, probed and logged the same way.
import { config } from "../../config.js";
import type { SectionKey } from "../../core/sections.js";

export type AppId = "games";
export type AppKind = "app" | "engine";

export interface AppDefinition {
  id: AppId;
  kind: AppKind;
  /** Everything under this path on the home origin belongs to the container. */
  prefix: string;
  /** The menu section the admin switches it on and off with (core/sections.ts). */
  section: SectionKey;
  /** The environment variables an install sets, named in status messages. */
  urlVariable: string;
  secretVariable: string;
  /** A signed call under the prefix that answers 401 when the container does not
   *  take this app's signature — how Apps → Installed tells a wrong secret apart
   *  from a working one (health answers the same with any secret). */
  signedProbePath: string;
  /** Where its configuration is documented (docs/configuration.md). */
  docsAnchor: string;
}

export const APPS: readonly AppDefinition[] = [
  {
    id: "games",
    kind: "app",
    prefix: "/games",
    section: "games",
    urlVariable: "GAMES_URL",
    secretVariable: "GAMES_GATEWAY_SECRET",
    signedProbePath: "/games/api/me",
    docsAnchor: "games"
  }
];

export function appDefinition(id: AppId): AppDefinition {
  const found = APPS.find((app) => app.id === id);
  if (!found) throw new Error(`Unknown app "${id}"`);
  return found;
}

/** Where this install says the container is, and the secret it signs with. */
export function appSettings(id: AppId): { upstream: string; secret: string } {
  switch (id) {
    case "games": return { upstream: config.gamesUrl, secret: config.gamesGatewaySecret };
  }
}

export interface AppConfigured {
  enabled: boolean;
  /** Why a half-set container stays off, for the log and the Apps page. */
  reason?: string;
}

/** Whether the container is set up well enough to proxy to. No URL = not
 *  installed (no reason: nothing to warn about); a URL without a secret, or a
 *  URL that is not http(s), stays off with a reason. */
export function appConfigured(app: AppDefinition, upstream: string, secret: string): AppConfigured {
  if (!upstream) return { enabled: false };
  if (!secret) return { enabled: false, reason: `${app.urlVariable} is set but ${app.secretVariable} is not; ${app.id} stays off until both are set.` };
  if (!/^https?:\/\//.test(upstream)) return { enabled: false, reason: `${app.urlVariable} must start with http:// or https:// (got "${upstream}"); ${app.id} stays off.` };
  return { enabled: true };
}
