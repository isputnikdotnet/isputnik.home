import { useEffect, useState } from "react";

// Whether this person has video here: the engine set up (VIDEO_URL and a
// secret), the Video section on, and Apps → Access letting them in — the
// server folds all three into one answer (modules/library/video). Asked once
// per page load and remembered, like the games' (useGamesAvailable).
let known: boolean | null = null;
let pending: Promise<boolean> | null = null;

function check(): Promise<boolean> {
  if (known !== null) return Promise.resolve(known);
  pending ??= fetch("/api/video/status", { credentials: "include" })
    .then(async (res) => (res.ok ? Boolean(((await res.json()) as { enabled?: boolean }).enabled) : false))
    .catch(() => false)
    .then((enabled) => {
      known = enabled;
      return enabled;
    });
  return pending;
}

export function useVideoAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(known ?? false);
  useEffect(() => {
    let cancelled = false;
    void check().then((enabled) => {
      if (!cancelled) setAvailable(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

/** Tests only: forget the cached answer. */
export function resetVideoAvailable(): void {
  known = null;
  pending = null;
}
