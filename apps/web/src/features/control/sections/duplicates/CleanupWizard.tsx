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
import {
  ArrowLeft, ArrowRight, Briefcase, Check, Cloud, File, FolderOpen, HardDrive,
  Image as ImageIcon, Lock, RefreshCw, ShieldCheck, Smartphone, UserRound, Video
} from "lucide-react";
import { api } from "../../../../api";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { ChoiceGroup, type Choice } from "../../../../shared/ChoiceGroup";
import { Modal } from "../../../../shared/Modal";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";
import type { DuplicateJob, DuplicateKind, LibraryOption, MediaKind } from "./cleanup-types";

const cleanupTypeLabel = (type: DuplicateKind): string =>
  type === "folders" ? "Duplicate folders" : "Individual files";

const cleanupTypeDescription = (type: DuplicateKind): string =>
  type === "folders"
    ? "Compare duplicate folders and their contents"
    : "Review duplicate photos or videos one by one";

const mediaTypeLabel = (type: MediaKind): string =>
  type === "photo" ? "Photos" : type === "video" ? "Videos" : "Photos and videos";

const mediaTypeDescription = (type: MediaKind): string =>
  type === "photo"
    ? "Image fingerprints only"
    : type === "video"
      ? "Video fingerprints only"
      : "Include both images and videos";

function libraryModeLabel(library: LibraryOption): string {
  return library.mode === "external" ? "External" : "Internal";
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
}

type PreferenceMode = "keep" | "clear";

/** Keyed the same way the server stores them: library + path. */
const folderKey = (libraryId: string, folderPath: string): string => `${libraryId} ${folderPath}`;

