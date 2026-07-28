import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** Disables the item; shown as its tooltip so the user learns why. */
  disabledReason?: string;
  onSelect: () => void;
}

// A button that opens a popover of one-shot actions — the action sibling of
// SelectMenu (which tracks a persistent value). Use it when several related
// actions would otherwise each need their own button.
export function ActionMenu({
  label,
  icon,
  items,
  compact = false,
  className
}: {
  label: string;
  icon?: React.ReactNode;
  items: ActionMenuItem[];
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={["select-menu", "action-menu", className].filter(Boolean).join(" ")}>
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

      {open && (
        <div id={menuId} className="select-menu-popover" role="menu" aria-label={label}>
          {items.map((item) => (
            <Button
              key={item.key}
              variant="text"
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
        </div>
      )}
    </div>
  );
}
