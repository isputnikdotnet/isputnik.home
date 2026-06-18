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

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    let alive = true;

    const check = async () => {
      // Fast path: the OS already knows we're offline — no point probing (and it
      // avoids a failing request every interval while genuinely disconnected).
      if (!navigator.onLine) { if (alive) setOnline(false); return; }
      const ok = await serverReachable();
      if (alive) setOnline(ok);
    };

    const onOffline = () => { if (alive) setOnline(false); };
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

  return online;
}
