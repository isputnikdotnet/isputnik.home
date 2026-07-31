import { useId } from "react";

// A radio group where each option carries its own explanation — for the handful
// of places that ask the user to pick between approaches (which second factor to
// use, …) rather than between bare values, which is SelectMenu's job.
// Options are rendered as cards so the description is part of the target.

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** Renders the option but blocks selecting it; explain why in `note`. */
  disabled?: boolean;
  note?: string;
}

export function ChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled = false
}: {
  legend: string;
  options: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();

  return (
    <fieldset className="choice-group">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`choice${value === option.value ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="choice-body">
            <span className="choice-label">{option.label}</span>
            {option.description && <span className="choice-description">{option.description}</span>}
            {option.note && <span className="choice-note">{option.note}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
