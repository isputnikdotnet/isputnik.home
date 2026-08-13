import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownUp, ChevronDown } from "lucide-react";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

// The sort control every browse page wears. Lifted out of the audiobooks page,
// where this shape was settled, so Authors, Narrators, Series and Categories get
// the identical box rather than a second dropdown that looks nearly the same.
//
// The menu is portalled to <body> and fixed-positioned for one reason: a browse
// toolbar can scroll sideways and clips its overflow, which would cut a menu
// anchored inside it. Being out of that box, it also has to decide its own
// alignment — it hangs from the trigger's right edge when a left-anchored menu
// would run off-screen, which for a control at the end of a toolbar is always.
export function SortMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel = "Sort",
  presentation = "inline",
  icon,
  label
}: {
  value: T;
  options: SortOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  /**
   * `inline` — "Sort by ▾ Title (A–Z)", for a page that has room for a sentence.
   * `icon` — a 44px square, no text.
   * `labelled` — icon + text + chevron, the browse toolbar's shape. The text is
   *   the chosen value, because a list's order is otherwise invisible; pass
   *   `label` where the effect IS visible (View) and the name reads better.
   */
  presentation?: "inline" | "icon" | "labelled";
  /** Defaults to the sort glyph. */
  icon?: React.ReactNode;
  /** Fixed trigger text, instead of the chosen option's label. */
  label?: string;
}) {
  const compact = presentation === "icon";
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number | null; right: number | null; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = options.find((option) => option.value === value)?.label ?? "";

  const toggle = () => {
    setOpen((isOpen) => {
      if (!isOpen && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const alignRight = rect.left + 200 > window.innerWidth;
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

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const dismiss = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  const glyph = icon ?? <ArrowDownUp size={18} aria-hidden="true" />;

  return (
    <div className={`audiobook-sort-control${compact ? " compact" : ""}${presentation === "labelled" ? " labelled" : ""}`}>
      {compact ? (
        <button
          ref={triggerRef}
          type="button"
          className="audiobook-sort-trigger"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          // The label alone says what the control is for; the chosen value is what
          // an icon-only trigger can't show, so it goes in both name and tooltip.
          aria-label={`${ariaLabel}: ${currentLabel}`}
          title={`${ariaLabel}: ${currentLabel}`}
        >
          {glyph}
        </button>
      ) : presentation === "labelled" ? (
        <button
          ref={triggerRef}
          type="button"
          className="audiobook-sort-trigger"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          // The visible text may be the value or a fixed name; the accessible name
          // always carries both, so it never depends on which was chosen.
          aria-label={`${ariaLabel}: ${currentLabel}`}
          title={`${ariaLabel}: ${currentLabel}`}
        >
          {glyph}
          <span className="toolbar-label">{label ?? currentLabel}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      ) : (
        <>
          <span>Sort by</span>
          <button
            ref={triggerRef}
            type="button"
            className="audiobook-sort-trigger"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
          >
            <span>{currentLabel}</span>
          </button>
          <ChevronDown size={16} aria-hidden="true" />
        </>
      )}
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu audiobook-sort-menu"
          role="menu"
          aria-label={ariaLabel}
          style={{ position: "fixed", top: pos.top, left: pos.left ?? undefined, right: pos.right ?? undefined, minWidth: pos.width }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitem"
              className={value === option.value ? "active" : ""}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
