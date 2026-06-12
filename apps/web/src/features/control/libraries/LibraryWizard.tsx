import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileText,
  Headphones,
  Image as ImageIcon,
  LibraryBig,
  SlidersHorizontal,
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
import { LibraryAccessRows } from "./access-selects";

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
  const [companions, setCompanions] = useState<string[]>(typeDefaults[initialType]?.companions ?? []);
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
    setCompanions(typeDefaults[type]?.companions ?? []);
    setScanSources(typeDefaults[type]?.sources ?? []);
    setTagEncoding("");
  };

  const basicsReady = name.trim().length >= 2 && Boolean(storageBrowse?.selectedPath);

  // Quick setup ignores anything tweaked in Custom and always applies the type's
  // recommended defaults, so the "public, managed, standard formats" promise holds
  // even if the user visited Custom, changed a setting, then switched back to Quick.
  const quick = setupMode === "quick";
  const effectiveVisibility: "public" | "private" = quick ? "public" : visibility;
  const effectivePublicRole: PublicRole = quick ? "member" : publicRole;
  const effectiveMode: LibraryMode = quick ? "managed" : mode;
  const effectiveOwnerId = quick ? "" : ownerId;
  const effectiveOwnerType: "user" | "group" | "" = quick ? "" : ownerType;
  const effectiveExtensions = quick ? (defaults?.extensions ?? []) : extensions;
  const effectiveCompanions = quick ? (defaults?.companions ?? []) : companions;
  const effectiveSources = quick ? (defaults?.sources ?? []) : scanSources;
  const effectiveMaxUploadMB = quick ? "" : maxUploadMB;
  const effectiveTagEncoding = quick ? "" : tagEncoding;

  const typeRoving = useRovingRadio<WizardLibraryType>(["audiobook", "ebook"], libraryType, pickType);
  const setupRoving = useRovingRadio<SetupMode>(["quick", "custom"], setupMode, setSetupMode);

  const ownerLabel = effectiveOwnerId
    ? (effectiveOwnerType === "group"
        ? groups.find((group) => group.id === effectiveOwnerId)?.name ?? "Unknown group"
        : users.find((user) => user.id === effectiveOwnerId)?.displayName ?? "Unknown user")
    : "System library";
  const typeLabel = TYPE_OPTIONS.find((option) => option.type === libraryType)?.label ?? libraryType;
  const reviewGlance = `${typeLabel} · ${effectiveVisibility === "public" ? "Public" : "Private"} · ${effectiveMode === "managed" ? "Managed" : "External"}`;
  const reviewRows: { label: string; value: string }[] = [
    { label: "Type", value: typeLabel },
    { label: "Name", value: name.trim() || "—" },
    { label: "Folder", value: storageBrowse?.selectedPath || "—" },
    { label: "Setup", value: quick ? "Quick (recommended defaults)" : "Custom" },
    {
      label: "Visibility",
      value: effectiveVisibility === "public"
        ? `Public · ${PUBLIC_ROLE_OPTIONS.find((option) => option.value === effectivePublicRole)?.label ?? effectivePublicRole}`
        : "Private — owner and admins only"
    },
    { label: "Mode", value: effectiveMode === "managed" ? "Managed" : "External (read-only)" },
    { label: "Owner", value: ownerLabel },
    { label: "Formats", value: effectiveExtensions.length ? effectiveExtensions.map((ext) => `.${ext}`).join(", ") : "—" },
    { label: "Companion files", value: effectiveCompanions.length ? effectiveCompanions.map((ext) => `.${ext}`).join(", ") : "None" },
    {
      label: "Scan sources",
      value: effectiveSources.filter((source) => source.enabled)
        .map((source) => typeSourceInfo.find((info) => info.id === source.id)?.label ?? source.id)
        .join(" › ") || "None"
    },
    { label: "Upload limit", value: effectiveMaxUploadMB ? `${effectiveMaxUploadMB} MB` : "No limit" },
    ...(libraryType === "audiobook" ? [{ label: "Tag encoding", value: effectiveTagEncoding || "Auto detect" }] : [])
  ];

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
    if (effectiveExtensions.length === 0) {
      setError("Add at least one file extension to scan.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const maxUpload = Number.parseInt(effectiveMaxUploadMB, 10);
      await api(`/api/library/${libraryType}-libraries`, {
        method: "POST",
        body: JSON.stringify({
          name,
          sourcePath: storageBrowse!.selectedPath,
          visibility: effectiveVisibility,
          publicRole: effectivePublicRole,
          mode: effectiveMode,
          ownerId: effectiveOwnerId || null,
          ownerType: effectiveOwnerType || null,
          scanExtensions: effectiveExtensions,
          companionExtensions: effectiveCompanions,
          scanSources: effectiveSources,
          maxUploadMB: Number.isFinite(maxUpload) && maxUpload > 0 ? maxUpload : null,
          tagEncoding: libraryType === "audiobook" && effectiveTagEncoding ? effectiveTagEncoding : null
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
                  {...(type === "audiobook" || type === "ebook" ? typeRoving(type) : { tabIndex: -1 })}
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
                {...setupRoving("quick")}
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
                {...setupRoving("custom")}
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
        <section className="library-access-step">
          <p>Configure access and ownership settings for this library.</p>
          <LibraryAccessRows
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
        </section>
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
            label="Supported file extensions (scanning & upload)"
          />
          <ExtensionsEditor
            extensions={companions}
            onChange={setCompanions}
            defaults={defaults?.companions ?? []}
            label="Companion files (upload only — covers, metadata, documents)"
            emptyHint="No companion files — uploads accept the formats above only."
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

      {current === lastStep && (
        <details className="wizard-review">
          <summary>
            <ClipboardList size={16} aria-hidden="true" />
            <span className="wizard-review-title">Review</span>
            <span className="wizard-review-glance">{reviewGlance}</span>
            <span className="wizard-review-chevron" aria-hidden="true">
              <ChevronDown size={16} className="wizard-review-chev-closed" />
              <ChevronUp size={16} className="wizard-review-chev-open" />
            </span>
          </summary>
          <dl>
            {reviewRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </details>
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
          <span className="library-wizard-footnote">Nothing is scanned until you choose Add and scan.</span>
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

