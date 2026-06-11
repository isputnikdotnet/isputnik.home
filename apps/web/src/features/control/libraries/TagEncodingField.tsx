// Legacy tag-encoding select shared by the create wizard, edit dialog ("" = none),
// and the rescan dialog (pre-filled from the library's saved setting).
export function TagEncodingField({
  value,
  onChange,
  noneLabel = "None — leave tags as-is"
}: {
  value: string;
  onChange: (value: string) => void;
  noneLabel?: string;
}) {
  return (
    <label className="field">
      <span>Tag text encoding</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{noneLabel}</option>
        <option value="windows-1251">Windows-1251 (Cyrillic)</option>
        <option value="windows-1250">Windows-1250 (Central European)</option>
        <option value="windows-1252">Windows-1252 (Western European)</option>
        <option value="koi8-r">KOI8-R (Cyrillic)</option>
      </select>
      {value !== "" && (
        <small className="muted">
          Repairs garbled tag text (e.g. "Ðàíåå" → "Ранее") for files whose tags were saved in this
          legacy encoding. Correctly stored tags are left untouched.
        </small>
      )}
    </label>
  );
}
