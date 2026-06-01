import { useMemo } from "react";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  minLength,
  autoComplete,
  required = true
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  minLength?: number;
  autoComplete?: string;
  required?: boolean;
}) {
  const id = useMemo(() => label.toLowerCase().replace(/\s+/g, "-"), [label]);

  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        minLength={minLength}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </label>
  );
}
