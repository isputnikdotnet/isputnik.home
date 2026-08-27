import { useTranslation } from "react-i18next";

// Legacy tag-encoding select shared by the create wizard, edit dialog ("" = none),
// and the rescan dialog (pre-filled from the library's saved setting).
export function TagEncodingField({
  value,
  onChange,
  noneLabel
}: {
  value: string;
  onChange: (value: string) => void;
  noneLabel?: string;
}) {
  const { t } = useTranslation(["common", "control"]);
  const resolvedNoneLabel = noneLabel ?? t("control:libraries.tagEncodingNone");

  return (
    <label className="field">
      <span>{t("control:libraries.tagEncodingFieldLabel")}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{resolvedNoneLabel}</option>
        <option value="windows-1251">{t("control:libraries.encodingWin1251")}</option>
        <option value="windows-1250">{t("control:libraries.encodingWin1250")}</option>
        <option value="windows-1252">{t("control:libraries.encodingWin1252")}</option>
        <option value="koi8-r">{t("control:libraries.encodingKoi8r")}</option>
      </select>
      {value !== "" && (
        <small className="muted">
          {t("control:libraries.tagEncodingHint")}
        </small>
      )}
    </label>
  );
}
