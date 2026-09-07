import { useId, type ReactNode } from "react";

// The dropdown a FORM asks a question with — one of a known list, inside a dialog or
// a settings page, sitting in the same column as the text fields around it.
//
// It stays a native <select>: the platform's own list is the one that knows about
// touch, typeahead, a hundred options and the phone's picker wheel, and the app
// declares `color-scheme` per theme so that list already comes up in the right one.
// What it adds is the part a bare select cannot have — a leading icon saying what
// the field is FOR, since the text can only say what is currently chosen — and one
// place to change how every one of them looks.
//
// Not to be confused with shared/SelectMenu, which is the TOOLBAR control: a custom
// popover that can carry an icon down every row and hang off the right edge of a
// browse bar. A form field wants neither.

export interface SelectFieldOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A named run of options — a native <optgroup>. Drawn after the loose options,
 *  which is where a "Choose someone…" placeholder belongs. */
export interface SelectFieldGroup<T extends string> {
  label: string;
  options: SelectFieldOption<T>[];
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  groups,
  onChange,
  icon,
  hint,
  disabled = false,
  hideLabel = false,
  className
}: {
  label: string;
  value: T;
  options: SelectFieldOption<T>[];
  /** Options under their own headings, after the loose ones. */
  groups?: SelectFieldGroup<T>[];
  onChange: (value: T) => void;
  /** What the field is for — a library, a span of time. Decorative: it never changes
   *  with the selection, so the label still carries the meaning. */
  icon?: ReactNode;
  /** A line under the control, for what the label has no room to say. */
  hint?: ReactNode;
  disabled?: boolean;
  /** The label is still read out; it just isn't drawn (a toolbar-tight row). */
  hideLabel?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={["field", "select-field", className].filter(Boolean).join(" ")}>
      <label className={hideLabel ? "sr-only" : undefined} htmlFor={id}>{label}</label>
      <div className="select-field-control">
        {icon && <span className="select-field-icon" aria-hidden="true">{icon}</span>}
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
          {/* An empty group still draws its heading in some browsers, so one with
              nothing left in it is dropped rather than rendered bare. */}
          {groups?.filter((group) => group.options.length > 0).map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}
