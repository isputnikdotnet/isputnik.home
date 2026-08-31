// The three-step wizard that settles what a cleanup compares, and which folders it
// should favour.
//
// Step 2 is the exception to "nothing here decides which copy survives": a standing
// instruction on a folder — keep this one, or clear this one out — is not a guess about
// a particular set, it is an answer given in advance, and it outranks every heuristic the
// review would otherwise fall back on. It belongs BEFORE the scan, because the scan picks
// each set's keeper as it writes it.
//
// The instructions belong to THIS job. They are seeded from the install-wide set when the
// job is created and diverge from it freely afterwards, so editing them here never
// reaches back and changes a cleanup someone else is working through.
//
// Saving locks the scope, because everything the scan writes was worked out under
// these answers.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, ArrowRight, Briefcase, Check, Cloud, File, FolderOpen, HardDrive,
  Image as ImageIcon, Lock, LockOpen, RefreshCw, ShieldCheck, Smartphone, UserRound, Video
} from "lucide-react";
import { api } from "../../../../api";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { ChoiceGroup, type Choice } from "../../../../shared/ChoiceGroup";
import { InfoHint } from "../../../../shared/InfoHint";
import { Modal } from "../../../../shared/Modal";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";
import i18n from "../../../../i18n";
import type { DuplicateJob, DuplicateKind, LibraryOption, MediaKind } from "./cleanup-types";

// Module-level helpers (not components) call i18n.t() directly rather than the
// useTranslation() hook — see cleanup-types.ts's note on the same pattern.
const cleanupTypeLabel = (type: DuplicateKind): string =>
  i18n.t(type === "folders" ? "controlDash:dupes.wizard.typeFolders" : "controlDash:dupes.wizard.typeFiles");

const cleanupTypeDescription = (type: DuplicateKind): string =>
  i18n.t(type === "folders" ? "controlDash:dupes.wizard.typeFoldersNote" : "controlDash:dupes.wizard.typeFilesNote");

const mediaTypeLabel = (type: MediaKind): string =>
  i18n.t(type === "photo"
    ? "controlDash:dupes.wizard.mediaPhotos"
    : type === "video" ? "controlDash:dupes.wizard.mediaVideos" : "controlDash:dupes.wizard.mediaBoth");

const mediaTypeDescription = (type: MediaKind): string =>
  i18n.t(type === "photo"
    ? "controlDash:dupes.wizard.mediaPhotosNote"
    : type === "video" ? "controlDash:dupes.wizard.mediaVideosNote" : "controlDash:dupes.wizard.mediaBothNote");

function libraryModeLabel(library: LibraryOption): string {
  return library.mode === "external"
    ? i18n.t("controlDash:dupes.wizard.modeExternal")
    : i18n.t("controlDash:dupes.wizard.modeInternal");
}

function libraryIcon(library: LibraryOption) {
  const text = `${library.name} ${library.sourcePath}`.toLowerCase();
  if (text.includes("phone") || text.includes("mobile") || text.includes("iphone") || text.includes("android")) {
    return <Smartphone size={19} aria-hidden="true" />;
  }
  if (text.includes("cloud") || text.includes("google") || text.includes("icloud")) {
    return <Cloud size={19} aria-hidden="true" />;
  }
  if (library.mode === "external" || text.includes("nas") || text.includes("usb") || text.includes("volume")) {
    return <HardDrive size={19} aria-hidden="true" />;
  }
  return <ImageIcon size={19} aria-hidden="true" />;
}

/** A folder in one of the job's libraries, as an instruction can address it. */
interface FolderOption {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  photoCount: number;
  isProtected: boolean;
  /** A folder lock covers it — "clear" is refused there too. */
  isLocked: boolean;
}

type PreferenceMode = "keep" | "clear";

/** Keyed the same way the server stores them: library + path. */
const folderKey = (libraryId: string, folderPath: string): string => `${libraryId} ${folderPath}`;

const getModes = (): { value: PreferenceMode | ""; short: string; hint: string }[] => [
  { value: "keep", short: i18n.t("controlDash:dupes.wizard.modeKeep"), hint: i18n.t("controlDash:dupes.wizard.modeKeepHint") },
  { value: "", short: "—", hint: i18n.t("controlDash:dupes.wizard.modeNoneHint") },
  { value: "clear", short: i18n.t("controlDash:dupes.wizard.modeClear"), hint: i18n.t("controlDash:dupes.wizard.modeClearHint") }
];

