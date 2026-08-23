import { useEffect, useState } from "react";
import { api } from "../../api";

// How many cards the user has not LOOKED AT. Not how many they have not acted
// on — that number only ever climbs, and a badge that reads 47 is a badge people
// learn to ignore. Opening the inbox clears this; deciding about each card is a
// separate, unhurried thing.
//
// Read by the shell to decide whether the Profile button wears a dot. Refreshed
// on mount and whenever the window regains focus, which at household scale is
// often enough and costs one indexed COUNT.

const UNSEEN_CHANGED = "isputnik:inbox-unseen";

/** Tell every mounted copy of this hook to re-check (after opening the inbox). */
export function refreshInboxSummary(): void {
  window.dispatchEvent(new Event(UNSEEN_CHANGED));
}

export function useInboxSummary(): number {
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api<{ unseen: number }>("/api/social/inbox/summary")
        .then((payload) => { if (!cancelled) setUnseen(payload.unseen); })
        // A failing bell must never be a visible error — it just doesn't light up.
        .catch(() => undefined);
    };

    load();
    window.addEventListener("focus", load);
    window.addEventListener(UNSEEN_CHANGED, load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
      window.removeEventListener(UNSEEN_CHANGED, load);
    };
  }, []);

  return unseen;
}
