import { useEffect, useState } from "react";

// Whether this install has the games (isputnik.games behind /games — see
// docs/games-platform-plan.md). Asked once per page load and remembered: the
// answer is an environment setting, so it cannot change under a running session.
let known: boolean | null = null;
let pending: Promise<boolean> | null = null;

function check(): Promise<boolean> {
  if (known !== null) return Promise.resolve(known);
  pending ??= fetch("/api/games/status", { credentials: "include" })
    .then(async (res) => (res.ok ? Boolean(((await res.json()) as { enabled?: boolean }).enabled) : false))
    .catch(() => false)
    .then((enabled) => {
      known = enabled;
      return enabled;
    });
  return pending;
}

export function useGamesAvailable(): boolean {
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
export function resetGamesAvailable(): void {
  known = null;
  pending = null;
}
