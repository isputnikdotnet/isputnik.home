import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardList,
  FileText,
  Globe2,
  Headphones,
  Image as ImageIcon,
  LibraryBig,
  LockKeyhole,
  SlidersHorizontal,
  X,
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
import { SourceFolderPicker } from "./SourceFolderPicker";
import { TagEncodingField } from "./TagEncodingField";
import { UploadSettingsFields } from "./UploadSettingsFields";
import { ModeSelect, OwnerSelect, PublicRoleSelect } from "./access-selects";

type WizardLibraryType = "audiobook" | "ebook" | "gallery";
type LibraryTypeChoice = WizardLibraryType | "files";
type StepKey = "type" | "basics" | "review";
type AdvancedTab = "access" | "upload" | "scanning";

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
    caption: "Audio folders become books with chapters, tracks, and bookmarks.",
    icon: Headphones,
    available: true
  },
  {
    type: "ebook",
    label: "eBooks",
    caption: "EPUB and PDF files become a searchable reading library.",
    icon: BookOpen,
    available: true
  },
  {
    type: "gallery",
    label: "Gallery",
    caption: "Photos and videos become a date timeline and folder view.",
    icon: ImageIcon,
    available: true
  },
  {
    type: "files",
    label: "Files",
    caption: "Any supported file type for documents, archives, and general storage.",
    icon: FileText,
    available: false,
    badge: "Coming soon"
  }
];

const STEP_TITLES: Record<StepKey, string> = {
  type: "Type",
  basics: "Details",
  review: "Review"
};

