import { useEffect, useState } from "react";
import { BookOpen, Mail, Palette, Settings, type LucideIcon } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ThemePicker, type Theme } from "../../../shared/ThemePicker";
import { MailSection } from "./MailSection";
import { OpdsAccessSection } from "./OpdsAccessSection";

type ConfigTab = "appearance" | "email" | "reader";

const CONFIG_TABS: { key: ConfigTab; label: string; icon: LucideIcon }[] = [
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "email", label: "Email", icon: Mail },
  { key: "reader", label: "Reader access", icon: BookOpen }
];

export function ConfigSection() {
  const [defaultTheme, setDefaultTheme] = useState<Theme | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<ConfigTab>("appearance");

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
        <div className="user-title-wrap">
          <span className="user-page-icon" aria-hidden="true">
            <Settings size={30} />
          </span>
          <div className="user-heading-copy">
            <p className="eyebrow">Application</p>
            <h1>Config</h1>
            <p className="section-description">Appearance, email delivery, and reader access.</p>
          </div>
        </div>
      </div>

      <div className="control-tabs config-tabs" role="tablist" aria-label="Configuration sections">
        {CONFIG_TABS.map((tab) => {
          const selected = activeTab === tab.key;
          const Icon = tab.icon;
          return (
            <Button
              key={tab.key}
              variant="text"
              className={`config-tab${selected ? " active" : ""}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`config-panel-${tab.key}`}
              id={`config-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon className="config-tab-icon" size={18} aria-hidden="true" />
              <span>{tab.label}</span>
            </Button>
          );
        })}
      </div>

      <div className="config-tab-panels">
        <div
          className="config-tab-panel"
          role="tabpanel"
          id="config-panel-appearance"
          aria-labelledby="config-tab-appearance"
          hidden={activeTab !== "appearance"}
        >
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
        </div>

        <div
          className="config-tab-panel"
          role="tabpanel"
          id="config-panel-email"
          aria-labelledby="config-tab-email"
          hidden={activeTab !== "email"}
        >
          <MailSection />
        </div>

        <div
          className="config-tab-panel"
          role="tabpanel"
          id="config-panel-reader"
          aria-labelledby="config-tab-reader"
          hidden={activeTab !== "reader"}
        >
          <OpdsAccessSection />
        </div>
      </div>
    </>
  );
}
