import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cx } from "./cx";
import { useAnchoredMenu } from "./useAnchoredMenu";
import { useMenuKeyboard } from "./useMenuKeyboard";

// The library picker used across the browse pages: a labelled tab that opens a menu
// of libraries. Styling lives on .audiobook-library-tab / .audiobook-library-menu in
// library-browse.css, so every copy of this control looks the same.
//
// The gallery, audiobook and ebook pages still inline their own version of this
// markup; this component is where they should converge.
//
// A library is one value out of several, so each entry is a menuitemradio with
// aria-checked — the same shape and keyboard as SortMenu (see useMenuKeyboard):
// focus opens on the current library, arrows walk the list, and Escape, Tab or a
// choice hand focus back to the trigger.

export interface LibraryMenuOption {
  value: string;
  label: string;
}

export function LibraryMenu({
  value,
  options,
  icon,
  label,
  onChange,
  disabled = false,
  className
}: {
  value: string;
  options: LibraryMenuOption[];
  icon?: React.ReactNode;
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  // Right-aligns when a left-aligned menu (library names run wide) would run off-screen.
  const { open, pos, toggle, close, triggerRef, menuRef } = useAnchoredMenu({ menuWidth: 240 });
  const menuKeys = useMenuKeyboard({ open: open && pos !== null, close, menuRef, triggerRef });
  const current = options.find((option) => option.value === value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx("audiobook-library-tab", className)}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
      >
        {icon}
        <span>{current?.label ?? label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu"
          role="menu"
          aria-label={label}
          onKeyDown={menuKeys.onKeyDown}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left ?? undefined,
            right: pos.right ?? undefined,
            minWidth: pos.width
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={option.value === value ? "active" : ""}
              onClick={() => { onChange(option.value); menuKeys.closeAndRestore(); }}
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
