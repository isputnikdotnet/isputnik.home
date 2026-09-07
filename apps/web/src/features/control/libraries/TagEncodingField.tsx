import { useTranslation } from "react-i18next";
import { SelectField } from "../../../shared/SelectField";

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
    <SelectField
      label={t("control:libraries.tagEncodingFieldLabel")}
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: resolvedNoneLabel },
        { value: "windows-1251", label: t("control:libraries.encodingWin1251") },
        { value: "windows-1250", label: t("control:libraries.encodingWin1250") },
        { value: "windows-1252", label: t("control:libraries.encodingWin1252") },
        { value: "koi8-r", label: t("control:libraries.encodingKoi8r") }
      ]}
      hint={value !== "" ? t("control:libraries.tagEncodingHint") : undefined}
    />
  );
}
