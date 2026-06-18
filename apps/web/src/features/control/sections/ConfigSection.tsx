import { useEffect, useState } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ThemePicker, type Theme } from "../../../shared/ThemePicker";
import { OpdsAccessSection } from "./OpdsAccessSection";

export function ConfigSection() {
  const [defaultTheme, setDefaultTheme] = useState<Theme | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ config: { defaultTheme: Theme } }>("/api/config")
      .then((payload) => setDefaultTheme(payload.config.defaultTheme))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load configuration"));
  }, []);

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
      setError(err instanceof Error ? err.message : "Unable to save configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Application</p>
          <h1>Config</h1>
        </div>
      </div>

      <section className="config-block">
        <h2>Default theme</h2>
        <p className="muted">
          The look the sign-in screen uses and the theme new members start with. Each member can still change their own
          appearance under the Theme menu.
        </p>
        {defaultTheme && <ThemePicker value={defaultTheme} onChange={choose} disabled={saving} />}
        {saved && <MessageBox tone="success" title="Saved">Default theme updated.</MessageBox>}
        {error && <MessageBox tone="error" title="Config error">{error}</MessageBox>}
      </section>

      <OpdsAccessSection />
    </>
  );
}
