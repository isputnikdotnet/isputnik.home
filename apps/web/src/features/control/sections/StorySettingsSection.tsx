import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Mic } from "lucide-react";
import { api } from "../../../api";
import { GroupedList, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";
import { storageHref } from "../links";

interface StorySettingsDto {
  recordingsLibrary: { id: string; name: string } | null;
  recipeImportEnabled: boolean;
  pendingNarrations?: number;
}

// Story settings: whether recipes may be read from a link, and where narration
// goes. Grouped rows, saved as they change (control panel v2).
//
// Recordings land in the house's "App files" library (chosen on Library
// → Storage), under "Story recordings/<year>", as ordinary audio assets — so
// they show in the gallery, get backed up, and survive their story. The
// library used to be nominated here; this page now only says which it is and
// leads to where it is chosen. Narration recorded before that (kept inside the
// app, invisible to the gallery) moves itself into the library once one is set
// (docs/app-storage-plan.md, decision 7).
export function StorySettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [library, setLibrary] = useState<{ id: string; name: string } | null>(null);
  const [recipeImport, setRecipeImport] = useState(true);
  const [pending, setPending] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const apply = (settings: StorySettingsDto) => {
    setLibrary(settings.recordingsLibrary);
    setRecipeImport(settings.recipeImportEnabled);
    setPending(settings.pendingNarrations ?? 0);
  };

  useEffect(() => {
    api<StorySettingsDto>("/api/stories/settings")
      .then(apply)
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:storySettings.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const changeRecipeImport = async (next: boolean) => {
    setRecipeImport(next);
    setSaving(true);
    setSaveError("");
    try {
      apply(await api<StorySettingsDto>("/api/stories/settings", {
        method: "PUT",
        body: JSON.stringify({ recipeImportEnabled: next })
      }));
    } catch (err) {
      setRecipeImport(!next);
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  const pendingNote = pending > 0
    ? (library
      ? t("controlAdmin:storySettings.pendingAuto", { count: pending })
      : t("controlAdmin:storySettings.pendingWaiting", { count: pending }))
    : null;

  return (
    <>
      <ControlSectionHead
        section="storySettings"
        icon={<Mic size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:storySettings.headDescription")}
      />

      <div className="grouped-page">
        {loadError && <MessageBox tone="error" title={t("controlAdmin:storySettings.settingsTitle")}>{loadError}</MessageBox>}
        {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <>
            <GroupedList
              title={t("controlAdmin:storySettings.recordingsGroup")}
              note={<>{t("controlAdmin:storySettings.intro")}{pendingNote && <><br /><br />{pendingNote}</>}</>}
            >
              {/* Chosen on System Settings › Storage's App storage card. */}
              <NavRow
                icon={<FolderOpen size={17} />}
                iconTone={library ? "ok" : "warn"}
                label={t("controlAdmin:storySettings.recordingsRow")}
                value={library ? library.name : t("controlAdmin:storySettings.notSet")}
                valueTone={library ? undefined : "warn"}
                href={storageHref("app-storage")}
              />
            </GroupedList>

            <GroupedList title={t("controlAdmin:storySettings.recipesGroup")} note={t("controlAdmin:storySettings.recipeImportNote")}>
              <ToggleRow
                label={t("controlAdmin:storySettings.recipeImportLabel")}
                checked={recipeImport}
                disabled={saving}
                onChange={(next) => void changeRecipeImport(next)}
              />
            </GroupedList>
          </>
        )}
      </div>
    </>
  );
}
