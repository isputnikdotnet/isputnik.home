import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Palette } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ThemePicker, type Theme } from "../../../shared/ThemePicker";
import { ControlSectionHead } from "../ControlSectionHead";

// Settings › Appearance. Was the landing tab of the old Config page, which also
// hid Email and Reader access behind in-page tabs that had no URL of their own.
export function AppearanceSection() {
  const { t } = useTranslation(["common", "control"]);
  const [defaultTheme, setDefaultTheme] = useState<Theme | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ config: { defaultTheme: Theme } }>("/api/config")
      .then((payload) => setDefaultTheme(payload.config.defaultTheme))
      .catch((err) => setError(err instanceof Error ? err.message : t("control:appearance.unableToLoad")));
  }, [t]);

  const choose = async (theme: Theme) => {
    if (saving || theme === defaultTheme) return;
    const previous = defaultTheme;
    setDefaultTheme(theme);
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ defaultTheme: theme }) });
      setSaved(true);
    } catch (err) {
      setDefaultTheme(previous);
      setError(err instanceof Error ? err.message : t("control:appearance.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="appearance"
        icon={<Palette size={30} />}
        iconClassName="blue"
        description={t("control:appearance.description")}
      />

      <section className="config-block">
        <h2>{t("control:appearance.defaultTheme")}</h2>
        <p className="muted">
          {t("control:appearance.defaultThemeHint")}
        </p>
        {defaultTheme && <ThemePicker value={defaultTheme} onChange={choose} disabled={saving} />}
        {saved && <MessageBox tone="success" title={t("control:appearance.savedTitle")}>{t("control:appearance.savedBody")}</MessageBox>}
        {error && <MessageBox tone="error" title={t("control:appearance.errorTitle")}>{error}</MessageBox>}
      </section>
    </>
  );
}
