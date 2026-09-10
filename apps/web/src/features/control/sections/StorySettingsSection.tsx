import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";

interface StorySettingsDto {
  recordingsLibrary: { id: string; name: string } | null;
  recipeImportEnabled: boolean;
  pendingNarrations?: number;
}

// Story settings: whether recipes may be read from a link, and where narration
// goes.
//
// Recordings land in the house's "App files" library (chosen on Library
// → Storage), under "Story recordings/<year>", as ordinary audio assets — so
// they show in the gallery, get backed up, and survive their story. The
// library used to be nominated here; this page now only says which it is.
// Narration recorded before that (kept inside the app, invisible to the
// gallery) moves itself into the library once one is set — the button that
// used to do it is gone (docs/app-storage-plan.md, decision 7).
export function StorySettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [library, setLibrary] = useState<{ id: string; name: string } | null>(null);
  const [recipeImport, setRecipeImport] = useState(true);
  const [pending, setPending] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    api<StorySettingsDto>("/api/stories/settings")
      .then((settings) => {
        setLibrary(settings.recordingsLibrary);
        setRecipeImport(settings.recipeImportEnabled);
        setPending(settings.pendingNarrations ?? 0);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:storySettings.loadFailed")))
      .finally(() => setLoading(false));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const payload = await api<StorySettingsDto>("/api/stories/settings", {
        method: "PUT",
        body: JSON.stringify({ recipeImportEnabled: recipeImport })
      });
      setLibrary(payload.recordingsLibrary);
      setRecipeImport(payload.recipeImportEnabled);
      setPending(payload.pendingNarrations ?? 0);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  const galleryPath = controlHref("storage");

  return (
    <>
      <ControlSectionHead
        section="storySettings"
        icon={<Mic size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:storySettings.headDescription")}
      />

      <section className="config-block">
        <p className="muted">{t("controlAdmin:storySettings.intro")}</p>

        {loadError && <MessageBox tone="error" title={t("controlAdmin:storySettings.settingsTitle")}>{loadError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form className="mail-form" onSubmit={save}>
            <p>
              {library
                ? t("controlAdmin:storySettings.houseLibraryIs", { name: library.name })
                : t("controlAdmin:storySettings.houseLibraryUnset")}
              {" "}
              <a href={galleryPath} onClick={(event) => followRoute(event, galleryPath)}>
                {t("controlAdmin:storySettings.houseLibraryLink")}
              </a>
            </p>
            {pending > 0 && (
              <p className="muted">
                {library
                  ? t("controlAdmin:storySettings.pendingAuto", { count: pending })
                  : t("controlAdmin:storySettings.pendingWaiting", { count: pending })}
              </p>
            )}

            <label className="mail-check">
              <input
                type="checkbox"
                checked={recipeImport}
                onChange={(event) => setRecipeImport(event.target.checked)}
                disabled={saving}
              />
              <span>{t("controlAdmin:storySettings.recipeImportLabel")}</span>
            </label>
            <p className="muted">{t("controlAdmin:storySettings.recipeImportNote")}</p>

            {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:storySettings.savedBody")}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