// Roving-tabindex keyboard support for a radiogroup of cards (Arrow keys move and
// select, Home/End jump to the ends), matching what native radios give for free.
// Returns a prop getter to spread onto each selectable option button.
function useRovingRadio<T extends string>(values: T[], value: T, onChange: (next: T) => void) {
  const refs = useRef(new Map<T, HTMLButtonElement | null>());
  const select = (next: T) => {
    onChange(next);
    refs.current.get(next)?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : 0;
    const index = Math.max(0, values.indexOf(value));
    if (delta !== 0) {
      event.preventDefault();
      select(values[(index + delta + values.length) % values.length]);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(values[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      select(values[values.length - 1]);
    }
  };
  return (optionValue: T) => ({
    ref: (el: HTMLButtonElement | null) => { refs.current.set(optionValue, el); },
    tabIndex: optionValue === value ? 0 : -1,
    onKeyDown
  });
}

// One create wizard for every library type. The visible flow stays short:
// choose a type, fill in the essentials, then review. Advanced settings expand
// inside the details step so deeper choices stay available in the parent wizard.
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
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState("");
  const [selectedRootId, setSelectedRootId] = useState(initialRootId);
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  // Default to a system-owned library (no owner); the creator can still pick
  // themselves or a group from the Owner select.
  const [ownerId, setOwnerId] = useState("");
  const [ownerType, setOwnerType] = useState<"user" | "group" | "">("");
  const [publicRole, setPublicRole] = useState<PublicRole>("member");
  const [mode, setMode] = useState<LibraryMode>("managed");
  const [extensions, setExtensions] = useState<string[]>(typeDefaults[initialType]?.extensions ?? []);
  const [companions, setCompanions] = useState<string[]>(typeDefaults[initialType]?.companions ?? []);
  const [scanSources, setScanSources] = useState<ScanSource[]>(typeDefaults[initialType]?.sources ?? []);
  const [maxUploadMB, setMaxUploadMB] = useState("");
  const [tagEncoding, setTagEncoding] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("access");
  const [advancedError, setAdvancedError] = useState("");
  const [draftPublicRole, setDraftPublicRole] = useState<PublicRole>("member");
  const [draftMode, setDraftMode] = useState<LibraryMode>("managed");
  const [draftExtensions, setDraftExtensions] = useState<string[]>(typeDefaults[initialType]?.extensions ?? []);
  const [draftCompanions, setDraftCompanions] = useState<string[]>(typeDefaults[initialType]?.companions ?? []);
  const [draftScanSources, setDraftScanSources] = useState<ScanSource[]>(typeDefaults[initialType]?.sources ?? []);
  const [draftMaxUploadMB, setDraftMaxUploadMB] = useState("");
  const [draftTagEncoding, setDraftTagEncoding] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const defaults = typeDefaults[libraryType];
  const typeSourceInfo = useMemo(
    () => metadataSources.filter((source) => source.appliesTo.includes(libraryType)),
    [metadataSources, libraryType]
  );

  const steps: StepKey[] = ["type", "basics", "review"];
  const lastStep = steps.length - 1;
  const current = Math.min(stepIndex, lastStep);
  const stepKey = steps[current];

  const browse = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  const pickType = (type: WizardLibraryType) => {
    if (type === libraryType) return;
    setLibraryType(type);
    setExtensions(typeDefaults[type]?.extensions ?? []);
    setCompanions(typeDefaults[type]?.companions ?? []);
    setScanSources(typeDefaults[type]?.sources ?? []);
    setMaxUploadMB("");
    setTagEncoding("");
  };

  const basicsReady = name.trim().length >= 2 && Boolean(storageBrowse?.selectedPath);

  const typeRoving = useRovingRadio<WizardLibraryType>(["audiobook", "ebook", "gallery"], libraryType, pickType);
  const visibilityRoving = useRovingRadio<"public" | "private">(["public", "private"], visibility, setVisibility);

  const openAdvanced = () => {
    setDraftPublicRole(publicRole);
    setDraftMode(mode);
    setDraftExtensions([...extensions]);
    setDraftCompanions([...companions]);
    setDraftScanSources(scanSources.map((source) => ({ ...source })));
    setDraftMaxUploadMB(maxUploadMB);
    setDraftTagEncoding(tagEncoding);
    setAdvancedError("");
    setAdvancedTab("access");
    setAdvancedOpen(true);
  };

  const saveAdvanced = () => {
    if (draftExtensions.length === 0) {
      setAdvancedTab("upload");
      setAdvancedError("Add at least one file extension to scan.");
      return;
    }
    setPublicRole(draftPublicRole);
    setMode(draftMode);
    setExtensions([...draftExtensions]);
    setCompanions([...draftCompanions]);
    setScanSources(draftScanSources.map((source) => ({ ...source })));
    setMaxUploadMB(draftMaxUploadMB);
    setTagEncoding(draftTagEncoding);
    setAdvancedError("");
    setAdvancedOpen(false);
  };

  const ownerLabel = ownerId
    ? (ownerType === "group"
        ? groups.find((group) => group.id === ownerId)?.name ?? "Unknown group"
        : users.find((user) => user.id === ownerId)?.displayName ?? "Unknown user")
    : "System library";
  const typeLabel = TYPE_OPTIONS.find((option) => option.type === libraryType)?.label ?? libraryType;
  const reviewGlance = `${typeLabel} · ${visibility === "public" ? "Public" : "Private"} · ${mode === "managed" ? "Managed" : "External"}`;
  const reviewRows: { label: string; value: string }[] = [
    { label: "Type", value: typeLabel },
    { label: "Name", value: name.trim() || "—" },
    { label: "Folder", value: storageBrowse?.selectedPath || "—" },
    {
      label: "Visibility",
      value: visibility === "public"
        ? `Public · ${PUBLIC_ROLE_OPTIONS.find((option) => option.value === publicRole)?.label ?? publicRole}`
        : "Private — owner and admins only"
    },
    { label: "Mode", value: mode === "managed" ? "Managed" : "External (read-only)" },
    { label: "Owner", value: ownerLabel },
    { label: "Formats", value: extensions.length ? extensions.map((ext) => `.${ext}`).join(", ") : "—" },
    { label: "Companion files", value: companions.length ? companions.map((ext) => `.${ext}`).join(", ") : "None" },
    {
      label: "Scan sources",
      value: scanSources.filter((source) => source.enabled)
        .map((source) => typeSourceInfo.find((info) => info.id === source.id)?.label ?? source.id)
        .join(" › ") || "None"
    },
    { label: "Upload limit", value: maxUploadMB ? `${maxUploadMB} MB` : "No limit" },
    ...(libraryType === "audiobook" ? [{ label: "Tag encoding", value: tagEncoding || "Auto detect" }] : [])
  ];

  const goNext = () => {
    if (stepKey === "basics" && !basicsReady) {
      setError(name.trim().length < 2
        ? "Enter a library name (at least 2 characters) to continue."
        : "Browse and select a source folder for this library.");
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
          visibility,
          publicRole,
          mode,
          ownerId: ownerId || null,
          ownerType: ownerType || null,
          scanExtensions: extensions,
          companionExtensions: companions,
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
    if (advancedOpen) return;
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
      className={`create-library-modal library-create-wizard${stepKey === "type" ? " library-type-wizard" : ""}${stepKey === "basics" ? " library-details-wizard" : ""}${stepKey === "review" ? " library-review-wizard" : ""}${advancedOpen ? " library-advanced-open" : ""}`}
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
        {steps.map((key, index) => {
          const done = index < current;
          return (
            <li
              key={key}
              className={`wizard-step${index === current ? " active" : ""}${done ? " done" : ""}`}
              aria-current={index === current ? "step" : undefined}
            >
              {done ? (
                <button
                  type="button"
                  className="wizard-step-jump"
                  onClick={() => { setError(""); setStepIndex(index); }}
                  title={`Back to ${STEP_TITLES[key]}`}
                >
                  <span className="wizard-step-dot"><Check size={12} /></span>
                  <span className="wizard-step-label">{STEP_TITLES[key]}</span>
                </button>
              ) : (
                <>
                  <span className="wizard-step-dot">{index + 1}</span>
                  <span className="wizard-step-label">{STEP_TITLES[key]}</span>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {stepKey === "type" && (
        <section className="library-type-step">
          <div className="library-type-copy">
            <h3>What do you want to organize?</h3>
            <p>Choose a library type to get started.</p>
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
                  {...(type !== "files" ? typeRoving(type) : { tabIndex: -1 })}
                  onClick={() => {
                    if (type !== "files") pickType(type);
                  }}
                >
                  <span className="library-type-choice-icon" aria-hidden="true">
                    <Icon size={34} />
                  </span>
                  <span className="library-type-option-copy">
                    <strong>{label}</strong>
                    <small>{caption}</small>
                  </span>
                  <span className="library-type-status">
                    {selected && (
                      <span className="library-type-selected" aria-hidden="true">
                        <Check size={18} />
                      </span>
                    )}
                    {badge && <span className="library-type-badge">{badge}</span>}
                    {!available && (
                      <span className="library-type-lock" aria-hidden="true">
                        <LockKeyhole size={17} />
                      </span>
                    )}
                  </span>
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
            <p>Let's set up the basics for your new library.</p>
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
            onError={setError}
          />

          <label className="field library-owner-field">
            <span>Owner</span>
            <OwnerSelect
              ownerId={ownerId}
              ownerType={ownerType}
              onChange={(type, id) => { setOwnerType(type); setOwnerId(id); }}
              users={users}
              groups={groups}
              compactLabels
            />
          </label>

          <div className="field library-visibility-field">
            <span>Visibility</span>
            <div className="library-visibility-grid" role="radiogroup" aria-label="Visibility">
              <Button
                variant="text"
                type="button"
                role="radio"
                aria-checked={visibility === "public"}
                className={`library-visibility-card${visibility === "public" ? " selected" : ""}`}
                {...visibilityRoving("public")}
                onClick={() => setVisibility("public")}
              >
                <span className="library-visibility-radio" aria-hidden="true" />
                <Globe2 size={22} aria-hidden="true" />
                <span className="library-visibility-copy">
                  <strong>Public</strong>
                  <small>Visible to all users</small>
                </span>
              </Button>
              <Button
                variant="text"
                type="button"
                role="radio"
                aria-checked={visibility === "private"}
                className={`library-visibility-card${visibility === "private" ? " selected" : ""}`}
                {...visibilityRoving("private")}
                onClick={() => setVisibility("private")}
              >
                <span className="library-visibility-radio" aria-hidden="true" />
                <LockKeyhole size={22} aria-hidden="true" />
                <span className="library-visibility-copy">
                  <strong>Private</strong>
                  <small>Only you and invited users</small>
                </span>
              </Button>
            </div>
          </div>

          <Button
            variant="text"
            type="button"
            className="library-advanced-options"
            onClick={openAdvanced}
            aria-expanded={advancedOpen}
          >
            <span>
              <SlidersHorizontal size={19} aria-hidden="true" />
              <strong>Advanced options</strong>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </Button>

          {advancedOpen && (
            <section className="library-advanced-inline" aria-label="Advanced library settings">
              <div className="modal-tabs" role="tablist" aria-label="Advanced library settings">
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "access"}
                  className={`modal-tab${advancedTab === "access" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("access")}
                >
                  Access
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "upload"}
                  className={`modal-tab${advancedTab === "upload" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("upload")}
                >
                  Upload
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "scanning"}
                  className={`modal-tab${advancedTab === "scanning" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("scanning")}
                >
                  Scanning
                </button>
              </div>

              <div className="modal-tab-content library-advanced-content">
                {advancedTab === "access" && (
                  <section className="library-advanced-tab" aria-label="Access settings">
                    {visibility === "public" && (
                      <label className="field">
                        <span>Public access</span>
                        <PublicRoleSelect value={draftPublicRole} onChange={setDraftPublicRole} />
                      </label>
                    )}
                    <label className="field">
                      <span>Mode</span>
                      <ModeSelect value={draftMode} onChange={setDraftMode} />
                    </label>
                  </section>
                )}

                {advancedTab === "upload" && (
                  <section className="library-advanced-tab" aria-label="Upload settings">
                    <ExtensionsEditor
                      extensions={draftExtensions}
                      onChange={setDraftExtensions}
                      defaults={defaults?.extensions ?? []}
                      label="Supported file extensions (scanning & upload)"
                    />
                    <ExtensionsEditor
                      extensions={draftCompanions}
                      onChange={setDraftCompanions}
                      defaults={defaults?.companions ?? []}
                      label="Companion files (upload only — covers, metadata, documents)"
                      emptyHint="No companion files — uploads accept the formats above only."
                    />
                    <UploadSettingsFields
                      maxUploadMB={draftMaxUploadMB}
                      onChange={setDraftMaxUploadMB}
                      mode={draftMode}
                    />
                  </section>
                )}

                {advancedTab === "scanning" && (
                  <section className="library-advanced-tab" aria-label="Scanning settings">
                    <ScanSourcesEditor
                      sources={draftScanSources}
                      onChange={setDraftScanSources}
                      sourceInfo={typeSourceInfo}
                    />
                    {libraryType === "audiobook" && (
                      <TagEncodingField
                        value={draftTagEncoding}
                        onChange={setDraftTagEncoding}
                        noneLabel="Auto Detect"
                      />
                    )}
                  </section>
                )}
              </div>

              <div className="library-advanced-footer">
                {advancedError && <MessageBox tone="error" title="Unable to save advanced options">{advancedError}</MessageBox>}
                <div className="modal-actions">
                  <Button variant="secondary" type="button" onClick={() => setAdvancedOpen(false)} disabled={creating}>
                    Cancel
                  </Button>
                  <Button variant="primary" type="button" onClick={saveAdvanced} disabled={creating}>
                    Save
                  </Button>
                </div>
              </div>
            </section>
          )}
        </section>
      )}

      {stepKey === "review" && (
        <section className="library-review-step">
          <div className="library-details-copy">
            <h3>Review library</h3>
            <p>Confirm these settings before the first scan starts.</p>
          </div>
          <section className="library-review-card" aria-label="Library review">
            <div className="library-review-card-head">
              <span>
                <ClipboardList size={17} aria-hidden="true" />
                <strong>Review</strong>
              </span>
              <span>{reviewGlance}</span>
            </div>
            <dl>
              {reviewRows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
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
            <ArrowLeft size={18} aria-hidden="true" />
            Back
          </Button>
        )}
        {current < lastStep ? (
          <Button variant="primary" type="submit" disabled={advancedOpen}>
            <span>Next</span>
            <ArrowRight size={20} aria-hidden="true" />
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
