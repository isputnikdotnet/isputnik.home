import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  minLength,
  min,
  max,
  autoComplete,
  placeholder,
  required = true
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  minLength?: number;
  /** Numeric bounds — only meaningful for type="number". Enforced by the browser
   *  on submit; the server clamps anyway, since a typed number is client input. */
  min?: number;
  max?: number;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const { t } = useTranslation();
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
          min={min}
          max={max}
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
            aria-label={revealed ? t("common.hidePassword") : t("common.showPassword")}
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
