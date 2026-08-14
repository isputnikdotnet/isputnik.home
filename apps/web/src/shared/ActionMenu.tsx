import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MoreVertical } from "lucide-react";
import { Button } from "./Button";

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** Disables the item; shown as its tooltip so the user learns why. */
  disabledReason?: string;
  /** Destructive: tinted rose, the way a danger icon button is. Still confirmed
   *  by whatever dialog the action opens — the tint is a warning, not a guard. */
  danger?: boolean;
  onSelect: () => void;
}

// A button that opens a popover of one-shot actions — the action sibling of
// SelectMenu (which tracks a persistent value). Use it when several related
// actions would otherwise each need their own button.
//
// `trigger="icon"` is the data-grid form: a square ⋮ button instead of a labelled
// one. A table row can carry half a dozen actions, and as icon buttons they are a
// wall of unlabelled glyphs whose meaning lives in tooltips; collapsed into this,
// each one gets its name back.
export function ActionMenu({
  label,
  icon,
  items,
  compact = false,
  trigger = "button",
  className
}: {
  label: string;
  icon?: React.ReactNode;
  items: ActionMenuItem[];
  compact?: boolean;
  trigger?: "button" | "icon";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // The popover is rendered into <body> rather than beside the trigger, because a
  // menu inside a data grid is inside `.datagrid-wrap`, which needs overflow-x for
  // wide tables and therefore clips anything escaping the row. Portalling sidesteps
  // every such ancestor at once; the cost is positioning it by hand, below.
  const place = useCallback(() => {
    const trigger = rootRef.current?.querySelector("button");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = popoverRef.current?.offsetHeight ?? 0;
    const width = popoverRef.current?.offsetWidth ?? 0;
    // Flip above the trigger when there isn't room below — a row near the bottom of
    // a long table is the common case, not the exception.
    const below = window.innerHeight - rect.bottom;
    const flip = height > 0 && below < height + 16 && rect.top > below;
    // Left-aligned to the trigger, which is what this menu did before it was
    // portalled, unless that would run it off the right edge — the ⋮ in a table's
    // last column always would. Same rule the old `.align-right` class encoded.
    const overflowsRight = width > 0 && rect.left + width > window.innerWidth - 8;
    setAnchor({
      top: flip ? rect.top - height - 6 : rect.bottom + 6,
      ...(overflowsRight
        ? { right: Math.max(8, window.innerWidth - rect.right) }
        : { left: Math.max(8, rect.left) })
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    // Follow the trigger rather than closing: scrolling a table with a menu open is
    // ordinary, and a menu that vanishes mid-scroll reads as a bug. Capture, so a
    // scroll on any ancestor counts.
    const onReflow = () => place();

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, place]);

  return (
    <div
      ref={rootRef}
      className={["select-menu", "action-menu", trigger === "icon" && "action-menu-icon", className]
        .filter(Boolean)
        .join(" ")}
    >
      {trigger === "icon" ? (
        <Button
          variant="icon"
          title={label}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <MoreVertical size={15} aria-hidden="true" />
        </Button>
      ) : (
        <Button
          variant="secondary"
          compact={compact}
          className="select-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {icon && <span className="select-menu-trigger-icon" aria-hidden="true">{icon}</span>}
          <span>{label}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      )}

      {open && createPortal(
        <div
          ref={popoverRef}
          id={menuId}
          className="select-menu-popover action-menu-popover"
          role="menu"
          aria-label={label}
          // Hidden until measured, or the first paint lands at the page corner and
          // jumps into place.
          style={anchor ? { top: anchor.top, left: anchor.left, right: anchor.right } : { visibility: "hidden" }}
        >
          {items.map((item) => (
            <Button
              key={item.key}
              variant="text"
              danger={item.danger}
              className="select-menu-option action-menu-option"
              role="menuitem"
              disabled={item.disabledReason != null}
              title={item.disabledReason}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && <span className="select-menu-option-icon" aria-hidden="true">{item.icon}</span>}
              <span>{item.label}</span>
            </Button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