// One entry per step, and the only place their order and count is written down —
// the rail, the "Step n of m" line and the footer all read it. What to compare
// used to share the first step with the library picker, which made that step three
// questions long and this one no question at all; they are separate decisions and
// the second one is easier to answer once the libraries are settled.
const getSteps = (): { title: string; note: string; heading: string; blurb: string }[] => [
  {
    title: i18n.t("controlDash:dupes.wizard.step1Title"),
    note: i18n.t("controlDash:dupes.wizard.step1Note"),
    heading: i18n.t("controlDash:dupes.wizard.step1Heading"),
    blurb: i18n.t("controlDash:dupes.wizard.step1Blurb")
  },
  {
    title: i18n.t("controlDash:dupes.wizard.step2Title"),
    note: i18n.t("controlDash:dupes.wizard.step2Note"),
    heading: i18n.t("controlDash:dupes.wizard.step2Heading"),
    blurb: i18n.t("controlDash:dupes.wizard.step2Blurb")
  },
  {
    title: i18n.t("controlDash:dupes.wizard.step3Title"),
    note: i18n.t("controlDash:dupes.wizard.step3Note"),
    heading: i18n.t("controlDash:dupes.wizard.step3Heading"),
    blurb: i18n.t("controlDash:dupes.wizard.step3Blurb")
  },
  {
    title: i18n.t("controlDash:dupes.wizard.step4Title"),
    note: i18n.t("controlDash:dupes.wizard.step4Note"),
    heading: i18n.t("controlDash:dupes.wizard.step4Heading"),
    blurb: i18n.t("controlDash:dupes.wizard.step4Blurb")
  }
];

