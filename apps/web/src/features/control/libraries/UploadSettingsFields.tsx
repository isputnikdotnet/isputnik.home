import { useState } from "react";
import { Infinity as InfinityIcon } from "lucide-react";
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
  const [localCustomMB, setLocalCustomMB] = useState("500");
  const external = mode === "external";
  const hasLimit = maxUploadMB !== "";
  const displayMB = hasLimit ? maxUploadMB : localCustomMB;

  const handleCustomChange = (value: string) => {
    setLocalCustomMB(value);
    if (hasLimit) onChange(value);
  };

  return (
    <div className="field">
      <span>Maximum upload size</span>
      <div className="upload-size-options">
        <label className={`upload-size-card${!hasLimit ? " selected" : ""}${external ? " upload-size-card-disabled" : ""}`}>
          <input
            type="radio"
            name="upload-size-limit"
            checked={!hasLimit}
            disabled={external}
            onChange={() => onChange("")}
          />
          <span className="upload-size-card-body">
            <span className="upload-size-card-title">
              <strong>No limit</strong>
              <span className="upload-size-recommended">Recommended</span>
            </span>
            <small>There is no limit on file upload size.</small>
          </span>
          <span className="upload-size-infinity" aria-hidden="true">
            <InfinityIcon size={32} />
          </span>
        </label>

        <div className={`upload-size-custom-section${hasLimit ? " selected" : ""}${external ? " upload-size-card-disabled" : ""}`}>
          <label className="upload-size-custom-head">
            <input
              type="radio"
              name="upload-size-limit"
              checked={hasLimit}
              disabled={external}
              onChange={() => onChange(localCustomMB)}
            />
            <span className="upload-size-card-body">
              <strong>Custom limit</strong>
              <small>Set a maximum size for each file.</small>
            </span>
          </label>
          <div className="upload-size-custom-inputs">
            <label htmlFor="upload-mb-size">Size</label>
            <input
              id="upload-mb-size"
              type="number"
              min={1}
              max={10240}
              value={displayMB}
              disabled={!hasLimit || external}
              onChange={(event) => handleCustomChange(event.target.value)}
            />
            <select disabled aria-label="Unit">
              <option value="MB">MB</option>
            </select>
          </div>
        </div>
      </div>
      {external && (
        <small className="muted">External libraries are read-only — uploads are disabled.</small>
      )}
    </div>
  );
}
