import { useEffect, useState } from "react";

// `value`, but only once it has held still for `delayMs` — the search box that
// shouldn't fire a request per keystroke. Starts at the first value (no initial
// wait), and every change restarts the clock, so a burst of typing settles into
// one update after the last key.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
