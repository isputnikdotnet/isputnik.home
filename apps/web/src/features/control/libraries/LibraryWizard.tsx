import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardList,
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
import type { ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";
import { ExtensionsEditor } from "./ExtensionsEditor";
import { ScanSourcesEditor } from "./ScanSourcesEditor";
import { SourceFolderPicker } from "./SourceFolderPicker";
import { TagEncodingField } from "./TagEncodingField";
import { UploadSettingsFields } from "./UploadSettingsFields";
import { ModeSelect, OwnerSelect, PublicRoleSelect, publicRoleLabel } from "./access-selects";

type WizardLibraryType = "audiobook" | "ebook" | "gallery";
type StepKey = "type" | "basics" | "review";
type AdvancedTab = "access" | "upload" | "scanning";

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
  const { t } = useTranslation(["common", "control"]);

  const TYPE_OPTIONS: {
    type: WizardLibraryType;
    label: string;
    caption: string;
    icon: LucideIcon;
  }[] = [
    {
      type: "audiobook",
      label: t("control:libraries.typeAudiobooks"),
      caption: t("control:libraries.wizard.typeCaptionAudiobook"),
      icon: Headphones
    },
    {
      type: "ebook",
      label: t("control:libraries.typeEbooks"),
      caption: t("control:libraries.wizard.typeCaptionEbook"),
      icon: BookOpen
    },
    {
      type: "gallery",
      label: t("control:libraries.typeGallery"),
      caption: t("control:libraries.wizard.typeCaptionGallery"),
      icon: ImageIcon
    }
  ];

  const stepTitle = (key: StepKey): string => {
    switch (key) {
      case "type": return t("control:libraries.wizard.stepType");
      case "basics": return t("control:libraries.wizard.stepDetails");
      case "review": return t("control:libraries.wizard.stepReview");
    }
  };

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
      setAdvancedError(t("control:libraries.wizard.errorExtensionsRequired"));
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
        ? groups.find((group) => group.id === ownerId)?.name ?? t("control:libraries.unknownGroup")
        : users.find((user) => user.id === ownerId)?.displayName ?? t("control:libraries.unknownUser"))
    : t("control:libraries.systemLibrary");
  const typeLabel = TYPE_OPTIONS.find((option) => option.type === libraryType)?.label ?? libraryType;
  const reviewGlance = `${typeLabel} · ${visibility === "public" ? t("control:libraries.public") : t("control:libraries.private")} · ${mode === "managed" ? t("control:libraries.modeManaged") : t("control:libraries.wizard.glanceExternal")}`;
  const reviewRows: { label: string; value: string }[] = [
    { label: t("control:libraries.fieldType"), value: typeLabel },
    { label: t("control:libraries.fieldName"), value: name.trim() || "—" },
    { label: t("control:libraries.folderLabel"), value: storageBrowse?.selectedPath || "—" },
    {
      label: t("control:libraries.visibilityLabel"),
      value: visibility === "public"
        ? t("control:libraries.wizard.reviewPublicValue", { role: publicRoleLabel(publicRole) })
        : t("control:libraries.privateOptionFull")
    },
    { label: t("control:libraries.fieldMode"), value: mode === "managed" ? t("control:libraries.modeManaged") : t("control:libraries.modeExternal") },
    { label: t("control:libraries.fieldOwner"), value: ownerLabel },
    { label: t("control:libraries.fieldExtensions"), value: extensions.length ? extensions.map((ext) => `.${ext}`).join(", ") : "—" },
    { label: t("control:libraries.wizard.reviewCompanions"), value: companions.length ? companions.map((ext) => `.${ext}`).join(", ") : t("control:libraries.scanNone") },
    {
      label: t("control:libraries.fieldSources"),
      value: scanSources.filter((source) => source.enabled)
        .map((source) => typeSourceInfo.find((info) => info.id === source.id)?.label ?? source.id)
        .join(" › ") || t("control:libraries.scanNone")
    },
    { label: t("control:libraries.fieldUploadLimit"), value: maxUploadMB ? t("control:libraries.uploadLimitValue", { mb: maxUploadMB }) : t("control:libraries.uploadLimitDefault") },
    ...(libraryType === "audiobook" ? [{ label: t("control:libraries.fieldTagEncoding"), value: tagEncoding || t("control:libraries.wizard.tagEncodingAutoDetect") }] : [])
  ];

  const goNext = () => {
    if (stepKey === "basics" && !basicsReady) {
      setError(name.trim().length < 2
        ? t("control:libraries.wizard.errorNameRequired")
        : t("control:libraries.wizard.errorFolderRequired"));
      return;
    }
    setError("");
    setStepIndex(current + 1);
  };

  const create = async () => {
    if (!basicsReady) {
      setError(name.trim().length < 2
        ? t("control:libraries.wizard.errorNameRequired")
        : t("control:libraries.wizard.errorFolderRequired"));
      return;
    }
    if (extensions.length === 0) {
      setError(t("control:libraries.wizard.errorExtensionsRequired"));
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
      setError(err instanceof Error ? err.message : t("control:libraries.wizard.unableToCreate"));
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
      title={t("control:libraries.addLibrary")}
      icon={<LibraryBig size={30} />}
      className={`create-library-modal library-create-wizard${stepKey === "type" ? " library-type-wizard" : ""}${stepKey === "basics" ? " library-details-wizard" : ""}${stepKey === "review" ? " library-review-wizard" : ""}${advancedOpen ? " library-advanced-open" : ""}`}
      busy={creating}
      onClose={onClose}
      onSubmit={onSubmit}
      headerAction={
        <Button variant="secondary" onClick={onClose} disabled={creating}>
          <X size={18} aria-hidden="true" />
          {t("common.cancel")}
        </Button>
      }
    >
      <ol className="wizard-steps" aria-label={t("control:libraries.wizard.stepsAria")}>
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
                  title={t("control:libraries.wizard.backToStep", { step: stepTitle(key) })}
                >
                  <span className="wizard-step-dot"><Check size={12} /></span>
                  <span className="wizard-step-label">{stepTitle(key)}</span>
                </button>
              ) : (
                <>
                  <span className="wizard-step-dot">{index + 1}</span>
                  <span className="wizard-step-label">{stepTitle(key)}</span>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {stepKey === "type" && (
        <section className="library-type-step">
          <div className="library-type-copy">
            <h3>{t("control:libraries.wizard.typeHeading")}</h3>
            <p>{t("control:libraries.wizard.typeSubheading")}</p>
          </div>
          <div className="library-type-grid" role="radiogroup" aria-label={t("control:libraries.wizard.typeGroupAria")}>
            {TYPE_OPTIONS.map(({ type, label, caption, icon: Icon }) => {
              const selected = libraryType === type;
              return (
                <Button
                  variant="text"
                  type="button"
                  key={type}
                  role="radio"
                  aria-checked={selected}
                  className={`library-type-option${selected ? " selected" : ""}`}
                  {...typeRoving(type)}
                  onClick={() => pickType(type)}
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
            <h3>{t("control:libraries.wizard.detailsHeading")}</h3>
            <p>{t("control:libraries.wizard.detailsSubheading")}</p>
          </div>

          <Field
            label={t("control:libraries.libraryName")}
            value={name}
            onChange={setName}
            placeholder={t("control:libraries.wizard.namePlaceholder")}
          />

          <SourceFolderPicker
            storageRoots={storageRoots}
            selectedRootId={selectedRootId}
            storageBrowse={storageBrowse}
            onBrowse={browse}
            onError={setError}
          />

          <label className="field library-owner-field">
            <span>{t("control:libraries.fieldOwner")}</span>
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
            <span>{t("control:libraries.visibilityLabel")}</span>
            <div className="library-visibility-grid" role="radiogroup" aria-label={t("control:libraries.visibilityLabel")}>
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
                  <strong>{t("control:libraries.public")}</strong>
                  <small>{t("control:libraries.wizard.publicVisibilityHint")}</small>
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
                  <strong>{t("control:libraries.private")}</strong>
                  <small>{t("control:libraries.wizard.privateVisibilityHint")}</small>
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
              <strong>{t("control:libraries.wizard.advancedOptions")}</strong>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </Button>

          {advancedOpen && (
            <section className="library-advanced-inline" aria-label={t("control:libraries.wizard.advancedSettingsAria")}>
              <div className="modal-tabs" role="tablist" aria-label={t("control:libraries.wizard.advancedSettingsAria")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "access"}
                  className={`modal-tab${advancedTab === "access" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("access")}
                >
                  {t("control:libraries.tabAccess")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "upload"}
                  className={`modal-tab${advancedTab === "upload" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("upload")}
                >
                  {t("control:libraries.tabUpload")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={advancedTab === "scanning"}
                  className={`modal-tab${advancedTab === "scanning" ? " active" : ""}`}
                  onClick={() => setAdvancedTab("scanning")}
                >
                  {t("control:libraries.tabScanning")}
                </button>
              </div>

              <div className="modal-tab-content library-advanced-content">
                {advancedTab === "access" && (
                  <section className="library-advanced-tab" aria-label={t("control:libraries.wizard.accessSettingsAria")}>
                    {visibility === "public" && (
                      <label className="field">
                        <span>{t("control:libraryMembers.publicAccess")}</span>
                        <PublicRoleSelect value={draftPublicRole} onChange={setDraftPublicRole} />
                      </label>
                    )}
                    <label className="field">
                      <span>{t("control:libraries.fieldMode")}</span>
                      <ModeSelect value={draftMode} onChange={setDraftMode} />
                    </label>
                  </section>
                )}

                {advancedTab === "upload" && (
                  <section className="library-advanced-tab" aria-label={t("control:libraries.wizard.uploadSettingsAria")}>
                    <ExtensionsEditor
                      extensions={draftExtensions}
                      onChange={setDraftExtensions}
                      defaults={defaults?.extensions ?? []}
                      label={t("control:libraries.extensionsLabel")}
                    />
                    <ExtensionsEditor
                      extensions={draftCompanions}
                      onChange={setDraftCompanions}
                      defaults={defaults?.companions ?? []}
                      label={t("control:libraries.companionsLabel")}
                      emptyHint={t("control:libraries.companionsEmptyHint")}
                    />
                    <UploadSettingsFields
                      maxUploadMB={draftMaxUploadMB}
                      onChange={setDraftMaxUploadMB}
                      mode={draftMode}
                    />
                  </section>
                )}

                {advancedTab === "scanning" && (
                  <section className="library-advanced-tab" aria-label={t("control:libraries.wizard.scanningSettingsAria")}>
                    <ScanSourcesEditor
                      sources={draftScanSources}
                      onChange={setDraftScanSources}
                      sourceInfo={typeSourceInfo}
                    />
                    {libraryType === "audiobook" && (
                      <TagEncodingField
                        value={draftTagEncoding}
                        onChange={setDraftTagEncoding}
                        noneLabel={t("control:libraries.wizard.tagEncodingAutoDetect")}
                      />
                    )}
                  </section>
                )}
              </div>

              <div className="library-advanced-footer">
                {advancedError && <MessageBox tone="error" title={t("control:libraries.wizard.unableToSaveAdvanced")}>{advancedError}</MessageBox>}
                <div className="modal-actions">
                  <Button variant="secondary" type="button" onClick={() => setAdvancedOpen(false)} disabled={creating}>
                    {t("common.cancel")}
                  </Button>
                  <Button variant="primary" type="button" onClick={saveAdvanced} disabled={creating}>
                    {t("control:ui.save")}
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
            <h3>{t("control:libraries.wizard.reviewHeading")}</h3>
            <p>{t("control:libraries.wizard.reviewSubheading")}</p>
          </div>
          <section className="library-review-card" aria-label={t("control:libraries.wizard.reviewCardAria")}>
            <div className="library-review-card-head">
              <span>
                <ClipboardList size={17} aria-hidden="true" />
                <strong>{t("control:libraries.wizard.reviewCardTitle")}</strong>
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

      {error && <MessageBox tone="error" title={t("control:libraries.wizard.unableToAddLibraryTitle")}>{error}</MessageBox>}

      <div className="modal-actions">
        {current > 0 && (
          <Button
            variant="secondary"
            onClick={() => { setError(""); setStepIndex(current - 1); }}
            disabled={creating}
          >
            <ArrowLeft size={18} aria-hidden="true" />
            {t("control:libraries.wizard.back")}
          </Button>
        )}
        {current < lastStep ? (
          <Button variant="primary" type="submit" disabled={advancedOpen}>
            <span>{t("control:libraries.wizard.next")}</span>
            <ArrowRight size={20} aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={creating || !basicsReady}>
            {creating ? t("control:libraries.wizard.creating") : t("control:libraries.wizard.addAndScan")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
