// Free-text partial-date field: "1971", "1971-09", or "1971-09-01". Native
// date inputs can't express year-only dates — the norm for genealogy data — and
// silently blank out stored partial values, so every family-tree date goes
// through this instead. The server validates the YYYY[-MM[-DD]] shape.
export function PartialDateField({
  label,
  value,
  placeholder = "1971 or 1971-09-01",
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        pattern="\d{4}(-\d{2}(-\d{2})?)?"
        title="Year, year-month, or full date (1971, 1971-09, 1971-09-01)"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
