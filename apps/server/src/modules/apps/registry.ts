// The containers that run beside this server (docs/apps-platform-plan.md). Each
// is reached only through the gateway, under its own prefix; none faces the
// network. The registry is code, not data: a container is something this release
// knows how to talk to. What an install sets is where it is and its secret.
//
// An "app" draws its own pages (games); an "engine" has none and this app draws
// them (video, later). Both are reached, probed and logged the same way.
import type { SectionKey } from "../../core/sections.js";

export type AppId = "games";
export type AppKind = "app" | "engine";

/** From where a capability may be used (docs/apps-platform-plan.md → Network rules). */
export const NETWORK_RULES = ["anywhere", "trusted", "home"] as const;
export type NetworkRule = (typeof NETWORK_RULES)[number];

/** One thing a container can do, as the paths it answers it on. The rules are
 *  set per capability, so a download can be held to the house while browsing
 *  works from anywhere. Declared here, in code this release ships, rather than
 *  read from the container: the paths are what the gateway enforces, and a
 *  container must not be able to widen them. */
export interface AppCapability {
  id: string;
  /** Path prefixes on the home origin, matched in the order the capabilities are
   *  listed — put the specific ones first. An empty list is the catch-all. */
  paths: string[];
  defaultRule: NetworkRule;
}

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
  /** The variable the container itself reads the secret from, for Apps → Setup. */
  containerSecretVariable: string;
  /** A signed call under the prefix that answers 401 when the container does not
   *  take this app's signature — how Apps → Installed tells a wrong secret apart
   *  from a working one (health answers the same with any secret). */
  signedProbePath: string;
  /** Where its configuration is documented (docs/configuration.md). */
  docsAnchor: string;
  /** What it can do, specific first, the catch-all last. */
  capabilities: AppCapability[];
}

export const APPS: readonly AppDefinition[] = [
  {
    id: "games",
    kind: "app",
    prefix: "/games",
    section: "games",
    urlVariable: "GAMES_URL",
    secretVariable: "GAMES_GATEWAY_SECRET",
    containerSecretVariable: "GATEWAY_SECRET",
    signedProbePath: "/games/api/me",
    docsAnchor: "games",
    capabilities: [
      // The admin's window (events, log) — the games server also checks the role.
      { id: "manage", paths: ["/games/api/admin/"], defaultRule: "anywhere" },
      // Everything else: the lobby, the games, matches, guests' play.
      { id: "play", paths: [], defaultRule: "anywhere" }
    ]
  }
];

/** The capability a request path falls under: the first whose prefix matches,
 *  else the catch-all. */
export function capabilityFor(app: AppDefinition, path: string): AppCapability {
  const clean = path.split("?")[0];
  return app.capabilities.find((cap) => cap.paths.some((prefix) => clean.startsWith(prefix)))
    ?? app.capabilities.find((cap) => cap.paths.length === 0)
    ?? app.capabilities[app.capabilities.length - 1];
}

export function appDefinition(id: AppId): AppDefinition {
  const found = APPS.find((app) => app.id === id);
  if (!found) throw new Error(`Unknown app "${id}"`);
  return found;
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
  const badUrl = urlProblem(app, upstream);
  if (badUrl) return { enabled: false, reason: badUrl };
  if (!secret) return { enabled: false, reason: `${app.urlVariable} is set but there is no secret yet; ${app.id} stays off until it is paired on Control panel → Apps → Setup or ${app.secretVariable} is set.` };
  return { enabled: true };
}

/** Why an address cannot be proxied to, or null when it can. The gateway is
 *  registered for any usable address, secret or not, so pairing later needs no
 *  restart; it answers 404 until there is a secret. */
export function urlProblem(app: AppDefinition, upstream: string): string | null {
  if (!upstream) return `${app.urlVariable} is not set`;
  return /^https?:\/\//.test(upstream) ? null : `${app.urlVariable} must start with http:// or https:// (got "${upstream}"); ${app.id} stays off.`;
}
