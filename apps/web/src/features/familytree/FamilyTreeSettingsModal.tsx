import { useEffect, useState } from "react";
import { Download, FileUp, Settings, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryLibrary } from "../gallery/types";
import { FamilyTagAccessPanel } from "./FamilyTagAccessModal";
import { GedcomImportModal } from "./GedcomImportModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import type { FamilyPerson } from "./types";

type SettingsTab = "photos" | "start" | "gedcom" | "security";

interface SettingsPayload {
  galleryLibrary: { id: string; name: string } | null;
  defaultPerson: { id: string; name: string } | null;
}

// Everything an admin configures about the family tree, in one place: where
// uploaded photos go, GEDCOM import/export, and who may edit which branch.
export function FamilyTreeSettingsModal({
  personCount,
  onClose,
  onChanged
}: {
  personCount: number;
  onClose: () => void;
  /** A GEDCOM import rewrites the tree — the caller reloads. */
  onChanged: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [tab, setTab] = useState<SettingsTab>("photos");
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [libraryId, setLibraryId] = useState("");
  // Carries portraitUrl when it came from the picker; the settings GET only
  // knows the name, which PersonAvatar renders as an initial.
  const [startPerson, setStartPerson] = useState<{ id: string; name: string; portraitUrl?: string | null } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries"),
      api<SettingsPayload>("/api/family-tree/settings")
    ])
      .then(([libs, settings]) => {
        setLibraries(libs.libraries);
        setLibraryId(settings.galleryLibrary?.id ?? "");
        setStartPerson(settings.defaultPerson);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:treeSettings.errors.loadSettings")));
  }, [t]);

  // One saver for both settings: the PUT takes either field on its own and
  // merges, so sending one never disturbs the other.
  const save = async (patch: { galleryLibraryId?: string | null; defaultPersonId?: string | null }, whatFailed: string) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api("/api/family-tree/settings", { method: "PUT", body: JSON.stringify(patch) });
      setSaved(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : whatFailed);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveLibrary = async (nextId: string) => {
    setLibraryId(nextId);
    await save({ galleryLibraryId: nextId || null }, t("family:treeSettings.errors.saveLibrary"));
  };

  const saveStartPerson = async (person: FamilyPerson | null) => {
    const previous = startPerson;
    setStartPerson(person);
    setPickerOpen(false);
    // The chart reads this from the tree payload, so the caller reloads.
    if (await save({ defaultPersonId: person?.id ?? null }, t("family:treeSettings.errors.saveStartPerson"))) onChanged();
    else setStartPerson(previous);
  };

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "photos", label: t("family:treeSettings.tabPhotos") },
    { id: "start", label: t("family:treeSettings.tabStart") },
    { id: "gedcom", label: t("family:treeSettings.tabGedcom") },
    { id: "security", label: t("family:treeSettings.tabSecurity") }
  ];

  return (
    <>
      <Modal
        variant="panel"
        title={t("family:treeSettings.title")}
        icon={<Settings size={20} />}
        className="ft-settings-modal"
        busy={saving}
        onClose={() => { if (!importOpen && !pickerOpen) onClose(); }}
      >
        <div className="modal-tabs">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`modal-tab${tab === id ? " active" : ""}`}
              onClick={() => { setTab(id); setSaved(false); setError(""); }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal-tab-content ft-settings-content">
          {error && <MessageBox tone="error" title={t("family:treeSettings.errorTitle")}>{error}</MessageBox>}

          {tab === "photos" && (
            <>
              <p className="ft-modal-hint">
                {t("family:treeSettings.photosHint")}
              </p>

              {libraries.length === 0 ? (
                <MessageBox
                  tone="info"
                  title={t("family:treeSettings.noLibraryTitle")}
                  action={
                    <a
                      className="primary-button compact-button"
                      href="/control/libraries"
                      onClick={(event) => followRoute(event, "/control/libraries")}
                    >
                      {t("family:treeSettings.createLibraryLink")}
                    </a>
                  }
                >
                  {t("family:treeSettings.noLibraryBody")}
                </MessageBox>
              ) : (
                <label className="field">
                  <span>{t("family:treeSettings.uploadPhotosToLabel")}</span>
                  <select value={libraryId} onChange={(event) => void saveLibrary(event.target.value)} disabled={saving}>
                    <option value="">{t("family:treeSettings.noLibraryOption")}</option>
                    {libraries.map((library) => (
                      <option key={library.id} value={library.id}>{library.name}</option>
                    ))}
                  </select>
                  {saved && <small className="ft-modal-hint">{t("family:treeSettings.saved")}</small>}
                </label>
              )}
            </>
          )}

          {tab === "start" && (
            <>
              <p className="ft-modal-hint">
                {t("family:treeSettings.startHint")}
              </p>

              {personCount === 0 ? (
                <MessageBox tone="info" title={t("family:treeSettings.noOneYetTitle")}>
                  {t("family:treeSettings.noOneYetBody")}
                </MessageBox>
              ) : startPerson ? (
                <div className="ft-settings-person">
                  <PersonAvatar person={{ name: startPerson.name, portraitUrl: startPerson.portraitUrl ?? null }} size={40} />
                  <span className="ft-picker-row-name">
                    <strong>{startPerson.name}</strong>
                    <small>{t("family:treeSettings.opensHere")}</small>
                  </span>
                  <div className="ft-settings-row">
                    <Button variant="secondary" compact onClick={() => setPickerOpen(true)} disabled={saving}>
                      {t("family:treeSettings.changeButton")}
                    </Button>
                    <Button
                      variant="icon"
                      title={t("family:treeSettings.clearStartingPersonAria")}
                      aria-label={t("family:treeSettings.clearStartingPersonAria")}
                      disabled={saving}
                      onClick={() => void saveStartPerson(null)}
                    >
                      <X size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="primary" onClick={() => setPickerOpen(true)} disabled={saving}>
                  <UserRound size={16} aria-hidden="true" />
                  {t("family:treeSettings.choosePersonButton")}
                </Button>
              )}
              {saved && <small className="ft-modal-hint">{t("family:treeSettings.saved")}</small>}
            </>
          )}

          {tab === "gedcom" && (
            <>
              <p className="ft-modal-hint">
                {t("family:treeSettings.gedcomHint")}
              </p>
              <div className="ft-settings-row">
                <Button variant="secondary" onClick={() => window.location.assign("/api/family-tree/export")}>
                  <Download size={16} aria-hidden="true" />
                  {t("family:treeSettings.exportButton")}
                </Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  <FileUp size={16} aria-hidden="true" />
                  {t("family:treeSettings.importButton")}
                </Button>
              </div>
              {personCount > 0 && (
                <MessageBox tone="warning" title={t("family:treeSettings.importWarningTitle")}>
                  {t("family:treeSettings.importWarningBody", { peopleCount: t("family:common.counts.person", { count: personCount }) })}
                </MessageBox>
              )}
            </>
          )}

          {tab === "security" && <FamilyTagAccessPanel />}
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.close")}</Button>
        </div>
      </Modal>

      {pickerOpen && (
        <PersonPickerModal
          title={t("family:treeSettings.chooseStartingPersonTitle")}
          allowCreate={false}
          onPick={(person) => void saveStartPerson(person)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {importOpen && (
        <GedcomImportModal
          personCount={personCount}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); onChanged(); }}
        />
      )}
    </>
  );
}
