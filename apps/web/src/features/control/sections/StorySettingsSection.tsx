import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";

interface StorySettingsDto {
  recordingsLibrary: { id: string; name: string } | null;
  pendingNarrations?: number;
}

// Where story narration recordings live. An admin nominates one gallery
// library; recordings from the story editor land there (under "Story
// recordings/<year>") as ordinary audio assets, so they show in the gallery,
// get backed up, and survive their story. Until a library is chosen the story
// editor offers no Record/Upload at all.
//
// The one-time import below moves narration recorded before this setting
// existed (stored inside the app, invisible to the gallery) into the chosen
// library.
export function StorySettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [pending, setPending] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [confirmMove, setConfirmMove] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveResult, setMoveResult] = useState<{ moved: number; failed: number } | null>(null);
  const [moveError, setMoveError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ libraries: { id: string; name: string }[] }>("/api/library/gallery-libraries?manage=1"),
      api<StorySettingsDto>("/api/stories/settings")
    ])
      .then(([libs, settings]) => {
        setLibraries(libs.libraries.map((library) => ({ id: library.id, name: library.name })));
        setLibraryId(settings.recordingsLibrary?.id ?? "");
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
        body: JSON.stringify({ recordingsLibraryId: libraryId || null })
      });
      setLibraryId(payload.recordingsLibrary?.id ?? "");
      setPending(payload.pendingNarrations ?? 0);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  const runMove = async () => {
    setMoving(true);
    setMoveError("");
    setMoveResult(null);
    try {
      const result = await api<{ moved: number; failed: number; remaining: number }>(
        "/api/stories/settings/migrate-narrations",
        { method: "POST" }
      );
      setMoveResult({ moved: result.moved, failed: result.failed });
      setPending(result.remaining);
      setConfirmMove(false);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : t("controlAdmin:storySettings.moveFailed"));
      setConfirmMove(false);
    } finally {
      setMoving(false);
    }
  };

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
            <label className="mail-field">
              <span>{t("controlAdmin:storySettings.libraryLabel")}</span>
              <select value={libraryId} onChange={(event) => setLibraryId(event.target.value)} disabled={saving}>
                <option value="">{t("controlAdmin:storySettings.libraryNone")}</option>
                {libraries.map((library) => (
                  <option key={library.id} value={library.id}>{library.name}</option>
                ))}
              </select>
            </label>
            <p className="muted">{t("controlAdmin:storySettings.libraryNote")}</p>

            {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:storySettings.savedBody")}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
            </div>
          </form>
        )}

        {!loading && pending > 0 && (
          <div className="config-block">
            <MessageBox tone="info" title={t("controlAdmin:storySettings.pendingTitle")}>
              {t("controlAdmin:storySettings.pendingBody", { count: pending })}
            </MessageBox>
            <div className="mail-actions">
              <Button variant="primary" disabled={!libraryId || moving} onClick={() => setConfirmMove(true)}>
                {moving ? t("controlAdmin:storySettings.moving") : t("controlAdmin:storySettings.moveAction")}
              </Button>
            </div>
          </div>
        )}
        {moveError && <MessageBox tone="error" title={t("controlAdmin:storySettings.moveFailed")}>{moveError}</MessageBox>}
        {moveResult && (
          <MessageBox
            tone={moveResult.failed > 0 ? "warning" : "success"}
            title={t("controlAdmin:storySettings.moveDoneTitle")}
          >
            {t("controlAdmin:storySettings.moveDoneBody", { count: moveResult.moved })}
            {moveResult.failed > 0 ? ` ${t("controlAdmin:storySettings.moveFailedBody", { count: moveResult.failed })}` : ""}
          </MessageBox>
        )}
      </section>

      {confirmMove && (
        <ConfirmDialog
          title={t("controlAdmin:storySettings.moveConfirmTitle")}
          confirmLabel={t("controlAdmin:storySettings.moveConfirm")}
          busyLabel={t("controlAdmin:storySettings.moving")}
          busy={moving}
          onConfirm={() => void runMove()}
          onCancel={() => setConfirmMove(false)}
        >
          {t("controlAdmin:storySettings.moveConfirmBody", { count: pending })}
        </ConfirmDialog>
      )}
    </>
  );
}
