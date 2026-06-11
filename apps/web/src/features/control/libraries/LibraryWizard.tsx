import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Headphones, BookOpen, Zap, SlidersHorizontal, Check } from "lucide-react";
import { api } from "../../../api";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import type { PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";
import { LibraryAccessFields } from "./LibraryCoreFields";
import { ExtensionsEditor } from "./ExtensionsEditor";
import { ScanSourcesEditor } from "./ScanSourcesEditor";
import { UploadSettingsFields } from "./UploadSettingsFields";
import { SourceFolderPicker } from "./SourceFolderPicker";
import { TagEncodingField } from "./TagEncodingField";

type WizardLibraryType = "audiobook" | "ebook";
type SetupMode = "quick" | "custom";
type StepKey = "basics" | "access" | "scanning";

const TYPE_OPTIONS: { type: WizardLibraryType; label: string; caption: string; icon: typeof Headphones }[] = [
  { type: "audiobook", label: "Audiobooks", caption: "Folders of audio files become books with chapters", icon: Headphones },
  { type: "ebook", label: "Ebooks", caption: "EPUB and PDF files become a reading catalogue", icon: BookOpen }
];

const STEP_TITLES: Record<StepKey, string> = {
  basics: "Basics",
  access: "Access",
  scanning: "Scanning & upload"
};

// One create wizard for every library type. "Quick" needs only a type, name, and
// folder — everything else uses the type's recommended defaults. "Custom" adds the
// access and scanning steps so every setting can be tuned before the first scan.
export function LibraryWizard({
  initialType,
  users,
  groups,
  storageRoots,
  initialRootId,
  metadataSources,
  typeDefaults,
  onClose,
  onCreated
}: {
  initialType: WizardLibraryType;
  users: ManagedUser[];
  groups: ManagedGroup[];
  storageRoots: StorageRoot[];
  initialRootId: string;
  metadataSources: MetadataSourceInfo[];
  typeDefaults: Record<string, LibraryTypeDefaults>;
  onClose: () => void;
  onCreated: (type: WizardLibraryType) => void;
}) {
  const [libraryType, setLibraryType] = useState<WizardLibraryType>(initialType);
  const [setupMode, setSetupMode] = useState<SetupMode>("quick");
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState("");
  const [selectedRootId, setSelectedRootId] = useState(initialRootId);
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [publicRole, setPublicRole] = useState<PublicRole>("member");
  const [mode, setMode] = useState<LibraryMode>("managed");
  const [ownerId, setOwnerId] = useState("");
  const [ownerType, setOwnerType] = useState<"user" | "group" | "">("");
  const [extensions, setExtensions] = useState<string[]>(typeDefaults[initialType]?.extensions ?? []);
  const [scanSources, setScanSources] = useState<ScanSource[]>(typeDefaults[initialType]?.sources ?? []);
  const [maxUploadMB, setMaxUploadMB] = useState("");
  const [tagEncoding, setTagEncoding] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const defaults = typeDefaults[libraryType];
  const typeSourceInfo = useMemo(
    () => metadataSources.filter((source) => source.appliesTo.includes(libraryType)),
    [metadataSources, libraryType]
  );

  const steps: StepKey[] = setupMode === "quick" ? ["basics"] : ["basics", "access", "scanning"];
  const lastStep = steps.length - 1;
  const current = Math.min(stepIndex, lastStep);
  const stepKey = steps[current];

  const browse = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  // Open the first container right away so the folder browser is usable without
  // re-selecting the root.
  useEffect(() => {
    if (initialRootId) {
      browse(initialRootId).catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to browse storage container"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  const pickType = (type: WizardLibraryType) => {
    if (type === libraryType) return;
    setLibraryType(type);
    // Scanning options follow the chosen type's defaults until the user edits them.
    setExtensions(typeDefaults[type]?.extensions ?? []);
    setScanSources(typeDefaults[type]?.sources ?? []);
    setTagEncoding("");
  };

  const basicsReady = name.trim().length >= 2 && Boolean(storageBrowse?.selectedPath);

  const goNext = () => {
    if (stepKey === "basics" && !basicsReady) {
      setError(name.trim().length < 2
        ? "Enter a library name (at least 2 characters) to continue."
        : "Choose a source folder for this library.");
      return;
    }
    if (stepKey === "scanning" && extensions.length === 0) {
      setError("Add at least one file extension to scan.");
      return;
    }
    setError("");
    setStepIndex(current + 1);
  };

  const create = async () => {
    if (!basicsReady) {
      setError(name.trim().length < 2
        ? "Enter a library name (at least 2 characters)."
        : "Choose a source folder for this library.");
      return;
    }
    if (extensions.length === 0) {
      setError("Add at least one file extension to scan.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const maxUpload = Number.parseInt(maxUploadMB, 10);
      await api(`/api/library/${libraryType}-libraries`, {
        method: "POST",
        body: JSON.stringify({
          name,
          sourcePath: storageBrowse!.selectedPath,
          defaultLanguage: "en",
          visibility,
          publicRole,
          mode,
          ownerId: ownerId || null,
          ownerType: ownerType || null,
          scanExtensions: extensions,
          scanSources,
          maxUploadMB: Number.isFinite(maxUpload) && maxUpload > 0 ? maxUpload : null,
          tagEncoding: libraryType === "audiobook" && tagEncoding ? tagEncoding : null
        })
      });
      onCreated(libraryType);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create library");
      setCreating(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (current < lastStep) {
      goNext();
      return;
    }
    void create();
  };

  return (
    <Modal
      title="Add library"
      className="create-library-modal"
      busy={creating}
      onClose={onClose}
      onSubmit={onSubmit}
    >
      {setupMode === "custom" && (
        <ol className="wizard-steps" aria-label="Setup steps">
          {steps.map((key, index) => (
            <li
              key={key}
              className={`wizard-step${index === current ? " active" : ""}${index < current ? " done" : ""}`}
              aria-current={index === current ? "step" : undefined}
            >
              <span className="wizard-step-dot">{index < current ? <Check size={12} /> : index + 1}</span>
              <span className="wizard-step-label">{STEP_TITLES[key]}</span>
            </li>
          ))}
        </ol>
      )}

      {stepKey === "basics" && (
        <>
          <div className="field">
            <span>Library type</span>
            <div className="wizard-cards" role="radiogroup" aria-label="Library type">
              {TYPE_OPTIONS.map(({ type, label, caption, icon: Icon }) => (
                <button
                  type="button"
                  key={type}
                  role="radio"
                  aria-checked={libraryType === type}
                  className={`wizard-card${libraryType === type ? " selected" : ""}`}
                  onClick={() => pickType(type)}
                >
                  <Icon size={20} aria-hidden="true" />
                  <strong>{label}</strong>
                  <small>{caption}</small>
                </button>
              ))}
            </div>
          </div>

          <Field label="Library name" value={name} onChange={setName} />

          <SourceFolderPicker
            storageRoots={storageRoots}
            selectedRootId={selectedRootId}
            storageBrowse={storageBrowse}
            onBrowse={browse}
            onError={setError}
          />

          <div className="field">
            <span>Setup</span>
            <div className="wizard-cards" role="radiogroup" aria-label="Setup mode">
              <button
                type="button"
                role="radio"
                aria-checked={setupMode === "quick"}
                className={`wizard-card${setupMode === "quick" ? " selected" : ""}`}
                onClick={() => setSetupMode("quick")}
              >
                <Zap size={20} aria-hidden="true" />
                <strong>Quick create</strong>
                <small>Recommended defaults: public, managed, standard formats</small>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={setupMode === "custom"}
                className={`wizard-card${setupMode === "custom" ? " selected" : ""}`}
                onClick={() => setSetupMode("custom")}
              >
                <SlidersHorizontal size={20} aria-hidden="true" />
                <strong>Custom setup</strong>
                <small>Choose access, scanning, and upload options</small>
              </button>
            </div>
          </div>
        </>
      )}

      {stepKey === "access" && (
        <LibraryAccessFields
          ownerId={ownerId}
          ownerType={ownerType}
          onOwnerChange={(type, id) => { setOwnerType(type); setOwnerId(id); }}
          visibility={visibility}
          onVisibilityChange={setVisibility}
          publicRole={publicRole}
          onPublicRoleChange={setPublicRole}
          mode={mode}
          onModeChange={setMode}
          users={users}
          groups={groups}
        />
      )}

      {stepKey === "scanning" && (
        <>
          <ScanSourcesEditor sources={scanSources} onChange={setScanSources} sourceInfo={typeSourceInfo} />
          {libraryType === "audiobook" && (
            <TagEncodingField value={tagEncoding} onChange={setTagEncoding} />
          )}
          <ExtensionsEditor extensions={extensions} onChange={setExtensions} defaults={defaults?.extensions ?? []} />
          <UploadSettingsFields maxUploadMB={maxUploadMB} onChange={setMaxUploadMB} mode={mode} />
        </>
      )}

      {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}

      <div className="modal-actions">
        <Button
          variant="secondary"
          onClick={current > 0 ? () => { setError(""); setStepIndex(current - 1); } : onClose}
          disabled={creating}
        >
          {current > 0 ? "Back" : "Cancel"}
        </Button>
        {current < lastStep ? (
          <Button variant="primary" type="submit">Next</Button>
        ) : (
          <Button variant="primary" type="submit" disabled={creating || !basicsReady}>
            {creating ? "Creating…" : "Add and scan"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
