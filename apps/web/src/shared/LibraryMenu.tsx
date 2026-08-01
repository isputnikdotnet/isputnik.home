import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

// The library picker used across the browse pages: a labelled tab that opens a menu
// of libraries. Styling lives on .audiobook-library-tab / .audiobook-library-menu in
// library-browse.css, so every copy of this control looks the same.
//
// The gallery, audiobook and ebook pages still inline their own version of this
// markup; this component is where they should converge.

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
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number | null; right: number | null; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  const toggle = () => {
    setOpen((isOpen) => {
      if (!isOpen && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        // Right-align when a left-aligned menu would run off-screen.
        const alignRight = rect.left + 240 > window.innerWidth;
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={["audiobook-library-tab", className].filter(Boolean).join(" ")}
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
              role="menuitem"
              className={option.value === value ? "active" : ""}
              onClick={() => { onChange(option.value); setOpen(false); }}
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
