import { useEffect, useRef, useState } from "react";

// Where a portalled, fixed-position dropdown hangs from its trigger.
export interface AnchoredMenuPosition {
  top: number;
  /** Set when the menu hangs from the trigger's left edge… */
  left: number | null;
  /** …or this, from its right edge, when a left-anchored menu would run off-screen. */
  right: number | null;
  /** The trigger's width — a menu is never narrower than what opened it. */
  width: number;
}

// The dropdown a browse toolbar opens: portalled to <body> and fixed-positioned,
// because a toolbar scrolls sideways and clips its overflow. Being out of that box
// it has to place itself — measured once, on open, 8px under the trigger, hanging
// from the trigger's right edge when `menuWidth` from its left would run past the
// window. Because the position is only computed on open, scrolling or resizing
// closes the menu rather than let it drift from its trigger; a mousedown outside
// both closes it too, and Escape unless `closeOnEscape` is off.
export function useAnchoredMenu<T extends HTMLElement = HTMLButtonElement>({
  menuWidth = 200,
  closeOnEscape = true
}: { menuWidth?: number; closeOnEscape?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<AnchoredMenuPosition | null>(null);
  const triggerRef = useRef<T>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    setOpen((isOpen) => {
      if (!isOpen && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const alignRight = rect.left + menuWidth > window.innerWidth;
        setPos({
          top: rect.bottom + 8,
          left: alignRight ? null : rect.left,
          right: alignRight ? window.innerWidth - rect.right : null,
          width: rect.width
        });
      }
      return !isOpen;
    });
  };

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const dismiss = () => setOpen(false);
    window.addEventListener("mousedown", onMouseDown);
    if (closeOnEscape) window.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open, closeOnEscape]);

  return { open, pos, toggle, close, triggerRef, menuRef };
}
