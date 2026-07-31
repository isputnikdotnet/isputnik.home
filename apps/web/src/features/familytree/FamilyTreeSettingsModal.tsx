import { useEffect, useState } from "react";
import { Download, FileUp, Settings, UserRound, X } from "lucide-react";
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
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load settings"));
  }, []);

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
    await save({ galleryLibraryId: nextId || null }, "Unable to save the library");
  };

  const saveStartPerson = async (person: FamilyPerson | null) => {
    const previous = startPerson;
    setStartPerson(person);
    setPickerOpen(false);
    // The chart reads this from the tree payload, so the caller reloads.
    if (await save({ defaultPersonId: person?.id ?? null }, "Unable to save the starting person")) onChanged();
    else setStartPerson(previous);
  };

  return (
    <>
      <Modal
        variant="panel"
        title="Family tree settings"
        icon={<Settings size={20} />}
        className="ft-settings-modal"
        busy={saving}
        onClose={() => { if (!importOpen && !pickerOpen) onClose(); }}
      >
        <div className="modal-tabs">
          {([
            ["photos", "Photo library"],
            ["start", "Starting person"],
            ["gedcom", "Import / export"],
            ["security", "Security"]
          ] as const).map(([id, label]) => (
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
          {error && <MessageBox tone="error" title="Settings error">{error}</MessageBox>}

          {tab === "photos" && (
            <>
              <p className="ft-modal-hint">
                Photos and videos uploaded from the family tree are added to this gallery library, filed by the
                date they were taken. Attaching photos the gallery already holds works from any library and
                doesn't need this setting.
              </p>

              {libraries.length === 0 ? (
                <MessageBox
                  tone="info"
                  title="No gallery library yet"
                  action={
                    <a
                      className="primary-button compact-button"
                      href="/control/libraries"
                      onClick={(event) => followRoute(event, "/control/libraries")}
                    >
                      Create a library
                    </a>
                  }
                >
                  Create a gallery library first — point it at the folder where family photos should be stored.
                  It will appear here once it exists.
                </MessageBox>
              ) : (
                <label className="field">
                  <span>Upload photos to</span>
                  <select value={libraryId} onChange={(event) => void saveLibrary(event.target.value)} disabled={saving}>
                    <option value="">No library — uploading is off</option>
                    {libraries.map((library) => (
                      <option key={library.id} value={library.id}>{library.name}</option>
                    ))}
                  </select>
                  {saved && <small className="ft-modal-hint">Saved.</small>}
                </label>
              )}
            </>
          )}

          {tab === "start" && (
            <>
              <p className="ft-modal-hint">
                Opening the family tree centres the chart on this person, for everyone. Without one it starts on
                whoever happens to come first, which is rarely the person you'd choose. Following a link to a
                particular person still opens on them.
              </p>

              {personCount === 0 ? (
                <MessageBox tone="info" title="No one in the tree yet">
                  Add the first family member and they'll be selectable here.
                </MessageBox>
              ) : startPerson ? (
                <div className="ft-settings-person">
                  <PersonAvatar person={{ name: startPerson.name, portraitUrl: startPerson.portraitUrl ?? null }} size={40} />
                  <span className="ft-picker-row-name">
                    <strong>{startPerson.name}</strong>
                    <small>The tree opens here</small>
                  </span>
                  <div className="ft-settings-row">
                    <Button variant="secondary" compact onClick={() => setPickerOpen(true)} disabled={saving}>
                      Change
                    </Button>
                    <Button
                      variant="icon"
                      title="Clear the starting person"
                      aria-label="Clear the starting person"
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
                  Choose a person
                </Button>
              )}
              {saved && <small className="ft-modal-hint">Saved.</small>}
            </>
          )}

          {tab === "gedcom" && (
            <>
              <p className="ft-modal-hint">
                GEDCOM is the standard genealogy file, readable by Ancestry, MyHeritage, Gramps and others.
                Exporting writes the whole tree — people, families, events and sources — to one file.
              </p>
              <div className="ft-settings-row">
                <Button variant="secondary" onClick={() => window.location.assign("/api/family-tree/export")}>
                  <Download size={16} aria-hidden="true" />
                  Export GEDCOM
                </Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  <FileUp size={16} aria-hidden="true" />
                  Import GEDCOM
                </Button>
              </div>
              {personCount > 0 && (
                <MessageBox tone="warning" title="Importing can replace the tree">
                  The import offers two modes: add to the {personCount} {personCount === 1 ? "person" : "people"} already
                  here, or replace them entirely. Export first if you want a copy of what you have.
                </MessageBox>
              )}
            </>
          )}

          {tab === "security" && <FamilyTagAccessPanel />}
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        </div>
      </Modal>

      {pickerOpen && (
        <PersonPickerModal
          title="Choose the starting person"
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
