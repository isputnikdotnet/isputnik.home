import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  FileText,
  Globe2,
  Headphones,
  Eye,
  Image as ImageIcon,
  LibraryBig,
  Shield,
  SlidersHorizontal,
  UserRound,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";
import { api } from "../../../api";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import type { PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import { PUBLIC_ROLE_OPTIONS } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";
import { ExtensionsEditor } from "./ExtensionsEditor";
import { ScanSourcesEditor } from "./ScanSourcesEditor";
import { UploadSettingsFields } from "./UploadSettingsFields";
import { SourceFolderPicker } from "./SourceFolderPicker";
import { TagEncodingField } from "./TagEncodingField";

type WizardLibraryType = "audiobook" | "ebook";
type LibraryTypeChoice = WizardLibraryType | "gallery" | "files";
type SetupMode = "quick" | "custom";
type StepKey = "type" | "basics" | "access" | "upload" | "scanning";

const TYPE_OPTIONS: {
  type: LibraryTypeChoice;
  label: string;
  caption: string;
  icon: LucideIcon;
  available: boolean;
  badge?: string;
}[] = [
  {
    type: "audiobook",
    label: "Audiobooks",
    caption: "Audio folders become books with chapters, tracks, progress, and bookmarks.",
    icon: Headphones,
    available: true
  },
  {
    type: "ebook",
    label: "Ebooks",
    caption: "EPUB and PDF files become a searchable reading library.",
    icon: BookOpen,
    available: true
  },
  {
    type: "gallery",
    label: "Gallery",
    caption: "Photos and videos become albums with previews, metadata, and sharing.",
    icon: ImageIcon,
    available: false,
    badge: "Soon"
  },
  {
    type: "files",
    label: "Files",
    caption: "Any supported file type for documents, archives, and general storage.",
    icon: FileText,
    available: false,
    badge: "Soon"
  }
];

const STEP_TITLES: Record<StepKey, string> = {
  type: "Type",
  basics: "Details",
  access: "Advanced",
  upload: "Upload",
  scanning: "Scanning"
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

  const steps: StepKey[] = setupMode === "quick" ? ["type", "basics"] : ["type", "basics", "access", "upload", "scanning"];
  const lastStep = steps.length - 1;
  const current = Math.min(stepIndex, lastStep);
  const stepKey = steps[current];

  const browse = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  const changeRoot = (rootId: string) => {
    setSelectedRootId(rootId);
    setStorageBrowse(null);
    setError("");
  };

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
        : "Browse and select a source folder for this library.");
      return;
    }
    if (stepKey === "upload" && extensions.length === 0) {
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
        : "Browse and select a source folder for this library.");
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
      icon={<LibraryBig size={30} />}
      className={`create-library-modal library-create-wizard${stepKey === "type" ? " library-type-wizard" : ""}${stepKey === "basics" ? " library-details-wizard" : ""}${stepKey === "access" ? " library-access-wizard" : ""}${stepKey === "upload" ? " library-upload-wizard" : ""}${stepKey === "scanning" ? " library-scanning-wizard" : ""}`}
      busy={creating}
      onClose={onClose}
      onSubmit={onSubmit}
      headerAction={
        <Button variant="secondary" onClick={onClose} disabled={creating}>
          <X size={18} aria-hidden="true" />
          Cancel
        </Button>
      }
    >
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

      {stepKey === "type" && (
        <section className="library-type-step">
          <div className="library-type-copy">
            <h3>Choose library type</h3>
            <p>Select what you want to organize in this library.</p>
          </div>
          <div className="library-type-grid" role="radiogroup" aria-label="Library type">
            {TYPE_OPTIONS.map(({ type, label, caption, icon: Icon, available, badge }) => {
              const selected = libraryType === type;
              return (
                <Button
                  variant="text"
                  type="button"
                  key={type}
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={!available}
                  disabled={!available}
                  className={`library-type-option${selected ? " selected" : ""}${!available ? " disabled" : ""}`}
                  onClick={() => {
                    if (type === "audiobook" || type === "ebook") pickType(type);
                  }}
                >
                  <span className="library-type-choice-icon" aria-hidden="true">
                    <Icon size={34} />
                  </span>
                  <span className="library-type-option-copy">
                    <strong>{label}</strong>
                    <small>{caption}</small>
                  </span>
                  {selected && (
                    <span className="library-type-selected" aria-hidden="true">
                      <Check size={18} />
                    </span>
                  )}
                  {badge && <span className="library-type-badge">{badge}</span>}
                </Button>
              );
            })}
          </div>
        </section>
      )}

      {stepKey === "basics" && (
        <section className="library-details-step">
          <div className="library-details-copy">
            <h3>Library details</h3>
            <p>Configure the basic settings for your new library.</p>
          </div>
          <div className="field">
            <span>Setup type</span>
            <div className="setup-type-grid" role="radiogroup" aria-label="Setup mode">
              <Button
                variant="text"
                type="button"
                role="radio"
                aria-checked={setupMode === "quick"}
                className={`setup-type-card${setupMode === "quick" ? " selected" : ""}`}
                onClick={() => setSetupMode("quick")}
              >
                <span className="setup-type-icon" aria-hidden="true">
                  <Zap size={28} />
                </span>
                <span className="setup-type-copy">
                  <strong>Quick setup</strong>
                  <small>Recommended defaults: public, managed, standard formats.</small>
                </span>
                <span className="setup-type-radio" aria-hidden="true" />
              </Button>
              <Button
                variant="text"
                type="button"
                role="radio"
                aria-checked={setupMode === "custom"}
                className={`setup-type-card${setupMode === "custom" ? " selected" : ""}`}
                onClick={() => setSetupMode("custom")}
              >
                <span className="setup-type-icon" aria-hidden="true">
                  <SlidersHorizontal size={28} />
                </span>
                <span className="setup-type-copy">
                  <strong>Custom setup</strong>
                  <small>Choose access, scanning, and upload options.</small>
                </span>
                <span className="setup-type-radio" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <Field
            label="Library name"
            value={name}
            onChange={setName}
            placeholder="Enter a name for this library"
          />

          <SourceFolderPicker
            storageRoots={storageRoots}
            selectedRootId={selectedRootId}
            storageBrowse={storageBrowse}
            onBrowse={browse}
            onRootChange={changeRoot}
            onError={setError}
          />
        </section>
      )}

      {stepKey === "access" && (
        <WizardAccessFields
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

      {stepKey === "upload" && (
        <section className="library-upload-step">
          <div className="library-step-copy">
            <h3>Upload settings</h3>
            <p>Configure how files can be uploaded to this library.</p>
          </div>
          <ExtensionsEditor
            extensions={extensions}
            onChange={setExtensions}
            defaults={defaults?.extensions ?? []}
            label="Supported file extensions (upload)"
          />
          <UploadSettingsFields maxUploadMB={maxUploadMB} onChange={setMaxUploadMB} mode={mode} />
        </section>
      )}

      {stepKey === "scanning" && (
        <section className="library-scanning-step">
          <div className="library-step-copy">
            <h3>Scanning settings</h3>
            <p>Configure how the library will be scanned.</p>
          </div>
          <ScanSourcesEditor sources={scanSources} onChange={setScanSources} sourceInfo={typeSourceInfo} />
          {libraryType === "audiobook" && (
            <TagEncodingField value={tagEncoding} onChange={setTagEncoding} noneLabel="Auto Detect" />
          )}
        </section>
      )}

      {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}

      <div className="modal-actions">
        {current > 0 && (
          <Button
            variant="secondary"
            onClick={() => { setError(""); setStepIndex(current - 1); }}
            disabled={creating}
          >
            Back
          </Button>
        )}
        {(stepKey === "upload" || stepKey === "scanning") && (
          <span className="library-wizard-footnote">You can review and change settings before the scan starts.</span>
        )}
        {current < lastStep ? (
          <Button variant="primary" type="submit">
            <span>Next</span>
            {stepKey === "type" && <ArrowRight size={20} aria-hidden="true" />}
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={creating || !basicsReady}>
            {creating ? "Creating…" : "Add and scan"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

function WizardAccessFields({
  ownerId, ownerType, onOwnerChange,
  visibility, onVisibilityChange,
  publicRole, onPublicRoleChange,
  mode, onModeChange,
  users, groups
}: {
  ownerId: string;
  ownerType: "user" | "group" | "";
  onOwnerChange: (ownerType: "user" | "group" | "", ownerId: string) => void;
  visibility: "public" | "private";
  onVisibilityChange: (value: "public" | "private") => void;
  publicRole: PublicRole;
  onPublicRoleChange: (value: PublicRole) => void;
  mode: LibraryMode;
  onModeChange: (value: LibraryMode) => void;
  users: ManagedUser[];
  groups: ManagedGroup[];
}) {
  return (
    <section className="library-access-step">
      <p>Configure access and ownership settings for this library.</p>
      <div className="library-access-list">
        <AccessSettingRow
          icon={UserRound}
          title="Owner"
          description="Select who owns this library."
        >
          <select
            value={ownerId ? `${ownerType}:${ownerId}` : ""}
            onChange={(event) => {
              const val = event.target.value;
              if (!val) { onOwnerChange("", ""); return; }
              const [type, id] = val.split(":");
              onOwnerChange(type as "user" | "group", id);
            }}
          >
            <option value="">No owner (system library)</option>
            {users.length > 0 && (
              <optgroup label="Users">
                {users.map((user) => (
                  <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
                ))}
              </optgroup>
            )}
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((group) => (
                  <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </AccessSettingRow>

        <AccessSettingRow
          icon={Globe2}
          title="Visibility"
          description="Control who can see this library."
        >
          <select value={visibility} onChange={(event) => onVisibilityChange(event.target.value as "public" | "private")}>
            <option value="public">Public — all users can access</option>
            <option value="private">Private — owner and admins only</option>
          </select>
        </AccessSettingRow>

        {visibility === "public" && (
          <AccessSettingRow
            icon={Eye}
            title="Public access"
            description="Choose what public users can do."
          >
            <select value={publicRole} onChange={(event) => onPublicRoleChange(event.target.value as PublicRole)}>
              {PUBLIC_ROLE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
          </AccessSettingRow>
        )}

        <AccessSettingRow
          icon={Shield}
          title="Mode"
          description="Determines who manages the files."
        >
          <select value={mode} onChange={(event) => onModeChange(event.target.value as LibraryMode)}>
            <option value="managed">Managed — this app owns the files</option>
            <option value="external">External — read-only, managed outside this app</option>
          </select>
        </AccessSettingRow>
      </div>
    </section>
  );
}

function AccessSettingRow({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="library-access-row">
      <span className="library-access-icon" aria-hidden="true">
        <Icon size={28} />
      </span>
      <span className="library-access-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <label className="library-access-control">
        <span className="sr-only">{title}</span>
        {children}
      </label>
    </div>
  );
}
