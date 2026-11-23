import { useEffect, useId, useState, type ReactNode } from "react";

// An amount set by dragging, with the same number typed beside it for when it has
// to be exact (Videos › Video Streaming: memory for conversion, room for kept
// video). The slider covers the range most servers want; the typed number may go
// past its ends, to the limits the setting really has. Nothing is saved while it
// is dragged: `onCommit` runs when the handle is let go, or the number is left or
// Enter pressed — pages that save as they go save there. A value that is not a
// whole step, or is out of range, goes back to what it was.

export function SliderField({ icon, label, sub, value, unit, min, max, step = 1, hardMin = min, hardMax = max, minLabel, maxLabel, disabled = false, onCommit }: {
  icon?: ReactNode;
  label: string;
  sub?: ReactNode;
  value: number;
  /** After the number ("MB"). */
  unit: string;
  /** The slider's ends. */
  min: number;
  max: number;
  step?: number;
  /** What the typed number may be, where that is wider than the slider. */
  hardMin?: number;
  hardMax?: number;
  /** The ends, as they are named under the slider. */
  minLabel: ReactNode;
  maxLabel: ReactNode;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const labelId = useId();
  const [shown, setShown] = useState(value);
  const [typed, setTyped] = useState(String(value));
  useEffect(() => { setShown(value); setTyped(String(value)); }, [value]);

  const commit = (next: number) => {
    if (!Number.isInteger(next) || next < hardMin || next > hardMax) {
      setShown(value);
      setTyped(String(value));
      return;
    }
    if (next !== value) onCommit(next);
  };
  const commitTyped = () => commit(typed.trim() === "" ? Number.NaN : Number(typed));
  const dragTo = (next: number) => { setShown(next); setTyped(String(next)); };
  const percent = max > min ? Math.min(100, Math.max(0, ((shown - min) / (max - min)) * 100)) : 0;

  return (
    <div className={`slider-field${disabled ? " is-disabled" : ""}`}>
      <div className="slider-field-head">
        {icon && <span className="slider-field-icon" aria-hidden="true">{icon}</span>}
        <span className="slider-field-label">
          <strong id={labelId}>{label}</strong>
          {sub && <small>{sub}</small>}
        </span>
        <span className="slider-field-value">
          <input
            type="number"
            aria-labelledby={labelId}
            inputMode="numeric"
            value={typed}
            min={hardMin}
            max={hardMax}
            disabled={disabled}
            onChange={(event) => setTyped(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={commitTyped}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
          <span>{unit}</span>
        </span>
      </div>
      <input
        className="slider-field-range"
        type="range"
        aria-labelledby={labelId}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, shown))}
        disabled={disabled}
        style={{ "--slider-fill": `${percent}%` } as React.CSSProperties}
        onChange={(event) => dragTo(Number(event.target.value))}
        onPointerUp={() => commit(shown)}
        onKeyUp={() => commit(shown)}
        onBlur={() => commit(shown)}
      />
      <div className="slider-field-ends" aria-hidden="true">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  );
}
