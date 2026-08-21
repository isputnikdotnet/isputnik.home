import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A hover label that appears at once and is never clipped. The browser's own
// `title` is fine on a big control, but on a glyph inside a scrolling table it
// waits about a second before showing, and a CSS bubble drawn inside the table is
// cut off by `.datagrid-wrap`'s overflow. So the bubble is portalled to <body> and
// placed from the trigger's viewport rect: outside every ancestor's clipping.
//
// It is decoration for the mouse, not a way to carry information: whatever it
// says must also be in the trigger's own accessible name (the bubble is
// aria-hidden), so a screen reader hears it without the tooltip ever opening.

const OPEN_DELAY_MS = 90;
const GAP = 8;

export function Tooltip({
  label,
  children,
  className,
  placement = "top"
}: {
  label: string;
  children: ReactNode;
  className?: string;
  placement?: "top" | "bottom";
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; below: boolean } | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPosition(null);
  }, []);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Measured after the bubble renders (see the layout effect below); until then
    // it is placed from the trigger alone and nudged into the window on the next
    // frame, which is a pass nobody sees at this size.
    const bubble = bubbleRef.current?.getBoundingClientRect();
    const width = bubble?.width ?? 0;
    const height = bubble?.height ?? 0;
    const wantsBelow = placement === "bottom" || rect.top - height - GAP < 4;
    const top = wantsBelow ? rect.bottom + GAP : rect.top - height - GAP;
    const left = Math.min(
      Math.max(4, rect.left + rect.width / 2 - width / 2),
      Math.max(4, window.innerWidth - width - 4)
    );
    setPosition({ top, left, below: wantsBelow });
  }, [placement]);

  const show = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      place();
    }, OPEN_DELAY_MS);
  }, [place]);

  // A scroll or resize moves the trigger out from under a bubble that was placed
  // from the old rect, so the honest thing is to close rather than chase it.
  useEffect(() => {
    if (!position) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onEscape);
    };
  }, [position, hide]);

  // Re-place once the bubble has a real size, so a wide label centres properly and
  // one near the top of the window flips under its trigger. A layout effect, not a
  // plain one: the corrected position has to land before the browser paints, or the
  // bubble is visibly drawn in the wrong place first.
  useLayoutEffect(() => {
    if (!position || !bubbleRef.current) return;
    const rect = bubbleRef.current.getBoundingClientRect();
    if (Math.abs(rect.width) < 1) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const wantsBelow = placement === "bottom" || trigger.top - rect.height - GAP < 4;
    const top = wantsBelow ? trigger.bottom + GAP : trigger.top - rect.height - GAP;
    const left = Math.min(
      Math.max(4, trigger.left + trigger.width / 2 - rect.width / 2),
      Math.max(4, window.innerWidth - rect.width - 4)
    );
    if (Math.abs(top - position.top) > 0.5 || Math.abs(left - position.left) > 0.5 || wantsBelow !== position.below) {
      setPosition({ top, left, below: wantsBelow });
    }
  }, [position, placement]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        className={["tooltip-trigger", className].filter(Boolean).join(" ")}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={place}
        onBlurCapture={hide}
      >
        {children}
      </span>

      {position &&
        createPortal(
          <div
            ref={bubbleRef}
            className={`tooltip-bubble${position.below ? " is-below" : ""}`}
            style={{ top: position.top, left: position.left }}
            aria-hidden="true"
          >
            {label}
          </div>,
          document.body
        )}
    </>
  );
}
