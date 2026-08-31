import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ArrowDownUp, ChevronDown } from "lucide-react";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

/**
 * One headed group of choices inside the menu, for a trigger that carries more
 * than one setting (the gallery's View: tile size AND whether the grid is broken
 * into date sections). Each group is its own single-choice list with its own
 * value and handler — this is not a multi-select.
 *
 * Untyped on purpose: a menu's groups answer different questions, so there is no
 * single T that covers them. Call sites cast in their own `onChange`.
 */
export interface SortMenuGroup {
  heading: string;
  value: string;
  options: SortOption<string>[];
  onChange: (value: string) => void;
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
interface SortMenuChrome {
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
}

export function SortMenu<T extends string>(props: SortMenuChrome & (
  | { value: T; options: SortOption<T>[]; onChange: (value: T) => void; groups?: undefined }
  // A menu of several settings at once. It carries no single value, so the
  // trigger needs `label` — there is no one chosen option to print.
  | { groups: SortMenuGroup[]; value?: undefined; options?: undefined; onChange?: undefined }
)) {
  const { t } = useTranslation();
  const { ariaLabel = t("sort.label"), presentation = "inline", icon, label } = props;
  const compact = presentation === "icon";
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number | null; right: number | null; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // One code path for both shapes: a single-setting menu is a menu of one
  // unheaded group.
  const groups: SortMenuGroup[] = props.groups
    ? props.groups
    : [{ heading: "", value: props.value, options: props.options, onChange: props.onChange as (value: string) => void }];
  // What is chosen right now, for the tooltip and accessible name. With several
  // settings that is a list of them, since the trigger shows none of them.
  const currentLabel = groups
    .map((group) => group.options.find((option) => option.value === group.value)?.label ?? "")
    .filter(Boolean)
    .join(" · ");

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
          <span>{t("sort.sortBy")}</span>
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
          {groups.map((group, index) => {
            const items = group.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                className={group.value === option.value ? "active" : ""}
                onClick={() => { group.onChange(option.value); setOpen(false); }}
              >
                <span>{option.label}</span>
              </button>
            ));
            // A headed group is a real ARIA group, so a screen reader announces
            // "Tile size" before its choices rather than reading one flat list
            // of everything the menu holds. The visible heading is decorative —
            // the group's own label already carries the word.
            return group.heading ? (
              <div key={group.heading} role="group" aria-label={group.heading} className="audiobook-sort-group">
                <p className="audiobook-sort-heading" aria-hidden="true">{group.heading}</p>
                {items}
              </div>
            ) : (
              <React.Fragment key={index}>{items}</React.Fragment>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
