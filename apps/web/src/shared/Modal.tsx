import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

// The single way to render a modal. Owns the backdrop, dismissal (backdrop
// click + Escape, both blocked while `busy`), focus, and dialog ARIA wiring so
// call sites only describe their content.
//
//   card   — compact centered card (.confirm-modal): title, body, action row.
//            Used for confirmations and small one-shot forms.
//   panel  — larger surface (.metadata-modal): header row with icon + title +
//            close button; children render below (tabs, scrollable content…).
//
// Pass `onSubmit` to render the dialog element as a <form>.
//
// What `aria-modal` promises, kept:
//   - Rendered through a portal into <body>, so no page container (a sticky bar,
//     a transformed card) can trap it in its stacking context. A modal opened from
//     inside something that already lives outside the app root — another modal, the
//     gallery lightbox, the reader — stays where it is rendered, inside that layer,
//     exactly as before: that layer's stacking and its CSS (e.g.
//     `.gallery-lightbox .modal-backdrop`) still apply.
//   - Open modals form a stack. Only the TOPMOST answers Escape and its backdrop,
//     so Escape in a ConfirmDialog opened over an editor cancels the confirm and
//     leaves the editor (and its form) alone.
//   - Tab / Shift+Tab wrap inside the topmost modal.
//   - On open, focus moves in: an `autoFocus` / `data-autofocus` control, else the
//     first control in the body, else the dialog itself. On close it returns to
//     whatever had it before the modal opened.
//   - While any modal is open the app root is `inert`, so neither the pointer, Tab,
//     nor a screen reader reaches the page behind it.

/** The element index.html gives React to mount the app into. */
const APP_ROOT_ID = "root";

interface ModalEntry {
  /** The modal this one was rendered inside, if any. */
  parent: ModalEntry | null;
  /** Portal container — placed in <body>, or in place for a modal outside the app root. */
  host: HTMLDivElement;
  dialog: HTMLElement | null;
  /** Where focus goes back to on close, in order of preference. */
  returnFocus: HTMLElement[];
  busy: boolean;
  onClose: () => void;
  mounted: boolean;
}

// ── The stack ─────────────────────────────────────────────────────────────────

const stack: ModalEntry[] = [];
let inertRoot: HTMLElement | null = null;

function isInside(entry: ModalEntry, ancestor: ModalEntry): boolean {
  for (let e = entry.parent; e; e = e.parent) if (e === ancestor) return true;
  return false;
}

function topModal(): ModalEntry | null {
  return stack[stack.length - 1] ?? null;
}

function pushModal(entry: ModalEntry) {
  // A modal goes on top — except below one rendered inside it. React runs a child's
  // effects before its parent's, so a parent that mounts together with an already-open
  // child registers second, and must not land above it.
  const firstChild = stack.findIndex((e) => isInside(e, entry));
  if (firstChild === -1) stack.push(entry);
  else stack.splice(firstChild, 0, entry);
  if (stack.length !== 1) return;
  document.addEventListener("keydown", onDocumentKeyDown);
  const root = document.getElementById(APP_ROOT_ID);
  if (root && !root.hasAttribute("inert")) {
    root.setAttribute("inert", "");
    inertRoot = root;
  }
}

function removeModal(entry: ModalEntry) {
  const index = stack.indexOf(entry);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length !== 0) return;
  document.removeEventListener("keydown", onDocumentKeyDown);
  inertRoot?.removeAttribute("inert");
  inertRoot = null;
}

function onDocumentKeyDown(event: KeyboardEvent) {
  const top = topModal();
  if (!top || event.defaultPrevented) return;
  if (event.key === "Escape") {
    // A control that consumed the key (an inline edit cancelling, a menu closing
    // itself with stopPropagation) has already handled it; so has an IME.
    if (event.isComposing || top.busy) return;
    event.preventDefault();
    top.onClose();
  } else if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    trapTab(event, top);
  }
}

// ── Focus ─────────────────────────────────────────────────────────────────────

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]"
].join(",");

