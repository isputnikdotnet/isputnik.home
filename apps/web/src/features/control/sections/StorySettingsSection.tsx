import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChefHat, FolderOpen, HardDrive, Mic, Route } from "lucide-react";
import { api } from "../../../api";
import { GroupedList, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { ControlSectionHead } from "../ControlSectionHead";
import { MapFeatures } from "./maps/MapFeatures";
import type { MapSettingsDto, RoutingDto } from "./maps/map-settings";
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
  const { t: tc } = useTranslation(["control"]);
  const [loading, setLoading] = useState(true);
  // Whether road routes have a key, as the routes list below reads it.
  const [routes, setRoutes] = useState<boolean | null>(null);
  const loaded = useCallback((_status: MapSettingsDto, routing: RoutingDto["routing"]) => setRoutes(routing.hasApiKey), []);
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

  // Gallery's Settings shape (owner, 2026-11-19): cards of what each list below is
  // set to, then Narration, Recipes and Road routes as titled lists, and beside them
  // where recordings are kept.
  const dash = "—";
  const tiles: StatTile[] = [
    {
      icon: <Mic size={19} />, iconTone: library ? "ok" : "warn", label: tc("control:appSetup.overview.recordingsTo"),
      value: loading ? dash : library ? library.name : tc("control:appSetup.overview.notSet"), tone: loading || library ? undefined : "warn"
    },
    {
      icon: <ChefHat size={19} />, iconTone: recipeImport ? "ok" : "blue", label: tc("control:appSetup.overview.recipeImport"),
      value: loading ? dash : recipeImport ? tc("control:appSetup.overview.on") : tc("control:appSetup.overview.off")
    },
    {
      icon: <Route size={19} />, iconTone: routes ? "ok" : "blue", label: tc("control:appSetup.overview.roadRoutes"),
      value: routes === null ? dash : routes ? tc("control:appSetup.overview.on") : tc("control:appSetup.overview.off")
    }
  ];

  return (
    <>
      <ControlSectionHead
        section="storySettings"
        icon={<Mic size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:storySettings.headDescription")}
      />
      {loadError && <MessageBox tone="error" title={t("controlAdmin:storySettings.settingsTitle")}>{loadError}</MessageBox>}
      {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}

      <div className="diag-video app-overview-v3">
        <div className="diag-video-main">
          <section className="diag-tiles" aria-labelledby="story-settings-tiles-title">
            <header className="diag-tiles-head">
              <h3 id="story-settings-tiles-title">{tc("control:appSetup.overview.tilesTitle")}</h3>
            </header>
            <StatTiles tiles={tiles} label={tc("control:appSetup.overview.tilesTitle")} />
          </section>

          {loading ? (
            <p className="muted">{t("controlAdmin:ui.loading")}</p>
          ) : (
            <>
              <GroupedList title={t("controlAdmin:storySettings.recordingsGroup")}
                note={<>{t("controlAdmin:storySettings.intro")}{pendingNote && <><br /><br />{pendingNote}</>}</>}>
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
          {/* Road routes draw a story's route along real roads: Stories', moved here
              from Gallery › Settings (2026-11-19). */}
          <MapFeatures plain only={["routes"]} onLoaded={loaded} />
        </div>
        <aside className="diag-video-side">
          <GroupedList title={tc("control:settingsPage.whereTitle")} note={tc("control:settingsPage.storiesWhereNote")}>
            <NavRow icon={<HardDrive size={17} />} label={tc("control:settingsPage.storiesWhere")} href={storageHref("app-storage")} />
          </GroupedList>
        </aside>
      </div>
    </>
  );
}
