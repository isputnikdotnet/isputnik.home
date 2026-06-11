import { useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  minLength,
  autoComplete,
  placeholder,
  required = true
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  minLength?: number;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useMemo(() => label.toLowerCase().replace(/\s+/g, "-"), [label]);
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const effectiveType = isPassword && revealed ? "text" : type;

  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <div className={`field-input-wrap${isPassword ? " has-reveal" : ""}`}>
        <input
          id={id}
          type={effectiveType}
          value={value}
          minLength={minLength}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          required={required}
        />
        {isPassword && (
          <button
            type="button"
            className="field-reveal"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            tabIndex={-1}
          >
            {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
    </label>
  );
}
