import type { ReactNode } from "react";
import { Button } from "./Button";

// One of a few options, chosen inline: a joined row of segments, the chosen one
// filled (Logs' time range, the Dashboard's period, Security's exposure). The one
// way to draw that choice — not chips, not a tab row (a tab row switches pages).
// 32px, a control inside content (docs/UI-CONVENTIONS.md, Buttons). Each segment is
// a toggle button (aria-pressed) in a labelled group, which is what a screen reader
// expects of it; arrow keys aren't wired, since Tab already walks the few segments.
// DateRangePicker wears the same `segmented` look with its own "Custom…" segment.

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled = false, className }: {
  /** What the choice is about, read out for the group ("Period"). */
  label: string;
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={["segmented", className].filter(Boolean).join(" ")} role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          variant="bare"
          className={option.value === value ? "active" : undefined}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </Button>
      ))}
    </div>
  );
}
