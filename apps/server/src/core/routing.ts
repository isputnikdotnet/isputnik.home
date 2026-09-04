import { db } from "../db.js";
import { openSecret } from "./mfa.js";
import { REMOTE_FETCH_USER_AGENT } from "./safe-fetch.js";

// Road routing: two coordinates and a way of travelling in, the line the
// journey actually follows out. Platform infrastructure like mail — it carries
// no product knowledge (it has never heard of a story) and is configured once
// by an admin, which is why it lives here rather than beside its first caller.
//
// Three rules shape it:
//
// 1. Nothing leaves the house until an admin pastes an OpenRouteService key
//    into Settings → Maps. With no key every call returns null and the caller
//    draws a straight line, which is exactly what shipped in 3.58.0.
// 2. It is asked ONCE, when a route is saved — never when one is read. The
//    line comes back as an encoded polyline and is stored with the stop, so a
//    story opened a thousand times, by members or by guests on a share link,
//    makes no outbound request at all, keeps working if the key later lapses,
//    and still draws the roads as they were on the day it was written.
// 3. It never throws. A missing key, a dead service, or two points no road
//    connects all return null, and the leg falls back to a drawn line.
//
// What goes out is a pair of coordinates and a profile — not the story, not the
// stop names, not who is asking.

export const ROUTING_SETTINGS_KEY = "routing_settings";

/** The default host. `endpoint` overrides it, so the same settings point at a
 *  self-hosted OpenRouteService without another release. */
const ORS_URL = "https://api.openrouteservice.org";
const REQUEST_TIMEOUT_MS = 12_000;

export interface RoutingSettings {
  /** OpenRouteService API key; "" disables routing entirely. */
  apiKey: string;
  /** Base URL of the service. Blank = the public OpenRouteService. */
  endpoint: string;
}

const EMPTY: RoutingSettings = { apiKey: "", endpoint: "" };

export function getRoutingSettings(): RoutingSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ROUTING_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { ...EMPTY };
  try {
    const parsed = { ...EMPTY, ...(JSON.parse(row.value) as Partial<RoutingSettings>) };
    // Sealed at rest (see mfa.sealSecret); a legacy plaintext value passes through.
    return { ...parsed, apiKey: openSecret(parsed.apiKey) };
  } catch {
    return { ...EMPTY };
  }
}

/** The still-sealed key straight from storage. The "blank = keep" save path
 *  uses this so a transiently unreadable seal key doesn't wipe the stored one. */
export function getStoredRoutingKeyRaw(): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ROUTING_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return "";
  try {
    return (JSON.parse(row.value) as Partial<RoutingSettings>).apiKey ?? "";
  } catch {
    return "";
  }
}

export function isRoutingConfigured(settings: RoutingSettings = getRoutingSettings()): boolean {
  return Boolean(settings.apiKey);
}

// How somebody got from one stop to the next. The list is the product's, but it
// lives here because the mapping onto routing profiles does: three of these
// follow roads, and the rest are drawn, which is a fact about routing services
// rather than about stories.
export const TRAVEL_MODES = ["walk", "cycle", "drive", "bus", "train", "plane", "boat"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

// A bus follows the same roads a car does — there is no timetable here, only
// the shape of the journey. Trains, flights and boats have no road to follow,
// so they are never asked for: a railway is not in a routing graph built for
// vehicles, and a plane's honest line is the great-circle arc the reader draws.
const PROFILES: Partial<Record<TravelMode, string>> = {
  walk: "foot-walking",
  cycle: "cycling-regular",
  drive: "driving-car",
  bus: "driving-car"
};

export function isRoutableMode(mode: string | null): boolean {
  return Boolean(mode && mode in PROFILES);
}

export interface RoutePointInput {
  lat: number;
  lng: number;
}

/**
 * The line from `from` to `to` as an encoded polyline (precision 5), or null
 * when routing is off, the mode has no roads, or the service could not answer.
 * Never throws — a route that cannot be found is a drawn line, not an error.
 */
export async function routeLeg(
  from: RoutePointInput,
  to: RoutePointInput,
  mode: string | null
): Promise<string | null> {
  const profile = mode ? PROFILES[mode as TravelMode] : undefined;
  if (!profile) return null;
  const settings = getRoutingSettings();
  if (!isRoutingConfigured(settings)) return null;

  const base = (settings.endpoint || ORS_URL).replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/v2/directions/${profile}`, {
      method: "POST",
      headers: {
        Authorization: settings.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": REMOTE_FETCH_USER_AGENT
      },
      // OpenRouteService takes longitude first — the opposite of every other
      // coordinate in this codebase, and the classic way to route to the sea.
      body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { routes?: { geometry?: string }[] };
    const geometry = body.routes?.[0]?.geometry;
    return typeof geometry === "string" && geometry.length > 0 ? geometry : null;
  } catch {
    return null;
  }
}

/** Why a test from the settings page failed, in words an admin can act on. */
export async function testRouting(): Promise<{ ok: boolean; error?: string }> {
  const settings = getRoutingSettings();
  if (!isRoutingConfigured(settings)) return { ok: false, error: "No API key is saved yet." };
  const base = (settings.endpoint || ORS_URL).replace(/\/+$/, "");
  try {
    // Two points a few hundred metres apart in central Berlin: a real request
    // against the real profile, small enough to be a rounding error in the
    // daily allowance.
    const response = await fetch(`${base}/v2/directions/driving-car`, {
      method: "POST",
      headers: {
        Authorization: settings.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": REMOTE_FETCH_USER_AGENT
      },
      body: JSON.stringify({ coordinates: [[13.3888, 52.5170], [13.3971, 52.5186]] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "The service rejected that key." };
    }
    if (response.status === 429) {
      return { ok: false, error: "The key is over its allowance for now — try again later." };
    }
    if (!response.ok) return { ok: false, error: `The service answered ${response.status}.` };
    const body = (await response.json()) as { routes?: { geometry?: string }[] };
    if (!body.routes?.[0]?.geometry) return { ok: false, error: "The service answered, but with no route in it." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the routing service." };
  }
}
