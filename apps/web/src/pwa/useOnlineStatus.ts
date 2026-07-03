import { useEffect, useState } from "react";

// `navigator.onLine` only reflects whether a network *interface* is up — not
// whether the server is actually reachable. It routinely lags many seconds (or
// never flips) when the server goes down while the LAN is fine, when the link
// drops without a clean interface-down, or when the OS is slow to report it. So
// alongside the instant `offline` event we actively probe the server on a short
// interval (mirroring App.tsx's session check) and flip the indicator on the
// result — making online→offline reflect reality within a few seconds.
const PROBE_URL = "/api/setup/status"; // public + lightweight + never served from the SW cache
const PROBE_TIMEOUT_MS = 3000;
const PROBE_INTERVAL_MS = 6000;

async function serverReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(PROBE_URL, { cache: "no-store", signal: controller.signal });
    return res.ok;
  } catch {
    return false; // network error / timeout / abort
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
  | "unreachable"; // device is online, but the server isn't answering

// Consecutive failed probes before declaring the server unreachable. One miss is
// often just a brief load spike (a scan, a restart); requiring two avoids flapping
// the banner on a single slow response.
const FAILURES_BEFORE_UNREACHABLE = 2;

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => (navigator.onLine ? "online" : "offline"));

  useEffect(() => {
    let alive = true;
    let failures = 0; // consecutive server-probe failures while the device is online

    const check = async () => {
      // Fast path: the OS already knows we're offline — no point probing (and it
      // avoids a failing request every interval while genuinely disconnected).
      if (!navigator.onLine) { failures = 0; if (alive) setStatus("offline"); return; }
      const ok = await serverReachable();
      if (!alive) return;
      if (ok) { failures = 0; setStatus("online"); return; }
      // Device has a network but the server didn't answer. Tolerate a single miss;
      // only flip to "unreachable" once it fails repeatedly.
      failures += 1;
      if (failures >= FAILURES_BEFORE_UNREACHABLE) setStatus("unreachable");
    };

    const onOffline = () => { failures = 0; if (alive) setStatus("offline"); };
    const onOnline = () => { void check(); };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    void check();
    const interval = window.setInterval(() => { void check(); }, PROBE_INTERVAL_MS);

    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return status;
}

// Boolean convenience for callers that only care whether the server is reachable
// (e.g. gating offline-only UI). "offline" and "unreachable" both mean "not online".
export function useOnlineStatus(): boolean {
  return useConnectionStatus() === "online";
}
