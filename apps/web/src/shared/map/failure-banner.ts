// The line over a map whose pieces could not be downloaded.
//
// Its own file because the rule it keeps is easy to get wrong and worth testing
// without a WebGL map: a map is usually PART kept and part not, so tiles keep
// arriving from disk all through an outage. Clearing the line on the first of
// them would blink it on and off while the service is still down — so it goes
// only once the failures have stopped.
//
// Not the same thing as the renderer's `showNotice`, which stands in place of a
// map that could not be drawn at all.

/** How long after the last failed piece of map the line stays up. */
const SETTLE_MS = 10_000;

/**
 * Whether a map error means the map service could not be reached, as opposed to
 * something about this one asset. This server answers 502 when it cannot reach
 * the provider and 503 while it is leaving a failing one alone; a map going
 * straight to the provider fails with no status at all. A 404 is an answer —
 * that piece of map does not exist — and says nothing about the service.
 */
export function serviceIsDown(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  // MapLibre gives a request that never got an answer at all a status of 0 —
  // which is what an offline browser, and a server that is not there, look like.
  if (status === 0) return true;
  if (typeof status === "number") return status >= 500 && status < 600;
  const message = err instanceof Error ? err.message : "";
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}

export interface FailureBanner {
  /** A piece of map could not be downloaded: put the line up, or keep it up. */
  failed(): void;
  /** A piece of map arrived: take the line down, once the failures have stopped. */
  arrived(): void;
  /** Take it down now (the map is going away). */
  remove(): void;
}

export function createFailureBanner(container: HTMLElement, text: () => string, settleMs = SETTLE_MS): FailureBanner {
  let element: HTMLElement | null = null;
  let lastFailure = 0;
  return {
    failed() {
      lastFailure = Date.now();
      if (element) return;
      element = document.createElement("div");
      element.className = "map-banner";
      element.setAttribute("role", "status");
      element.textContent = text();
      container.appendChild(element);
    },
    arrived() {
      if (!element || Date.now() - lastFailure < settleMs) return;
      element.remove();
      element = null;
    },
    remove() {
      element?.remove();
      element = null;
    }
  };
}
