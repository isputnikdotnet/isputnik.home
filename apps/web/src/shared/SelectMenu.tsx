import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "./Button";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

export function SelectMenu<T extends string>({
  value,
  options,
  label,
  onChange,
  className,
  triggerIcon
}: {
  value: T;
  options: SelectMenuOption<T>[];
  label: string;
  onChange: (value: T) => void;
  className?: string;
  /** Says what the menu is FOR, on the trigger, where the text can only say what is
   *  currently chosen. Distinct from an option's own icon: this one never changes with
   *  the selection and never appears in the list, so a menu can be named without
   *  repeating one glyph down every row of its popover. */
  triggerIcon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const hasIcons = options.some((option) => option.icon);

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
    <div ref={rootRef} className={["select-menu", className].filter(Boolean).join(" ")}>
      <Button
        variant="secondary"
        className="select-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // The visible text is the chosen VALUE, which on its own doesn't say what it
        // is a value of — "Recently deleted" could be anything. Naming the trigger
        // matters most where an icon has replaced a written prefix.
        title={label}
        aria-label={selected ? `${label}: ${selected.label}` : label}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerIcon && <span className="select-menu-trigger-icon" aria-hidden="true">{triggerIcon}</span>}
        {selected?.icon && <span className="select-menu-trigger-icon" aria-hidden="true">{selected.icon}</span>}
        <span>{selected?.label ?? label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>

      {open && (
        <div id={menuId} className="select-menu-popover" role="listbox" aria-label={label}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <Button
                key={option.value}
                variant="text"
                className={`select-menu-option${hasIcons ? "" : " no-icon"}${active ? " active" : ""}`}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="select-menu-check" aria-hidden="true">
                  {active && <Check size={16} />}
                </span>
                {/* The row is a fixed grid, so the icon cell has to exist for every
                    option once any option has one — otherwise the label slides into
                    the icon column and gets clipped to its width. */}
                {hasIcons && (
                  <span className="select-menu-option-icon" aria-hidden="true">{option.icon}</span>
                )}
                <span>{option.label}</span>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