const MODES: { value: PreferenceMode | ""; short: string; hint: string }[] = [
  { value: "keep", short: "Keep", hint: "When copies are in several places, keep this one" },
  { value: "", short: "—", hint: "Let the usual rules decide" },
  { value: "clear", short: "Clear", hint: "Keep the copies elsewhere and let this folder's go" }
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
  const [step, setStep] = useState(Math.min(job?.currentStep ?? 1, 3));
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
    if (step !== 2 || chosen.length === 0) return;
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
  const shownFolders = useMemo(() => folderOptions.filter((option) => !needle
    || option.folderPath.toLowerCase().includes(needle)
    || option.libraryName.toLowerCase().includes(needle)), [folderOptions, needle]);
  const instructionCount = Object.keys(preferences).length;
  const stepName = step === 1 ? "Select what to scan" : step === 2 ? "Folder instructions" : "Review and run";

  const cleanupTypeChoices: Choice<DuplicateKind>[] = [
    {
      value: "folders",
      label: "Duplicate folders",
      description: "Compare duplicate folders and their contents",
      icon: <FolderOpen size={22} />
    },
    {
      value: "files",
      label: "Individual files",
      description: "Review duplicate photos or videos one by one",
      icon: <File size={22} />
    }
  ];

  const mediaTypeChoices: Choice<MediaKind>[] = [
    {
      value: "photo",
      label: "Photos",
      description: "Image fingerprints only",
      icon: <ImageIcon size={21} />
    },
    {
      value: "video",
      label: "Videos",
      description: "Video fingerprints only",
      icon: <Video size={21} />
    },
    {
      value: "both",
      label: "Photos and videos",
      description: "Include both images and videos",
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
      setError(err instanceof Error ? err.message : "Unable to save this cleanup");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={job ? "Change duplicate cleanup job" : "Create duplicate cleanup job"}
      subtitle={`Step ${step} of 3 · ${stepName}`}
      icon={<FolderOpen size={30} />}
      className="cleanup-wizard-modal"
      headerClassName="cleanup-wizard-header"
      busy={saving}
      onClose={onClose}
    >
      <div className="cleanup-wizard-shell">
        <aside className="cleanup-wizard-rail" aria-label="Duplicate cleanup steps">
          {[
            { value: 1, title: "Scan setup", note: "Libraries, cleanup type, media" },
            { value: 2, title: "Folder instructions", note: "Which copies to favour" },
            { value: 3, title: "Summary", note: "Review and run" }
          ].map((item) => {
            const done = step > item.value;
            const active = step === item.value;
            return (
              <div
                className={`cleanup-step${active ? " is-active" : ""}${done ? " is-done" : ""}`}
                aria-current={active ? "step" : undefined}
                key={item.value}
              >
                <span className="cleanup-step-dot" aria-hidden="true">
                  {done ? <Check size={14} /> : item.value}
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
          {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

          {step === 1 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>Select what to scan</h3>
                <p>Choose libraries, cleanup type, and media type for this duplicate cleanup job.</p>
              </div>

              <section className="cleanup-wizard-section">
                <h4>1. Select libraries</h4>
                {libraries.length === 0 ? (
                  <MessageBox tone="warning" title="No gallery libraries">
                    Create a gallery library before starting a duplicate cleanup job.
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
                            ariaLabel={`${included ? "Exclude" : "Include"} ${library.name}`}
                            className="cleanup-library-toggle"
                          />
                          {library.isProtected && (
                            <span className="cleanup-library-lock" title="This library is protected from cleanup actions">
                              <Lock size={15} aria-hidden="true" />
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {hasProtected && (
                  <MessageBox tone="info" title="External libraries stay protected">
                    External libraries can be included for comparison, but files there cannot be cleaned.
                  </MessageBox>
                )}
              </section>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend="2. Cleanup type"
                  className="cleanup-choice-grid"
                  value={duplicateType}
                  onChange={setDuplicateType}
                  disabled={saving}
                  options={cleanupTypeChoices}
                />
              </section>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend="3. Media type"
                  className="cleanup-choice-grid"
                  value={mediaType}
                  onChange={setMediaType}
                  disabled={saving}
                  options={mediaTypeChoices}
                />
              </section>
            </div>
          )}

          {step === 2 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>Folder instructions</h3>
                <p>
                  Optional. Say in advance which folder a photo should be kept in when copies
                  of it turn up in several — the scan then follows that instead of guessing.
                </p>
              </div>

              <MessageBox tone="info" title="These belong to this cleanup">
                Nothing is inherited and nothing is shared: what you set here shapes this
                cleanup and no other. Clearing a folder out never empties it — a photo with no
                copy anywhere else is nobody's duplicate, and a set whose copies are all in
                cleared folders still keeps one.
              </MessageBox>

              <section className="cleanup-wizard-section">
                <h4>
                  Folders in the chosen libraries
                  {instructionCount > 0 && (
                    <span className="count-badge">
                      {instructionCount} instruction{instructionCount === 1 ? "" : "s"}
                    </span>
                  )}
                </h4>

                {folderOptions.length > 0 && (
                  <div className="dup-folder-tools">
                    <input
                      type="search"
                      value={folderQuery}
                      placeholder="Find a folder"
                      aria-label="Find a folder in this list"
                      onChange={(event) => setFolderQuery(event.target.value)}
                    />
                  </div>
                )}

                {foldersLoading ? (
                  <p className="management-empty">Reading the folder list…</p>
                ) : folderOptions.length === 0 ? (
                  <p className="management-empty">These libraries hold no photos yet, so there is nothing to instruct.</p>
                ) : shownFolders.length === 0 ? (
                  <p className="management-empty">No folder matches “{folderQuery.trim()}”.</p>
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
                            <strong>{option.folderPath || `Everywhere in ${option.libraryName}`}</strong>
                            <span className="datagrid-muted">
                              {option.folderPath ? `${option.libraryName} · ` : ""}
                              {option.photoCount.toLocaleString()} photo{option.photoCount === 1 ? "" : "s"}
                            </span>
                          </span>
                          <span
                            className="dup-mode-group"
                            role="radiogroup"
                            aria-label={`When copies are in several places, ${option.folderPath || `everywhere in ${option.libraryName}`}`}
                          >
                            {MODES.map((mode) => {
                              // Clearing out means letting this folder's copies go, which an
                              // external library cannot do — its files are not ours to remove.
                              const blocked = mode.value === "clear" && option.isProtected;
                              return (
                                <label
                                  className={`dup-mode${(preferences[key] ?? "") === mode.value ? " is-on" : ""}${blocked ? " is-blocked" : ""}`}
                                  key={mode.short}
                                  title={blocked ? `"${option.libraryName}" is external, so nothing can be cleared out of it` : mode.hint}
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

          {step === 3 && (
            <div className="cleanup-summary-layout">
              <div className="cleanup-summary-main">
                <div className="cleanup-wizard-intro">
                  <h3>Summary</h3>
                  <p>Review your selections before starting the duplicate cleanup scan.</p>
                </div>

                <section className="cleanup-summary-card">
                  <h4>1. Selected libraries</h4>
                  <div className="cleanup-summary-libraries">
                    {chosenLibraries.map((library) => (
                      <div className="cleanup-summary-library" key={library.id}>
                        <span className="cleanup-library-icon" aria-hidden="true">{libraryIcon(library)}</span>
                        <strong>{library.name}</strong>
                        <span className={`cleanup-library-badge ${library.mode}`}>{libraryModeLabel(library)}</span>
                      </div>
                    ))}
                    {chosenLibraries.length === 0 && (
                      <p className="datagrid-muted cleanup-summary-empty">No libraries selected.</p>
                    )}
                  </div>
                  <p className="cleanup-summary-count">
                    {chosenLibraries.length} librar{chosenLibraries.length === 1 ? "y" : "ies"} selected
                    {" · "}{internalCount} internal
                    {" · "}{externalCount} external
                  </p>
                  {/* What pressing Run scan actually costs. Both numbers are read
                      straight out of the catalogue — no disk — so they are honest about
                      the wait before anyone commits to it. `toFingerprint` is an
                      estimate: the scan checks the real files and may read a few more. */}
                  <p className="cleanup-summary-count">
                    {toFingerprint > 0
                      ? `${toFingerprint.toLocaleString()} photo${toFingerprint === 1 ? "" : "s"} to fingerprint first — read from disk, so this can take a while. The rest of the ${toCheck.toLocaleString()} worth checking are already done.`
                      : toCheck > 0
                        ? `${toCheck.toLocaleString()} photo${toCheck === 1 ? "" : "s"} to check, all already fingerprinted — this scan will be quick.`
                        : "Nothing here shares a file size with another photo, so there is nothing for a scan to find."}
                  </p>
                </section>

                <section className="cleanup-summary-card cleanup-summary-choice">
                  <h4>2. Cleanup type</h4>
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
                  <h4>3. Media type</h4>
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
                  <MessageBox tone="info" title="External libraries are comparison only">
                    They are always protected and cannot be cleaned or selected for deletion.
                  </MessageBox>
                )}

                <div className="cleanup-summary-note">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>This scan creates one active duplicate cleanup job assigned to the current user.</span>
                </div>
              </div>

              <aside className="cleanup-overview-card" aria-label="Job overview">
                <h4>Job overview</h4>
                <dl>
                  <div>
                    <dt><UserRound size={20} aria-hidden="true" />Owner</dt>
                    <dd>{job?.ownerName ?? ownerName}</dd>
                  </div>
                  <div>
                    <dt><RefreshCw size={20} aria-hidden="true" />Estimated action</dt>
                    <dd>Scan and review</dd>
                  </div>
                  <div>
                    <dt><Briefcase size={20} aria-hidden="true" />Job type</dt>
                    <dd>Duplicate cleanup</dd>
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
            <span>Back</span>
          </Button>
        )}
        <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
        <span className="cleanup-wizard-action-spacer" aria-hidden="true" />
        {step < 3 ? (
          <Button
            variant="primary"
            disabled={saving || chosen.length === 0}
            onClick={() => setStep(step + 1)}
          >
            <span>Next</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : (
          <>
            {job && (
              <Button variant="secondary" disabled={saving || chosen.length === 0} onClick={() => void save(false)}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            )}
            <Button variant="primary" disabled={saving || chosen.length === 0} onClick={() => void save(true)}>
              <span>{saving ? "Scanning…" : "Run scan"}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}