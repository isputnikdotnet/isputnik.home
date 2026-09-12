import { useSyncExternalStore } from "react";
import { isBlockedByNetwork } from "../api";

// `navigator.onLine` only reflects whether a network *interface* is up — not
// whether the server is actually reachable. It routinely lags many seconds (or
// never flips) when the server goes down while the LAN is fine, when the link
// drops without a clean interface-down, or when the OS is slow to report it. So
// alongside the instant `offline` event we actively probe the server on a short
// interval (mirroring App.tsx's session check) and flip the indicator on the
// result — making online→offline reflect reality within a few seconds.
//
// ONE probe for the whole app. Each hook used to run its own timer, so a screen
// with Home and the PWA banners on it asked the server the same question twice
// every six seconds (four times in dev, where effects mount twice) — and a wall
// display leaves that tab open for weeks. The state lives here, the timer starts
// with the first subscriber and stops with the last, and every component reads
// the same answer through useSyncExternalStore.
const PROBE_URL = "/api/setup/status"; // public + lightweight + never served from the SW cache
const PROBE_TIMEOUT_MS = 3000;
const PROBE_INTERVAL_MS = 6000;

type ProbeResult = "ok" | "blocked" | "failed";

async function probeServer(): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(PROBE_URL, { cache: "no-store", signal: controller.signal });
    if (res.ok) return "ok";
    return isBlockedByNetwork(res) ? "blocked" : "failed";
  } catch {
    return "failed"; // network error / timeout / abort
  } finally {
    window.clearTimeout(timer);
  }
}

// Three states, because "the server didn't answer" and "this device has no network"
// are different problems and deserve different messages. `navigator.onLine` tells us
// whether the device has a network at all; the probe tells us whether the server is
// actually answering. Conflating them shows "No internet connection" whenever the
// server is merely busy or restarting (e.g. mid face-scan) — misleading, especially
// for a LAN-hosted app that needs no internet.
export type ConnectionStatus =
  | "online"       // server answered
  | "offline"      // this device has no network (navigator.onLine === false)
  | "unreachable"  // device is online, but the server isn't answering
  | "blocked";     // a proxy/filter on this network answered in the server's place

// Consecutive failed probes before declaring the server unreachable. One miss is
// often just a brief load spike (a scan, a restart); requiring two avoids flapping
// the banner on a single slow response.
const FAILURES_BEFORE_UNREACHABLE = 2;

let status: ConnectionStatus = typeof navigator === "undefined" || navigator.onLine ? "online" : "offline";
let failures = 0; // consecutive server-probe failures while the device is online
let running: Promise<void> | null = null; // the probe in flight, so ticks can't stack
let timer: number | null = null;
const listeners = new Set<() => void>();

function publish(next: ConnectionStatus): void {
  if (next === status) return; // identical snapshot: no re-render for anyone
  status = next;
  for (const listener of listeners) listener();
}

function check(): Promise<void> {
  // Fast path: the OS already knows we're offline — no point probing (and it
  // avoids a failing request every interval while genuinely disconnected).
  if (!navigator.onLine) {
    failures = 0;
    publish("offline");
    return Promise.resolve();
  }
  // A hidden tab is nobody's open window: its banner can't be read, and browsers
  // throttle its timers anyway. The visibilitychange handler probes the moment it
  // comes back, so what it shows is never stale by more than a moment.
  if (document.visibilityState === "hidden") return Promise.resolve();
  if (running) return running;
  running = probeServer()
    .then((result) => {
      if (result === "ok") {
        failures = 0;
        publish("online");
        return;
      }
      // A gateway block is a definite answer, not a slow one — say so on the first
      // probe rather than making the user wait out the flap tolerance below.
      if (result === "blocked") {
        failures = 0;
        publish("blocked");
        return;
      }
      // Device has a network but the server didn't answer. Tolerate a single miss;
      // only flip to "unreachable" once it fails repeatedly.
      failures += 1;
      if (failures >= FAILURES_BEFORE_UNREACHABLE) publish("unreachable");
    })
    .finally(() => {
      running = null;
    });
  return running;
}

const onOffline = () => {
  failures = 0;
  publish("offline");
};
const onOnline = () => { void check(); };
const onVisible = () => {
  if (document.visibilityState === "visible") void check();
};

function start(): void {
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  void check();
  timer = window.setInterval(() => { void check(); }, PROBE_INTERVAL_MS);
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  failures = 0;
  window.removeEventListener("offline", onOffline);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisible);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribe, () => status, () => "online");
}

// Boolean convenience for callers that only care whether the server is reachable
// (e.g. gating offline-only UI). "offline", "unreachable" and "blocked" all mean
// "not online" — whatever the reason, the server's answers aren't arriving.
export function useOnlineStatus(): boolean {
  return useConnectionStatus() === "online";
}

/** Test hook: forget the shared state between tests. */
export function resetConnectionProbe(): void {
  stop();
  listeners.clear();
  running = null;
  status = typeof navigator === "undefined" || navigator.onLine ? "online" : "offline";
}
