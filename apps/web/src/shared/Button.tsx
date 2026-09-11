import React from "react";

// The single way to render a button. Two kinds of variant:
//
// Variants that OWN a look — each maps onto one class in the stylesheets, and
// visual changes belong there, not here:
//
//   primary    gold call-to-action: Add / Save / Create / confirm non-destructive
//   secondary  outlined neutral: Cancel / Close / secondary actions
//   danger     filled destructive: Delete (used as the confirm in ConfirmDialog)
//   text       borderless inline action
//   icon       square icon-only button — pass aria-label or title
//   toolbar    a browse-toolbar control (.library-toolbar-button in
//              library-browse.css); `className="primary"` for the toolbar's one
//              primary action, `danger` for a destructive one
//
// Variants that name WHAT the button is but carry no class of their own — the
// look is the caller's className (or the row that styles its buttons), passed
// through untouched. The codebase has no single tile or chip class; every
// surface drew its own, and these keep them exactly as they were:
//
//   tab        one tab of a role="tablist" row: role="tab", aria-selected from
//              `selected`, which also adds the `active` class every tab row
//              styles (`className="modal-tab"` in a dialog's .modal-tabs).
//              Left/Right/Home/End move focus along the row; Enter or Space
//              opens the tab, as a click does.
//   tile       a card, cover or photo that is itself the click target
//   chip       a small pill: a filter, a tag, a suggestion
//   bare       custom chrome with nothing in common to share — the media
//              player's transport, the reader's toolbar, the lightbox's own
//              buttons, a row whose container styles it
//
// `danger` modifier tints icon/text/secondary/toolbar variants rose for
// destructive actions that don't warrant a filled danger button (e.g. row delete
// icons). `className="accent-gold"` tints an icon button gold — the icon-only
// stand-in for a primary action inside a toolbar of icons (e.g. bulk "Edit
// metadata").
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "text"
  | "icon"
  | "toolbar"
  | "tab"
  | "tile"
  | "chip"
  | "bare";

const variantClass: Record<ButtonVariant, string | undefined> = {
  primary: "primary-button",
  secondary: "secondary-button",
  danger: "danger-button",
  text: "text-button",
  icon: "icon-button",
  toolbar: "library-toolbar-button",
  tab: undefined,
  tile: undefined,
  chip: undefined,
  bare: undefined
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  danger?: boolean;
  compact?: boolean;
  /** `tab` only: this tab's panel is the one showing. Sets aria-selected and the
   *  row's `active` class. Rows that mark the chosen tab with a class of their own
   *  (`is-active`, `is-on`) pass `aria-selected` and that class instead. */
  selected?: boolean;
};

// Arrow keys walk a tab row, as they do in every other tablist a screen reader
// user meets. Focus only — activation stays with Enter/Space (a click), so a tab
// whose panel loads data doesn't fetch on every key press on the way past.
function moveAlongTablist(event: React.KeyboardEvent<HTMLButtonElement>) {
  const list = event.currentTarget.closest('[role="tablist"]');
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
    (tab) => !tab.disabled && tab.closest('[role="tablist"]') === list
  );
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0 || tabs.length < 2) return;
  const target =
    event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
    : event.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length]
    : event.key === "Home" ? tabs[0]
    : event.key === "End" ? tabs[tabs.length - 1]
    : null;
  if (!target) return;
  event.preventDefault();
  target.focus();
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", danger = false, compact = false, selected, className, type = "button", onKeyDown, ...rest },
  ref
) {
  const isTab = variant === "tab";
  const classes = [variantClass[variant], danger && "danger", compact && "compact-button", className, isTab && selected && "active"]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type={type}
      // No class at all rather than class="" for a bare button its row styles.
      className={classes || undefined}
      role={isTab ? "tab" : undefined}
      aria-selected={isTab && selected !== undefined ? selected : undefined}
      onKeyDown={
        isTab
          ? (event) => {
              onKeyDown?.(event);
              if (!event.defaultPrevented) moveAlongTablist(event);
            }
          : onKeyDown
      }
      {...rest}
    />
  );
});
