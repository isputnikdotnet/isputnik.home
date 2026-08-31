import { useTranslation } from "react-i18next";

// Free-text partial-date field: "1971", "1971-09", or "1971-09-01". Native date
// inputs can't express year-only dates — the norm for both genealogy data and
// an author's dates — and silently blank out stored partial values, so every
// date on that convention goes through this instead. The server validates the
// YYYY[-MM[-DD]] shape (partialDateSchema).
export function PartialDateField({
  label,
  value,
  placeholder,
  className,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  // Lets a caller place the field in its own layout — the person editor puts it
  // on the book metadata dialog's grid.
  className?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <label className={["field", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder ?? t("partialDate.example.default")}
        pattern="\d{4}(-\d{2}(-\d{2})?)?"
        title={t("partialDate.formatHint")}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