export function CleanupWizard({
  libraries, job, ownerName, onClose, onSaved
}: {
  libraries: LibraryOption[];
  job: DuplicateJob | null;
  ownerName: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const steps = getSteps();
  const modes = getModes();
  const [step, setStep] = useState(Math.min(job?.currentStep ?? 1, steps.length));
  const [chosen, setChosen] = useState<string[]>(
    job ? job.libraries.filter((library) => library.included).map((library) => library.libraryId)
      : libraries.filter((library) => !library.isProtected).map((library) => library.id)
  );
  const [duplicateType, setDuplicateType] = useState<DuplicateKind>(job?.duplicateType ?? "folders");
  const [mediaType, setMediaType] = useState<MediaKind>(job?.mediaType ?? "photo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  // An existing job's own instructions. A new cleanup starts with none: there is no
  // install-wide set any more, so nothing shapes a scan that the wizard did not show.
  const [preferences, setPreferences] = useState<Record<string, PreferenceMode>>(() => {
    const seed: Record<string, PreferenceMode> = {};
    for (const folder of job?.folderPreferences ?? []) {
      seed[folderKey(folder.libraryId, folder.folderPath)] = folder.mode;
    }
    return seed;
  });
  const [folderQuery, setFolderQuery] = useState("");

  const toggle = (id: string) => setChosen((current) =>
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  const chosenLibraries = libraries.filter((library) => chosen.includes(library.id));
  const externalCount = chosenLibraries.filter((library) => library.isProtected).length;
  const internalCount = chosenLibraries.length - externalCount;
  const toCheck = chosenLibraries.reduce((sum, library) => sum + library.candidateCount, 0);
  const toFingerprint = chosenLibraries.reduce((sum, library) => sum + library.pendingCount, 0);
  const hasProtected = libraries.some((library) => library.isProtected);

  // Fetched for the libraries actually chosen, when that step is reached — a folder in a
  // library the job never looks at is an instruction that can only confuse.
  useEffect(() => {
    if (step !== 3 || chosen.length === 0) return;
    let live = true;
    setFoldersLoading(true);
    api<{ folders: FolderOption[] }>(
      `/api/library/gallery/duplicate-jobs/folder-options?libraryIds=${encodeURIComponent(chosen.join(","))}`
    )
      .then((payload) => { if (live) setFolderOptions(payload.folders); })
      .catch(() => { if (live) setFolderOptions([]); })
      .finally(() => { if (live) setFoldersLoading(false); });
    return () => { live = false; };
  }, [step, chosen.join(",")]);

  const needle = folderQuery.trim().toLowerCase();
  // Biggest folders first. An instruction on a folder of four photos is worth
  // almost nothing and there are hundreds of those; the handful holding thousands
  // are where a "keep this one" actually decides anything, so they go where they
  // will be seen rather than wherever the path sorted them.
  const shownFolders = useMemo(() => folderOptions
    .filter((option) => !needle
      || option.folderPath.toLowerCase().includes(needle)
      || option.libraryName.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => b.photoCount - a.photoCount
      || a.libraryName.localeCompare(b.libraryName)
      || a.folderPath.localeCompare(b.folderPath)),
  [folderOptions, needle]);
  const instructionCount = Object.keys(preferences).length;
  const current = steps[step - 1];

  const cleanupTypeChoices: Choice<DuplicateKind>[] = [
    {
      value: "folders",
      label: t("controlDash:dupes.wizard.typeFolders"),
      description: t("controlDash:dupes.wizard.typeFoldersNote"),
      icon: <FolderOpen size={22} />
    },
    {
      value: "files",
      label: t("controlDash:dupes.wizard.typeFiles"),
      description: t("controlDash:dupes.wizard.typeFilesNote"),
      icon: <File size={22} />
    }
  ];

  const mediaTypeChoices: Choice<MediaKind>[] = [
    {
      value: "photo",
      label: t("controlDash:dupes.wizard.mediaPhotos"),
      description: t("controlDash:dupes.wizard.mediaPhotosNote"),
      icon: <ImageIcon size={21} />
    },
    {
      value: "video",
      label: t("controlDash:dupes.wizard.mediaVideos"),
      description: t("controlDash:dupes.wizard.mediaVideosNote"),
      icon: <Video size={21} />
    },
    {
      value: "both",
      label: t("controlDash:dupes.wizard.mediaBoth"),
      description: t("controlDash:dupes.wizard.mediaBothNote"),
      icon: (
        <span className="cleanup-choice-pair" aria-hidden="true">
          <ImageIcon size={18} />
          <Video size={18} />
        </span>
      )
    }
  ];

  // Sent whole, because that is how the server stores them: this list IS the job's
  // instructions, so a folder left at "—" has to be absent rather than unmentioned.
  //
  // Sent AFTER the job exists, at the end — nothing is written while the wizard is open.
  // The page only offers the wizard when there is no cleanup, so a draft saved half-way
  // through would occupy the one slot and leave nobody able to reopen it.
  const savePreferences = async (id: string) => {
    const folders = Object.entries(preferences).map(([key, mode]) => {
      const cut = key.indexOf(" ");
      return { libraryId: key.slice(0, cut), folderPath: key.slice(cut + 1), mode };
    });
    await api(`/api/library/gallery/duplicate-jobs/${id}/preferences`, {
      method: "POST", body: JSON.stringify({ folders })
    });
  };

  const save = async (andRun: boolean) => {
    setSaving(true);
    setError("");
    try {
      const body = { libraryIds: chosen, duplicateType, mediaType, currentStep: step };
      const id = job
        ? (await api<{ activeJob: DuplicateJob }>(`/api/library/gallery/duplicate-jobs/${job.id}`, {
            method: "PATCH", body: JSON.stringify(body)
          })).activeJob?.id ?? job.id
        : (await api<{ activeJob: DuplicateJob }>("/api/library/gallery/duplicate-jobs", {
            method: "POST", body: JSON.stringify(body)
          })).activeJob!.id;
      await savePreferences(id);
      if (andRun) {
        await api(`/api/library/gallery/duplicate-jobs/${id}/scan`, { method: "POST", body: "{}" });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:dupes.wizard.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={job ? t("controlDash:dupes.wizard.editTitle") : t("controlDash:dupes.wizard.createTitle")}
      subtitle={t("controlDash:dupes.wizard.stepOf", { step, total: steps.length, heading: current.heading })}
      icon={<FolderOpen size={30} />}
      className="cleanup-wizard-modal"
      headerClassName="cleanup-wizard-header"
      busy={saving}
      onClose={onClose}
    >
      <div className="cleanup-wizard-shell">
        <aside className="cleanup-wizard-rail" aria-label={t("controlDash:dupes.wizard.railAria")}>
          {steps.map((item, index) => {
            const value = index + 1;
            const done = step > value;
            const active = step === value;
            return (
              <div
                className={`cleanup-step${active ? " is-active" : ""}${done ? " is-done" : ""}`}
                aria-current={active ? "step" : undefined}
                key={item.title}
              >
                <span className="cleanup-step-dot" aria-hidden="true">
                  {done ? <Check size={14} /> : value}
                </span>
                <span className="cleanup-step-copy">
                  <strong>{item.title}</strong>
                  <span>{item.note}</span>
                </span>
              </div>
            );
          })}
        </aside>

        <div className="cleanup-wizard-content">
          {error && <MessageBox tone="error" title={t("controlDash:dupes.wizard.saveFailed")}>{error}</MessageBox>}

          {step === 1 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>{current.heading}</h3>
                <p>{current.blurb}</p>
              </div>

              <section className="cleanup-wizard-section">
                {libraries.length === 0 ? (
                  <MessageBox tone="warning" title={t("controlDash:dupes.wizard.noLibrariesTitle")}>
                    {t("controlDash:dupes.wizard.noLibrariesBody")}
                  </MessageBox>
                ) : (
                  <div className="cleanup-library-list" role="list">
                    {libraries.map((library) => {
                      const included = chosen.includes(library.id);
                      return (
                        <div className={`cleanup-library-row${included ? " is-selected" : ""}`} role="listitem" key={library.id}>
                          <span className="cleanup-library-icon" aria-hidden="true">{libraryIcon(library)}</span>
                          <span className="cleanup-library-copy">
                            <strong>{library.name}</strong>
                            <span>{library.sourcePath}</span>
                          </span>
                          <span className={`cleanup-library-badge ${library.mode}`}>
                            {libraryModeLabel(library)}
                          </span>
                          {/* The lock trails the toggle rather than preceding it. It only
                              renders for a protected library, and a grid child that comes
                              and goes shifts every column after it — so a row with a lock
                              pushed its toggle out of line with the rows without one. */}
                          <ToggleSwitch
                            checked={included}
                            onChange={() => toggle(library.id)}
                            disabled={saving}
                            ariaLabel={t(included ? "controlDash:dupes.wizard.exclude" : "controlDash:dupes.wizard.include", { name: library.name })}
                            className="cleanup-library-toggle"
                          />
                          {/* Both states draw something. A cell that renders for
                              some rows and not others is what knocked the toggles
                              out of line: each row is its own grid, so an absent
                              last child gave that row's flexible name column the
                              slack and shifted everything after it left. */}
                          <span
                            className={`cleanup-library-lock${library.isProtected ? " is-locked" : ""}`}
                            title={library.isProtected
                              ? t("controlDash:dupes.wizard.lockedHint")
                              : t("controlDash:dupes.wizard.unlockedHint")}
                          >
                            {library.isProtected
                              ? <Lock size={15} aria-hidden="true" />
                              : <LockOpen size={15} aria-hidden="true" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {hasProtected && (
                  <MessageBox tone="info" title={t("controlDash:dupes.wizard.protectedTitle")}>
                    {t("controlDash:dupes.wizard.protectedBody")}
                  </MessageBox>
                )}
              </section>
            </div>
          )}

          {step === 2 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>{current.heading}</h3>
                <p>{current.blurb}</p>
              </div>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend={t("controlDash:dupes.wizard.cleanupType")}
                  className="cleanup-choice-grid"
                  value={duplicateType}
                  onChange={setDuplicateType}
                  disabled={saving}
                  options={cleanupTypeChoices}
                />
              </section>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend={t("controlDash:dupes.wizard.mediaType")}
                  className="cleanup-choice-grid"
                  value={mediaType}
                  onChange={setMediaType}
                  disabled={saving}
                  options={mediaTypeChoices}
                />
              </section>
            </div>
          )}

          {step === 3 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>{current.heading}</h3>
                <p>{current.blurb}</p>
              </div>

              <section className="cleanup-wizard-section">
                <h4>
                  {t("controlDash:dupes.wizard.foldersHeading")}
                  {/* Read once, then in the way. It answers "does this affect other
                      cleanups" and "will Clear empty the folder" — both worth having
                      to hand, neither worth a standing paragraph above the list. */}
                  <InfoHint label={t("controlDash:dupes.wizard.aboutInstructions")}>
                    {t("controlDash:dupes.wizard.aboutInstructionsBody")}
                  </InfoHint>
                  {instructionCount > 0 && (
                    <span className="count-badge">
                      {t("controlDash:dupes.wizard.instructionCount", { count: instructionCount })}
                    </span>
                  )}
                </h4>
                <p className="datagrid-muted dup-folder-hint">{t("controlDash:dupes.wizard.biggestFirst")}</p>

                {folderOptions.length > 0 && (
                  <div className="dup-folder-tools">
                    <input
                      type="search"
                      value={folderQuery}
                      placeholder={t("controlDash:dupes.wizard.findFolder")}
                      aria-label={t("controlDash:dupes.wizard.findFolderAria")}
                      onChange={(event) => setFolderQuery(event.target.value)}
                    />
                  </div>
                )}

                {foldersLoading ? (
                  <p className="management-empty">{t("controlDash:dupes.wizard.readingFolders")}</p>
                ) : folderOptions.length === 0 ? (
                  <p className="management-empty">{t("controlDash:dupes.wizard.noPhotosYet")}</p>
                ) : shownFolders.length === 0 ? (
                  <p className="management-empty">{t("controlDash:dupes.wizard.noFolderMatch", { query: folderQuery.trim() })}</p>
                ) : (
                  <div className="dup-folder-picker dup-folder-picker-tall">
                    {shownFolders.map((option) => {
                      const key = folderKey(option.libraryId, option.folderPath);
                      return (
                        <div className="dup-folder-choice dup-folder-row" key={key}>
                          {/* An empty path is not "the loose photos at the top" — every
                              instruction covers what is below it, and this one is below the
                              whole library, so it is named as the library. */}
                          <span className="dup-folder-choice-body">
                            <strong>{option.folderPath || t("controlDash:dupes.wizard.everywhereIn", { name: option.libraryName })}</strong>
                            <span className="datagrid-muted">
                              {option.folderPath ? `${option.libraryName} · ` : ""}
                              {t("controlDash:dupes.photoCount", { count: option.photoCount })}
                            </span>
                          </span>
                          <span
                            className="dup-mode-group"
                            role="radiogroup"
                            aria-label={t("controlDash:dupes.wizard.whenCopiesAria", {
                              where: option.folderPath || t("controlDash:dupes.wizard.everywhereIn", { name: option.libraryName })
                            })}
                          >
                            {modes.map((mode) => {
                              // Clearing out means letting this folder's copies go, which an
                              // external library cannot do — its files are not ours to remove.
                              // A locked folder reads the same way: deletion is refused there.
                              const blocked = mode.value === "clear" && (option.isProtected || option.isLocked);
                              return (
                                <label
                                  className={`dup-mode${(preferences[key] ?? "") === mode.value ? " is-on" : ""}${blocked ? " is-blocked" : ""}`}
                                  key={mode.short}
                                  title={blocked
                                    ? (option.isProtected
                                      ? t("controlDash:dupes.wizard.externalBlocked", { name: option.libraryName })
                                      : t("controlDash:dupes.wizard.lockedBlocked", { name: option.folderPath }))
                                    : mode.hint}
                                >
                                  <input
                                    type="radio"
                                    name={`pref-${key}`}
                                    checked={(preferences[key] ?? "") === mode.value}
                                    disabled={saving || blocked}
                                    onChange={() => setPreferences((current) => {
                                      const next = { ...current };
                                      if (mode.value === "") delete next[key];
                                      else next[key] = mode.value;
                                      return next;
                                    })}
                                  />
                                  <span>{mode.short}</span>
                                </label>
                              );
                            })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {step === 4 && (
            <div className="cleanup-summary-layout">
              <div className="cleanup-summary-main">
                <div className="cleanup-wizard-intro">
                  <h3>{current.heading}</h3>
                  <p>{current.blurb}</p>
                </div>

                <section className="cleanup-summary-card">
                  <h4>{t("controlDash:dupes.wizard.selectedLibraries")}</h4>
                  <div className="cleanup-summary-libraries">
                    {chosenLibraries.map((library) => (
                      <div className="cleanup-summary-library" key={library.id}>
                        <span className="cleanup-library-icon" aria-hidden="true">{libraryIcon(library)}</span>
                        <strong>{library.name}</strong>
                        <span className={`cleanup-library-badge ${library.mode}`}>{libraryModeLabel(library)}</span>
                      </div>
                    ))}
                    {chosenLibraries.length === 0 && (
                      <p className="datagrid-muted cleanup-summary-empty">{t("controlDash:dupes.wizard.noneSelected")}</p>
                    )}
                  </div>
                  <p className="cleanup-summary-count">
                    {t("controlDash:dupes.wizard.selectedCount", { count: chosenLibraries.length })}
                    {" · "}{t("controlDash:dupes.wizard.internalCount", { count: internalCount })}
                    {" · "}{t("controlDash:dupes.wizard.externalCount", { count: externalCount })}
                  </p>
                  {/* What pressing Run scan actually costs. Both numbers are read
                      straight out of the catalogue — no disk — so they are honest about
                      the wait before anyone commits to it. `toFingerprint` is an
                      estimate: the scan checks the real files and may read a few more. */}
                  <p className="cleanup-summary-count">
                    {toFingerprint > 0
                      ? t("controlDash:dupes.wizard.toFingerprint", { count: toFingerprint, total: toCheck })
                      : toCheck > 0
                        ? t("controlDash:dupes.wizard.toCheck", { count: toCheck })
                        : t("controlDash:dupes.wizard.nothingToScan")}
                  </p>
                </section>

                <section className="cleanup-summary-card cleanup-summary-choice">
                  <h4>{t("controlDash:dupes.wizard.cleanupType")}</h4>
                  <div>
                    <span className="cleanup-summary-icon">
                      {duplicateType === "files"
                        ? <File size={22} aria-hidden="true" />
                        : <FolderOpen size={22} aria-hidden="true" />}
                    </span>
                    <span>
                      <strong>{cleanupTypeLabel(duplicateType)}</strong>
                      <small>{cleanupTypeDescription(duplicateType)}</small>
                    </span>
                  </div>
                </section>

                <section className="cleanup-summary-card cleanup-summary-choice">
                  <h4>{t("controlDash:dupes.wizard.mediaType")}</h4>
                  <div>
                    <span className="cleanup-summary-icon">
                      {mediaType === "video" ? (
                        <Video size={22} aria-hidden="true" />
                      ) : mediaType === "both" ? (
                        <span className="cleanup-choice-pair" aria-hidden="true">
                          <ImageIcon size={18} />
                          <Video size={18} />
                        </span>
                      ) : (
                        <ImageIcon size={22} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong>{mediaTypeLabel(mediaType)}</strong>
                      <small>{mediaTypeDescription(mediaType)}</small>
                    </span>
                  </div>
                </section>

                {externalCount > 0 && (
                  <MessageBox tone="info" title={t("controlDash:dupes.wizard.comparisonOnlyTitle")}>
                    {t("controlDash:dupes.wizard.comparisonOnlyBody")}
                  </MessageBox>
                )}

                <div className="cleanup-summary-note">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>{t("controlDash:dupes.wizard.createsJobNote")}</span>
                </div>
              </div>

              <aside className="cleanup-overview-card" aria-label={t("controlDash:dupes.wizard.overviewAria")}>
                <h4>{t("controlDash:dupes.wizard.overviewTitle")}</h4>
                <dl>
                  <div>
                    <dt><UserRound size={20} aria-hidden="true" />{t("controlDash:dupes.wizard.owner")}</dt>
                    <dd>{job?.ownerName ?? ownerName}</dd>
                  </div>
                  <div>
                    <dt><RefreshCw size={20} aria-hidden="true" />{t("controlDash:dupes.wizard.estimatedAction")}</dt>
                    <dd>{t("controlDash:dupes.wizard.scanAndReview")}</dd>
                  </div>
                  <div>
                    <dt><Briefcase size={20} aria-hidden="true" />{t("controlDash:dupes.wizard.jobType")}</dt>
                    <dd>{t("controlDash:dupes.wizard.jobTypeValue")}</dd>
                  </div>
                </dl>
              </aside>
            </div>
          )}
        </div>
      </div>

      <div className="modal-actions cleanup-wizard-actions">
        {step > 1 && (
          <Button variant="secondary" disabled={saving} onClick={() => setStep(step - 1)}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{t("controlDash:dupes.wizard.back")}</span>
          </Button>
        )}
        <Button variant="secondary" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
        <span className="cleanup-wizard-action-spacer" aria-hidden="true" />
        {step < steps.length ? (
          <Button
            variant="primary"
            disabled={saving || chosen.length === 0}
            onClick={() => setStep(step + 1)}
          >
            <span>{t("controlDash:dupes.wizard.next")}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : (
          <>
            {job && (
              <Button variant="secondary" disabled={saving || chosen.length === 0} onClick={() => void save(false)}>
                {saving ? t("controlDash:dupes.wizard.saving") : t("controlDash:dupes.wizard.saveChanges")}
              </Button>
            )}
            <Button variant="primary" disabled={saving || chosen.length === 0} onClick={() => void save(true)}>
              <span>{saving ? t("controlDash:dupes.wizard.scanning") : t("controlDash:dupes.wizard.runScan")}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}