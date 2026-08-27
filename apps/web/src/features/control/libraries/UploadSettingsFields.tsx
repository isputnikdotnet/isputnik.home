import { useRef, useState } from "react";
import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LibraryMode } from "../../audiobooks/types";

// Upload policy settings. Uploads accept the same extensions as scanning; only the
// per-upload size limit is configured separately. "Custom limit" is tracked with its
// own `limited` flag (not derived from the value) so the number field stays editable
// while empty instead of snapping back to the default mid-edit; an empty/invalid value
// is restored to the last valid number on blur. Leaving it on the default applies a
// generous 10 GB per-file cap server-side, so a runaway upload can't fill the disk.
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
  const { t } = useTranslation(["common", "control"]);
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
      <span>{t("control:libraries.maxUploadSize")}</span>
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
              <strong>{t("control:libraries.uploadStandard")}</strong>
              <span className="upload-size-recommended">{t("control:libraries.recommended")}</span>
            </span>
            <small>{t("control:libraries.uploadStandardHint")}</small>
          </span>
          <span className="upload-size-infinity" aria-hidden="true">
            <HardDrive size={32} />
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
              <strong>{t("control:libraries.uploadCustomLimit")}</strong>
              <small>{t("control:libraries.uploadCustomHint")}</small>
            </span>
          </label>
          <div className="upload-size-custom-inputs">
            <label htmlFor="upload-mb-size">{t("control:libraries.sizeLabel")}</label>
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
            <select disabled aria-label={t("control:libraries.unitAria")}>
              <option value="MB">MB</option>
            </select>
          </div>
        </div>
      </div>
      {external && (
        <small className="muted">{t("control:libraries.externalReadOnlyHint")}</small>
      )}
    </div>
  );
}
