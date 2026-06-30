// An on/off toggle switch — the single way to render a binary on/off control.
// Renders as an accessible button (role="switch"); visual styling lives in
// styles/components.css under .toggle-switch.
type ToggleSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // Visible text shown beside the switch. Omit and pass `ariaLabel` for an icon-only control.
  label?: string;
  ariaLabel?: string;
  className?: string;
};

export function ToggleSwitch({ checked, onChange, disabled = false, label, ariaLabel, className }: ToggleSwitchProps) {
  const classes = ["toggle-switch", className].filter(Boolean).join(" ");
  return (
    <span className={classes} data-disabled={disabled || undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? (label ? undefined : "Toggle")}
        disabled={disabled}
        className={`toggle-switch-track${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-switch-knob" aria-hidden="true" />
      </button>
      {label && (
        <span className="toggle-switch-label">{label}</span>
      )}
    </span>
  );
}
