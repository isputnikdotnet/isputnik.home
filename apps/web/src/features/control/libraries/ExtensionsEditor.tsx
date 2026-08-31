import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

// Editable file-extension list — used for the scan/upload formats and for the
// upload-only companion files.
export function ExtensionsEditor({
  extensions,
  onChange,
  defaults,
  label,
  emptyHint
}: {
  extensions: string[];
  onChange: (extensions: string[]) => void;
  defaults: string[];
  label?: string;
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [draft, setDraft] = useState("");
  const resolvedLabel = label ?? t("control:libraries.extensionsLabel");
  const resolvedEmptyHint = emptyHint ?? t("control:libraries.extensionsEmptyHint");

  const addDraft = () => {
    const value = draft.trim().toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9]{1,10}$/.test(value)) return;
    if (!extensions.includes(value)) {
      onChange([...extensions, value]);
    }
    setDraft("");
  };

  return (
    <div className="field">
      <span>{resolvedLabel}</span>
      <div className="extension-chips">
        {extensions.map((extension) => (
          <span className="extension-chip" key={extension}>
            .{extension}
            <button
              type="button"
              aria-label={t("control:libraries.removeExtensionAria", { ext: extension })}
              onClick={() => onChange(extensions.filter((item) => item !== extension))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {extensions.length === 0 && <span className="muted">{resolvedEmptyHint}</span>}
      </div>
      <div className="extension-add-row">
        <input
          type="text"
          value={draft}
          placeholder={t("control:libraries.extensionPlaceholder")}
          maxLength={11}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
        />
        <button className="secondary-button compact-button" type="button" onClick={addDraft} disabled={!draft.trim()}>
          {t("control:ui.add")}
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => onChange([...defaults])}
          title={t("control:libraries.resetDefaultsTitle")}
        >
          {t("control:libraries.resetToDefaults")}
        </button>
      </div>
    </div>
  );
}
