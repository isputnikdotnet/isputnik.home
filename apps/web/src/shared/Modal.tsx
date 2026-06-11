import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

// The single way to render a modal. Owns the backdrop, dismissal (backdrop
// click + Escape, both blocked while `busy`), and dialog ARIA wiring so call
// sites only describe their content.
//
//   card   — compact centered card (.confirm-modal): title, body, action row.
//            Used for confirmations and small one-shot forms.
//   panel  — larger surface (.metadata-modal): header row with icon + title +
//            close button; children render below (tabs, scrollable content…).
//
// Pass `onSubmit` to render the dialog element as a <form>.
export function Modal({
  variant = "card",
  title,
  icon,
  alert = false,
  busy = false,
  onClose,
  onSubmit,
  className,
  surfaceClassName,
  headerClassName,
  style,
  children
}: {
  variant?: "card" | "panel";
  title: string;
  icon?: React.ReactNode;
  /** role="alertdialog" — use for destructive confirmations. */
  alert?: boolean;
  /** Blocks backdrop/Escape/close-button dismissal while an action runs. */
  busy?: boolean;
  onClose: () => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  className?: string;
  /** Replaces the variant's default surface class for bespoke layout CSS (rare). */
  surfaceClassName?: string;
  /** Extra class on the panel header row (e.g. "book-metadata-header"). */
  headerClassName?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const dialogProps = {
    className: [surfaceClassName ?? (variant === "card" ? "confirm-modal" : "metadata-modal"), className]
      .filter(Boolean)
      .join(" "),
    role: alert ? "alertdialog" : "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    style,
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation()
  } as const;

  const header =
    variant === "panel" ? (
      <div className={["modal-header", headerClassName].filter(Boolean).join(" ")}>
        <div className="book-metadata-title">
          {icon && <span className="book-metadata-title-icon" aria-hidden="true">{icon}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>
    ) : (
      <h2 id={titleId}>{title}</h2>
    );

  const body = (
    <>
      {header}
      {children}
    </>
  );

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      {onSubmit ? (
        <form {...dialogProps} onSubmit={onSubmit}>{body}</form>
      ) : (
        <div {...dialogProps}>{body}</div>
      )}
    </div>
  );
}
