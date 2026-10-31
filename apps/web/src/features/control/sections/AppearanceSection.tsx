import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Palette } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ThemePicker, type Theme } from "../../../shared/ThemePicker";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { ControlSectionHead } from "../ControlSectionHead";
import { rememberSections, SECTION_KEYS, type SectionKey, type Sections } from "../../../app/sections";

// The menu's sections, in menu order, each labelled by its own nav word.
const SECTION_LABELS: Record<SectionKey, "nav.audiobooks" | "nav.ebooks" | "nav.gallery" | "nav.familyTree" | "nav.stories" | "nav.games" | "nav.video"> = {
  audiobooks: "nav.audiobooks",
  ebooks: "nav.ebooks",
  gallery: "nav.gallery",
  familyTree: "nav.familyTree",
  stories: "nav.stories",
  games: "nav.games",
  video: "nav.video"
};

// Settings › Appearance. Was the landing tab of the old Config page, which also
// hid Email and Reader access behind in-page tabs that had no URL of their own.
export function AppearanceSection() {
  const { t } = useTranslation(["common", "control"]);
  const [defaultTheme, setDefaultTheme] = useState<Theme | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [sections, setSections] = useState<Sections | null>(null);
  const [sectionsSaving, setSectionsSaving] = useState(false);
  const [sectionsSaved, setSectionsSaved] = useState(false);
  const [sectionsError, setSectionsError] = useState("");

  useEffect(() => {
    api<{ config: { defaultTheme: Theme; sections: Sections } }>("/api/config")
      .then((payload) => { setDefaultTheme(payload.config.defaultTheme); setSections(payload.config.sections); })
      .catch((err) => setError(err instanceof Error ? err.message : t("control:appearance.unableToLoad")));
  }, [t]);

  // One switch at a time, applied at once — the menu beside the page changes
  // with it (rememberSections) — then saved, and put back if the save fails.
  // The last section on cannot go: its switch is disabled below, and the
  // server refuses the same request.
  const toggleSection = async (key: SectionKey, on: boolean) => {
    if (!sections || sectionsSaving) return;
    const previous = sections;
    const next = { ...sections, [key]: on };
    setSections(next);
    setSectionsSaving(true);
    setSectionsSaved(false);
    setSectionsError("");
    try {
      const payload = await api<{ config: { sections: Sections } }>("/api/config", { method: "PATCH", body: JSON.stringify({ sections: next }) });
      setSections(payload.config.sections);
      rememberSections(payload.config.sections);
      setSectionsSaved(true);
    } catch (err) {
      setSections(previous);
      setSectionsError(err instanceof Error ? err.message : t("control:appearance.unableToSave"));
    } finally {
      setSectionsSaving(false);
    }
  };
  const sectionsOn = sections ? SECTION_KEYS.filter((key) => sections[key]).length : 0;

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

      <section className="config-block" id="sections">
        <h2>{t("control:appearance.sections")}</h2>
        <p className="muted">{t("control:appearance.sectionsHint")}</p>
        {sections && (
          <div className="sections-switches">
            {SECTION_KEYS.map((key) => (
              <ToggleSwitch
                key={key}
                checked={sections[key]}
                onChange={(on) => void toggleSection(key, on)}
                disabled={sectionsSaving || (sections[key] && sectionsOn === 1)}
                label={t(`common:${SECTION_LABELS[key]}`)}
                ariaLabel={t(`common:${SECTION_LABELS[key]}`)}
              />
            ))}
          </div>
        )}
        <p className="muted">{t("control:appearance.sectionsGamesHint")}</p>
        {sectionsSaved && <MessageBox tone="success" title={t("control:appearance.savedTitle")}>{t("control:appearance.sectionsSavedBody")}</MessageBox>}
        {sectionsError && <MessageBox tone="error" title={t("control:appearance.errorTitle")}>{sectionsError}</MessageBox>}
      </section>
    </>
  );
}
