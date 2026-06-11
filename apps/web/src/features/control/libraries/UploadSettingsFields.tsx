import { useRef, useState } from "react";
import { Infinity as InfinityIcon } from "lucide-react";
import type { LibraryMode } from "../../audiobooks/types";

// Upload policy settings. Uploads accept the same extensions as scanning; only the
// per-upload size limit is configured separately. "Custom limit" is tracked with its
// own `limited` flag (not derived from the value) so the number field stays editable
// while empty instead of snapping back to "No limit" mid-edit; an empty/invalid value
// is restored to the last valid number on blur.
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
  const [limited, setLimited] = useState(maxUploadMB !== "");
  const [customMB, setCustomMB] = useState(maxUploadMB || "500");
  const lastValid = useRef(maxUploadMB || "500");

  const selectNoLimit = () => {
    setLimited(false);
    onChange("");
  };

  const selectCustom = () => {
    setLimited(true);
    onChange(customMB);
  };

  const changeCustom = (value: string) => {
    setCustomMB(value);
    onChange(value);
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) lastValid.current = value;
  };

  // Don't let "Custom limit" be left blank — fall back to the last valid number.
  const blurCustom = () => {
    const parsed = Number.parseInt(customMB, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setCustomMB(lastValid.current);
      onChange(lastValid.current);
    }
  };

  return (
    <div className="field">
      <span>Maximum upload size</span>
      <div className="upload-size-options">
        <label className={`upload-size-card${!limited ? " selected" : ""}${external ? " upload-size-card-disabled" : ""}`}>
          <input
            type="radio"
            name="upload-size-limit"
            checked={!limited}
            disabled={external}
            onChange={selectNoLimit}
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

        <div className={`upload-size-custom-section${limited ? " selected" : ""}${external ? " upload-size-card-disabled" : ""}`}>
          <label className="upload-size-custom-head">
            <input
              type="radio"
              name="upload-size-limit"
              checked={limited}
              disabled={external}
              onChange={selectCustom}
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
              value={customMB}
              disabled={!limited || external}
              onChange={(event) => changeCustom(event.target.value)}
              onBlur={blurCustom}
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
