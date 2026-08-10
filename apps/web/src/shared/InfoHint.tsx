import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

// An explanation that is worth having but not worth the room a MessageBox takes:
// a small info button beside a heading that reveals its text on hover, on focus,
// or on a click. Use it for the paragraph someone reads once and then wants out
// of the way — not for anything they have to see to act correctly, which belongs
// on the page in a MessageBox.
//
// Three ways in on purpose. Hover is what a mouse reaches for; focus is the same
// affordance for a keyboard, which hover never gives; and a click PINS it, so the
// text can be read at leisure, or on a touchscreen where there is no hover at all.
// Pinned only closes on a second click, Escape, or a click elsewhere — moving the
// pointer away must not snatch away something deliberately opened.
export function InfoHint({
  label,
  children,
  className
}: {
  /** What the hint is about, for the button's accessible name — "About folder instructions". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [pinned, setPinned] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const open = pinned || peeking;

  useEffect(() => {
    if (!pinned) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pinned]);

  return (
    <span
      ref={rootRef}
      className={["info-hint", className].filter(Boolean).join(" ")}
      onMouseEnter={() => setPeeking(true)}
      onMouseLeave={() => setPeeking(false)}
    >
      <button
        type="button"
        className={`info-hint-button${open ? " is-open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // Keyed on `pinned`, never on `open`: with a mouse the hover arrives
        // first, so by the time the click lands the panel is already showing and
        // a click that toggled `open` could never pin anything. A click pins
        // unless it is already pinned, in which case it closes the peek too —
        // otherwise the pointer sitting on the button it just dismissed would
        // keep the panel up and the click would look like it did nothing.
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setPeeking(false);
          } else {
            setPinned(true);
          }
        }}
        onFocus={() => setPeeking(true)}
        onBlur={() => setPeeking(false)}
      >
        <Info size={16} aria-hidden="true" />
      </button>
      {open && (
        <span className="info-hint-panel" id={panelId} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
