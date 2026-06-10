import type { LibraryMode } from "../../audiobooks/types";

// Upload policy settings. Uploads accept the same extensions as scanning; only the
// per-upload size limit is configured separately.
export function UploadSettingsFields({
  maxUploadMB,
  onChange,
  mode
}: {
  // Text value so the input can be cleared; "" = no limit.
  maxUploadMB: string;
  onChange: (value: string) => void;
  mode: LibraryMode;
}) {
  const external = mode === "external";
  return (
    <label className="field">
      <span>Max upload size (MB)</span>
      <input
        type="number"
        min={1}
        max={10240}
        value={maxUploadMB}
        placeholder="No limit"
        disabled={external}
        onChange={(event) => onChange(event.target.value)}
      />
      <small className="muted">
        {external
          ? "External libraries are read-only — uploads are disabled."
          : "Uploads accept the same file extensions as scanning. Leave empty for no limit."}
      </small>
    </label>
  );
}
