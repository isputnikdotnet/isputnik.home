import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RefreshCw } from "lucide-react";
import { Button } from "./Button";

// A refresh that you can SEE happen. On a LAN these requests come back in a few
// milliseconds, so the old plain "Refresh" button looked broken: you clicked it
// and nothing about the page changed, whether or not it had actually reloaded.
//
// So the spin is held for a moment even when the answer is instant, and is
// followed by a short "Updated" — long enough to read, short enough not to nag.
// Nothing here slows the DATA down: the fresh values render as soon as they
// arrive, and only the button keeps animating.
const MIN_SPIN_MS = 700;
const DONE_MS = 1600;

export function RefreshButton({
  onRefresh,
  label,
  compact = true,
  className,
  title
}: {
  /** Errors are the caller's to show (a MessageBox on the page). A rejection here
   *  just drops the button back to idle without the "Updated" tick. */
  onRefresh: () => Promise<unknown>;
  label?: string;
  compact?: boolean;
  className?: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  // Unmounting mid-refresh (navigating away as it lands) must not set state on a
  // dead component, and the pending "back to idle" timer has to be dropped.
  const aliveRef = useRef(true);
  const doneTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Set on the way IN, not just cleared on the way out: StrictMode mounts,
    // unmounts and remounts every component in dev, and a flag only ever cleared
    // would leave the button permanently "dead" — stuck spinning on first click,
    // because the result would arrive and be discarded as if unmounted.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
    };
  }, []);

  const run = async () => {
    if (state === "busy") return;
    if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
    setState("busy");

    const settled = await Promise.allSettled([
      onRefresh(),
      new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS))
    ]);
    if (!aliveRef.current) return;

    if (settled[0].status === "rejected") {
      setState("idle");
      return;
    }
    setState("done");
    doneTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) setState("idle");
    }, DONE_MS);
  };

  return (
    <Button
      variant="secondary"
      compact={compact}
      className={["refresh-button", className].filter(Boolean).join(" ")}
      onClick={() => void run()}
      disabled={state === "busy"}
      title={title}
      // Screen readers get the state as words; the icon swap carries it visually.
      aria-live="polite"
    >
      {state === "busy" ? (
        <>
          <span className="icon-spin" aria-hidden="true"><RefreshCw size={15} /></span>
          {t("refresh.refreshing")}
        </>
      ) : state === "done" ? (
        <>
          <Check size={15} aria-hidden="true" />
          {t("refresh.updated")}
        </>
      ) : (
        <>
          <RefreshCw size={15} aria-hidden="true" />
          {label ?? t("refresh.refresh")}
        </>
      )}
    </Button>
  );
}