function isVisible(el: HTMLElement): boolean {
  const check = (el as HTMLElement & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  // jsdom has no layout (and no checkVisibility); browsers all do now.
  return typeof check === "function" ? check.call(el, { checkVisibilityCSS: true, visibilityProperty: true }) : true;
}

/** The controls Tab visits inside `root`, in document order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert], [hidden]") && isVisible(el)
  );
  // A radio group is one tab stop: its checked radio, or its first when none is.
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const group = all.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement && other.type === "radio" && other.name === el.name && other.form === el.form
    );
    const checked = group.find((radio) => radio.checked);
    return checked ? checked === el : group[0] === el;
  });
}

function follows(a: Node, b: Node): boolean {
  return Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Focus is somewhere the topmost modal should take it back from on Tab: nowhere,
 *  the (inert) page, a modal underneath, or the layer this modal sits in. Anything
 *  else — a menu or picker portalled out of this dialog — is left to its own keys. */
function isStrayFocus(active: Element | null, entry: ModalEntry): boolean {
  if (!active || active === document.body || active === document.documentElement) return true;
  if (document.getElementById(APP_ROOT_ID)?.contains(active)) return true;
  if (layerOf(entry.host)?.contains(active)) return true;
  return stack.some((e) => e.host.contains(active));
}

/** The direct child of <body> that holds `node`. */
function layerOf(node: Node): Element | null {
  let current: Node | null = node;
  while (current && current.parentNode !== document.body) current = current.parentNode;
  return current instanceof Element ? current : null;
}

function trapTab(event: KeyboardEvent, entry: ModalEntry) {
  const dialog = entry.dialog;
  if (!dialog) return;
  const active = document.activeElement;
  const inside = Boolean(active && dialog.contains(active));
  if (!inside && !isStrayFocus(active, entry)) return;
  const items = tabbables(dialog);
  if (items.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!inside || !active) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  // Let the browser move between controls; step in only at the ends.
  const hasNext = event.shiftKey
    ? items.some((el) => el !== active && follows(active, el))
    : items.some((el) => el !== active && follows(el, active));
  if (!hasNext) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/** Where focus should go when the dialog opens and nothing inside asked for it. */
function initialFocusTarget(dialog: HTMLElement): HTMLElement {
  const marked = dialog.querySelector<HTMLElement>("[data-autofocus]");
  if (marked) return marked;
  // On a touch screen, focusing a field pops the keyboard over the dialog the
  // moment it opens. Focus the dialog itself: a screen reader still announces it.
  if (window.matchMedia?.("(pointer: coarse)").matches) return dialog;
  const items = tabbables(dialog);
  // A panel's first control is its header's ✕ — the one control not to start on,
  // since Enter there throws the form away.
  const header = Array.from(dialog.children).find(
    (child) => child.classList.contains("modal-header") || child.classList.contains("modal-title-row")
  );
  return items.find((el) => !header?.contains(el)) ?? items[0] ?? dialog;
}

function moveFocusInto(entry: ModalEntry) {
  const dialog = entry.dialog;
  if (!dialog) return;
  // A control with `autoFocus` has already taken it (React focuses on mount).
  if (dialog.contains(document.activeElement)) return;
  initialFocusTarget(dialog).focus({ preventScroll: true });
}

function captureReturnFocus(): HTMLElement[] {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return [];
  // Opened from inside another modal: if that one closes too, fall back to
  // whatever opened it.
  const owner = [...stack].reverse().find((e) => e.dialog?.contains(active));
  return [active, ...(owner?.returnFocus ?? [])];
}

function returnFocus(entry: ModalEntry) {
  const active = document.activeElement;
  // Something else took focus already (another dialog opening in its place).
  if (active && active !== document.body && active !== document.documentElement) return;
  const target = entry.returnFocus.find((el) => el.isConnected && !el.matches(":disabled") && !el.closest("[inert]"));
  if (target) target.focus({ preventScroll: true });
  else {
    const top = topModal();
    if (top) moveFocusInto(top);
  }
}

const ParentModal = createContext<ModalEntry | null>(null);

export function Modal({
  variant = "card",
  title,
  subtitle,
  icon,
  alert = false,
  busy = false,
  onClose,
  onSubmit,
  className,
  surfaceClassName,
  headerClassName,
  headerAction,
  style,
  children
}: {
  variant?: "card" | "panel";
  title: string;
  subtitle?: React.ReactNode;
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
  /** Optional action rendered in the modal header, such as a text Cancel button. */
  headerAction?: React.ReactNode;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const parent = useContext(ParentModal);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;

  const entryRef = useRef<ModalEntry | null>(null);
  if (!entryRef.current) {
    const host = document.createElement("div");
    host.setAttribute("data-modal-host", "");
    // No box of its own: the backdrop is fixed, and in place (inside the lightbox,
    // say) an extra grid/flex item would take a cell or a gap.
    host.style.display = "contents";
    entryRef.current = {
      parent,
      host,
      dialog: null,
      // Read while rendering, before an autoFocus inside moves it.
      returnFocus: captureReturnFocus(),
      busy,
      onClose,
      mounted: false
    };
  }
  const entry = entryRef.current;
  entry.busy = busy;
  entry.onClose = onClose;

  // Where the portal's container goes depends on where the modal is rendered, so a
  // throwaway anchor is rendered in place for one commit. React attaches refs and
  // performs `autoFocus` in tree order during the commit, and the anchor comes
  // before the portal: its ref puts the container into the document before a
  // control inside is focused (a detached element can't take focus). Modal.test's
  // "goes to an autoFocus control" fails if that ever stops holding.
  const [anchored, setAnchored] = useState(true);
  const placeHost = useCallback(
    (anchor: HTMLTemplateElement | null) => {
      if (!anchor || entry.host.isConnected) return;
      const appRoot = document.getElementById(APP_ROOT_ID);
      if (appRoot && anchor.isConnected && anchor.parentNode && !appRoot.contains(anchor)) {
        anchor.parentNode.insertBefore(entry.host, anchor.nextSibling);
      } else {
        document.body.appendChild(entry.host);
      }
    },
    [entry]
  );

  useLayoutEffect(() => {
    entry.mounted = true;
    pushModal(entry);
    moveFocusInto(entry);
    return () => {
      entry.mounted = false;
      removeModal(entry);
      // After the commit: the dialog is gone from the DOM by then, and a modal
      // closing underneath (or StrictMode re-running this effect) has settled.
      queueMicrotask(() => {
        if (entry.mounted) return;
        entry.host.remove();
        returnFocus(entry);
      });
    };
  }, [entry]);

  useLayoutEffect(() => {
    if (anchored) setAnchored(false);
  }, [anchored]);

  const setDialog = useCallback((el: HTMLElement | null) => {
    entry.dialog = el;
  }, [entry]);

  const dialogProps = {
    className: [surfaceClassName ?? (variant === "card" ? "confirm-modal" : "metadata-modal"), className]
      .filter(Boolean)
      .join(" "),
    role: alert ? "alertdialog" : "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    // Focusable, so it can hold focus when it has no controls (and a click on its
    // empty space doesn't drop focus to the page behind).
    tabIndex: -1,
    style,
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation()
  } as const;

  const header =
    variant === "panel" ? (
      <div className={["modal-header", headerClassName].filter(Boolean).join(" ")}>
        <div className="book-metadata-title">
          {icon && <span className="book-metadata-title-icon" aria-hidden="true">{icon}</span>}
          <div className="modal-title-copy">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
        </div>
        <div className="modal-header-actions">
          {headerAction}
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
      </div>
    ) : (
      headerAction || icon || subtitle ? (
        <div className="modal-title-row">
          <div className="modal-title-heading">
            {icon && <span className="modal-title-icon" aria-hidden="true">{icon}</span>}
            <div className="modal-title-copy">
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className="modal-subtitle">{subtitle}</p>}
            </div>
          </div>
          <div className="modal-title-action">{headerAction}</div>
        </div>
      ) : (
        <h2 id={titleId}>{title}</h2>
      )
    );

  const body = (
    <>
      {header}
      {children}
    </>
  );

  const backdrop = (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!busy && topModal() === entry) onClose();
      }}
    >
      {onSubmit ? (
        <form {...dialogProps} ref={setDialog} onSubmit={onSubmit}>{body}</form>
      ) : (
        <div {...dialogProps} ref={setDialog}>{body}</div>
      )}
    </div>
  );

  return (
    <>
      {anchored && <template ref={placeHost} />}
      {createPortal(<ParentModal.Provider value={entry}>{backdrop}</ParentModal.Provider>, entry.host)}
    </>
  );
}
