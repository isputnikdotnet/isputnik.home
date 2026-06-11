import React from "react";

// The single way to render a button. Variants map onto the button classes in
// styles/components.css — visual changes belong there, not here.
//
//   primary    gold call-to-action: Add / Save / Create / confirm non-destructive
//   secondary  outlined neutral: Cancel / Close / secondary actions
//   danger     filled destructive: Delete (used as the confirm in ConfirmDialog)
//   text       borderless inline action
//   icon       square icon-only button — pass aria-label or title
//
// `danger` modifier tints icon/text/secondary variants rose for destructive
// actions that don't warrant a filled danger button (e.g. row delete icons).
type Variant = "primary" | "secondary" | "danger" | "text" | "icon";

const variantClass: Record<Variant, string> = {
  primary: "primary-button",
  secondary: "secondary-button",
  danger: "danger-button",
  text: "text-button",
  icon: "icon-button"
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  danger?: boolean;
  compact?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", danger = false, compact = false, className, type = "button", ...rest },
  ref
) {
  const classes = [variantClass[variant], danger && "danger", compact && "compact-button", className]
    .filter(Boolean)
    .join(" ");
  return <button ref={ref} type={type} className={classes} {...rest} />;
});
