import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Link2, PackageOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, csrfToken } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonPickerModal } from "./PersonPickerModal";
import { lifeYears } from "./types";

// Imports a family tree from a file: a GEDCOM (.ged) from another genealogy
// program, or a package (.zip) from another isputnik.home server. A GEDCOM goes
// up as JSON and is written at once (add / replace). A package is uploaded,
// PLANNED on the server (nothing written), and shown as a preview: every person
// in it beside the person here they were matched with, and a decision on each —
// merge, use the package's values, keep what is here, add as new, or skip — plus
// the choice to replace the whole tree instead. Only then is it written
// (docs/family-tree-exchange-plan.md).

interface GedcomResult {
  personsCreated: number;
  unionsCreated: number;
  childrenLinked: number;
  eventsCreated: number;
  sourcesCreated: number;
  citationsCreated: number;
  personsRemoved: number;
  warnings: string[];
}

type PersonAction = "add" | "skip" | "merge" | "usePackage" | "keepMine";
interface PersonDecision { action: PersonAction; matchId?: string | null }
type ImportMode = "migrate" | "replace";

interface PersonMatch {
  localId: string;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  reason: "origin" | "nameAndBirth" | "name" | "manual";
}
type DifferenceField =
  | "name" | "maidenName" | "gender" | "birthDate" | "deathDate" | "deceased" | "birthplace" | "deathPlace"
  | "birthPin" | "deathPin" | "bio" | "portrait" | "parents";
interface Difference { field: DifferenceField; here: string | null; package: string | null; resolution: "keepHere" | "usePackage" }
interface PersonPreview {
  id: string;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  hasPortrait: boolean;
  photos: number;
  suggested: PersonMatch | null;
  match: PersonMatch | null;
  decision: PersonDecision;
  differences: Difference[];
  fills: DifferenceField[];
}
interface ImportSummary {
  personsCreated: number;
  personsMatched: number;
  personsFilled: number;
  personsOverwritten: number;
  personsSkipped: number;
  personsRemoved: number;
  unionsCreated: number;
  childrenLinked: number;
  eventsCreated: number;
  sourcesCreated: number;
  citationsCreated: number;
  portraitsSet: number;
  photosImported: number;
  photosReused: number;
  differences: number;
}
type NotCarried = "galleryLinks" | "branchEditors" | "photosNoStorage";
interface ImportPreview {
  mode: ImportMode;
  persons: PersonPreview[];
  summary: ImportSummary;
  notCarried: NotCarried[];
  warnings: string[];
}
interface UploadResponse {
  token: string;
  package: { exportedAt: string; appVersion: string | null; counts: Record<string, number> };
  preview: ImportPreview;
}
interface PackageResult { mode: ImportMode; summary: ImportSummary; warnings: string[] }

type Step =
  | { kind: "pick" }
  | { kind: "preview"; upload: UploadResponse; preview: ImportPreview }
  | { kind: "gedcomDone"; result: GedcomResult }
  | { kind: "packageDone"; result: PackageResult };

const isPackage = (file: File) => /\.zip$/i.test(file.name);

export function FamilyImportModal({
  personCount,
  onClose,
  onImported
}: {
  personCount: number;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [file, setFile] = useState<File | null>(null);
  const [gedcomMode, setGedcomMode] = useState<"add" | "replace">("add");
  const [mode, setMode] = useState<ImportMode>("migrate");
  const [decisions, setDecisions] = useState<Record<string, PersonDecision>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [pickingFor, setPickingFor] = useState<PersonPreview | null>(null);
  const [filter, setFilter] = useState("");
  const [onlyDecisions, setOnlyDecisions] = useState(false);
  const tokenRef = useRef<string | null>(null);

  // A pending upload is forgotten when the dialog closes without importing.
  useEffect(() => () => {
    const token = tokenRef.current;
    if (token) void Promise.resolve().then(() => api(`/api/family-tree/import/package/${token}`, { method: "DELETE" })).catch(() => {});
  }, []);

  const runGedcom = async () => {
    if (!file) return;
    setConfirming(false);
    setBusy(true);
    setError("");
    try {
      const gedcom = await file.text();
      const result = await api<GedcomResult>("/api/family-tree/import", {
        method: "POST",
        body: JSON.stringify({ gedcom, mode: gedcomMode })
      });
      setStep({ kind: "gedcomDone", result });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:gedcom.errors.default"));
    } finally {
      setBusy(false);
    }
  };

  const uploadPackage = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const token = csrfToken();
      const res = await fetch("/api/family-tree/import/package", {
        method: "POST",
        credentials: "include",
        headers: token ? { "X-CSRF-Token": token } : undefined,
        body: form
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || t("family:gedcom.errors.default"));
      }
      const upload = (await res.json()) as UploadResponse;
      tokenRef.current = upload.token;
      setDecisions({});
      setMode("migrate");
      setStep({ kind: "preview", upload, preview: upload.preview });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:gedcom.errors.default"));
    } finally {
      setBusy(false);
    }
  };

  // Every change of mind is re-planned on the server, so the counts and the
  // matches (a manual one frees the suggested person for someone else) stay true.
  const replan = async (nextMode: ImportMode, nextDecisions: Record<string, PersonDecision>) => {
    if (step.kind !== "preview" || !tokenRef.current) return;
    setMode(nextMode);
    setDecisions(nextDecisions);
    try {
      const { preview } = await api<{ preview: ImportPreview }>(`/api/family-tree/import/package/${tokenRef.current}/preview`, {
        method: "POST",
        body: JSON.stringify({ mode: nextMode, persons: nextDecisions })
      });
      setStep((current) => (current.kind === "preview" ? { ...current, preview } : current));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:gedcom.errors.default"));
    }
  };

  const decide = (person: PersonPreview, decision: PersonDecision) => {
    void replan(mode, { ...decisions, [person.id]: decision });
  };

  const applyPackage = async () => {
    if (!tokenRef.current) return;
    setConfirming(false);
    setBusy(true);
    setError("");
    try {
      const result = await api<PackageResult>(`/api/family-tree/import/package/${tokenRef.current}/apply`, {
        method: "POST",
        body: JSON.stringify({ mode, persons: decisions })
      });
      tokenRef.current = null;
      setStep({ kind: "packageDone", result });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:gedcom.errors.default"));
    } finally {
      setBusy(false);
    }
  };

  const fieldName = (field: DifferenceField) => t(`family:package.fields.${field}`);

  const visiblePersons = useMemo(() => {
    if (step.kind !== "preview") return [];
    const needle = filter.trim().toLowerCase();
    return step.preview.persons.filter((p) => {
      if (needle && !p.name.toLowerCase().includes(needle) && !(p.match?.name.toLowerCase().includes(needle))) return false;
      if (onlyDecisions && !p.match && !p.suggested) return false;
      return true;
    });
  }, [step, filter, onlyDecisions]);

  if (step.kind === "gedcomDone") {
    const { result } = step;
    const removedClause = result.personsRemoved > 0 ? t("family:gedcom.result.removedClause", { count: result.personsRemoved }) : "";
    const sourcesClause = (result.sourcesCreated > 0 || result.citationsCreated > 0)
      ? t("family:gedcom.result.sourcesClauseTemplate", {
          sources: t("family:gedcom.result.sourceCount", { count: result.sourcesCreated }),
          citations: t("family:gedcom.result.citationCount", { count: result.citationsCreated })
        })
      : "";
    return (
      <Modal variant="card" title={t("family:gedcom.importCompleteTitle")} onClose={onImported}>
        <MessageBox tone="success" title={t("family:gedcom.result.addedTitle", { count: result.personsCreated })}>
          {t("family:gedcom.result.bodyTemplate", {
            families: t("family:gedcom.result.familyCount", { count: result.unionsCreated }),
            links: t("family:gedcom.result.linkCount", { count: result.childrenLinked }),
            events: t("family:gedcom.result.eventCount", { count: result.eventsCreated }),
            removedClause
          })}
          {sourcesClause}
        </MessageBox>
        <Warnings warnings={result.warnings} />
        <div className="modal-actions">
          <Button variant="primary" onClick={onImported}>{t("common.done")}</Button>
        </div>
      </Modal>
    );
  }

  if (step.kind === "packageDone") {
    const { summary, warnings } = step.result;
    return (
      <Modal variant="card" title={t("family:gedcom.importCompleteTitle")} onClose={onImported}>
        <MessageBox tone="success" title={t("family:package.result.title", { count: summary.personsCreated })}>
          <p>{t("family:package.result.body", {
            matched: t("family:package.counts.matched", { count: summary.personsMatched }),
            families: t("family:gedcom.result.familyCount", { count: summary.unionsCreated }),
            events: t("family:gedcom.result.eventCount", { count: summary.eventsCreated }),
            portraits: t("family:package.counts.portraits", { count: summary.portraitsSet }),
            photos: t("family:package.counts.photos", { count: summary.photosImported + summary.photosReused })
          })}</p>
          {summary.personsRemoved > 0 && <p>{t("family:package.result.removed", { count: summary.personsRemoved })}</p>}
          {summary.differences > 0 && <p>{t("family:package.result.differences", { count: summary.differences })}</p>}
        </MessageBox>
        <Warnings warnings={warnings} />
        <div className="modal-actions">
          <Button variant="primary" onClick={onImported}>{t("common.done")}</Button>
        </div>
      </Modal>
    );
  }

  if (step.kind === "preview") {
    const { preview, upload } = step;
    const s = preview.summary;
    const summaryLine = [
      t("family:package.counts.added", { count: s.personsCreated }),
      t("family:package.counts.matched", { count: s.personsMatched }),
      s.personsSkipped > 0 ? t("family:package.counts.skipped", { count: s.personsSkipped }) : "",
      t("family:package.counts.families", { count: s.unionsCreated }),
      t("family:package.counts.photos", { count: s.photosImported + s.photosReused }),
      t("family:package.counts.differences", { count: s.differences })
    ].filter(Boolean).join(" · ");
    const exportedOn = new Date(upload.package.exportedAt).toLocaleDateString();
    return (
      <>
        <Modal
          variant="panel"
          title={t("family:package.previewTitle")}
          subtitle={t("family:package.exportedOn", { date: exportedOn, version: upload.package.appVersion ?? "?" })}
          icon={<PackageOpen size={20} />}
          className="ft-import-preview-modal"
          busy={busy}
          onClose={onClose}
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "replace" && personCount > 0) setConfirming(true);
            else void applyPackage();
          }}
        >
          <div className="modal-tab-content ft-import-preview">
            <fieldset className="ft-import-mode">
              <legend className="sr-only">{t("family:package.modeLegend")}</legend>
              <label className="ft-radio ft-import-mode-choice">
                <input type="radio" name="package-mode" checked={mode === "migrate"} disabled={busy} onChange={() => void replan("migrate", decisions)} />
                <span>
                  <strong>{t("family:package.modeMigrate")}</strong>
                  <small>{t("family:package.modeMigrateHint")}</small>
                </span>
              </label>
              <label className="ft-radio ft-import-mode-choice">
                <input type="radio" name="package-mode" checked={mode === "replace"} disabled={busy} onChange={() => void replan("replace", decisions)} />
                <span>
                  <strong>{t("family:package.modeReplace")}</strong>
                  <small>{personCount > 0 ? t("family:package.modeReplaceHint", { count: personCount }) : t("family:package.modeReplaceEmptyHint")}</small>
                </span>
              </label>
            </fieldset>

            <p className="ft-import-summary">{summaryLine}</p>

            {mode === "migrate" && preview.persons.length > 0 && (
              <>
                <div className="ft-import-tools">
                  <input
                    type="search"
                    className="ft-import-filter"
                    placeholder={t("family:package.filter")}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <label className="ft-radio">
                    <input type="checkbox" checked={onlyDecisions} onChange={(event) => setOnlyDecisions(event.target.checked)} />
                    <span>{t("family:package.onlyMatches")}</span>
                  </label>
                </div>
                <div className="ft-import-table-wrap">
                  <table className="ft-import-table">
                    <thead>
                      <tr>
                        <th>{t("family:package.table.inPackage")}</th>
                        <th>{t("family:package.table.here")}</th>
                        <th>{t("family:package.table.decision")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePersons.map((person) => (
                        <tr key={person.id} className={person.decision.action === "skip" ? "is-skipped" : undefined}>
                          <td>
                            <div className="ft-import-person">
                              <strong>{person.name}</strong>
                              <small>
                                {lifeYears(person)}
                                {person.hasPortrait ? ` · ${t("family:package.table.portrait")}` : ""}
                                {person.photos > 0 ? ` · ${t("family:package.counts.photos", { count: person.photos })}` : ""}
                              </small>
                            </div>
                          </td>
                          <td>
                            {person.match ? (
                              <div className="ft-import-person">
                                <strong>{person.match.name}</strong>
                                <small>
                                  {lifeYears(person.match)}
                                  {" · "}
                                  {t(`family:package.reason.${person.match.reason}`)}
                                </small>
                              </div>
                            ) : (
                              <div className="ft-import-person">
                                <span className="ft-import-new">{person.decision.action === "skip" ? t("family:package.table.skipped") : t("family:package.table.newPerson")}</span>
                                <Button variant="text" compact disabled={busy} onClick={() => setPickingFor(person)}>
                                  <Link2 size={14} aria-hidden="true" />
                                  {t("family:package.decision.matchWith")}
                                </Button>
                              </div>
                            )}
                          </td>
                          <td>
                            <select
                              className="ft-import-decision"
                              aria-label={t("family:package.table.decisionFor", { name: person.name })}
                              value={person.decision.action}
                              disabled={busy}
                              onChange={(event) => {
                                const action = event.target.value as PersonAction;
                                const matchId = person.match?.localId ?? person.suggested?.localId ?? null;
                                decide(person, action === "add" || action === "skip" ? { action } : { action, matchId });
                              }}
                            >
                              {(person.match || person.suggested) && (
                                <>
                                  <option value="merge">{t("family:package.decision.merge")}</option>
                                  <option value="usePackage">{t("family:package.decision.usePackage")}</option>
                                  <option value="keepMine">{t("family:package.decision.keepMine")}</option>
                                </>
                              )}
                              <option value="add">{t("family:package.decision.add")}</option>
                              <option value="skip">{t("family:package.decision.skip")}</option>
                            </select>
                            {(person.differences.length > 0 || person.fills.length > 0) && person.decision.action !== "keepMine" && (
                              <ul className="ft-import-details">
                                {person.fills.length > 0 && (
                                  <li>{t("family:package.fills", { fields: person.fills.map(fieldName).join(", ") })}</li>
                                )}
                                {person.differences.map((d) => (
                                  <li key={d.field} className={d.resolution === "usePackage" ? "is-taken" : undefined}>
                                    {d.field === "portrait" || d.field === "parents"
                                      ? t(`family:package.differenceKind.${d.field}`)
                                      : t("family:package.difference", { field: fieldName(d.field), here: d.here ?? "", package: d.package ?? "" })}
                                    {" — "}
                                    {t(d.resolution === "usePackage" ? "family:package.differenceTaken" : "family:package.differenceKept")}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visiblePersons.length === 0 && <p className="ft-modal-hint">{t("family:package.noneMatchFilter")}</p>}
                </div>
              </>
            )}

            <MessageBox tone="info" title={t("family:package.notCarriedTitle")}>
              <ul className="ft-import-warnings">
                {preview.notCarried.map((item) => <li key={item}>{t(`family:package.notCarried.${item}`)}</li>)}
              </ul>
            </MessageBox>
            <Warnings warnings={preview.warnings} />
            {error && <MessageBox tone="error" title={t("family:gedcom.errors.title")}>{error}</MessageBox>}
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
            <Button variant={mode === "replace" ? "danger" : "primary"} type="submit" disabled={busy}>
              <FileUp size={16} aria-hidden="true" />
              {busy ? t("family:gedcom.submitBusy") : mode === "replace" ? t("family:gedcom.modeReplaceLabel") : t("family:gedcom.submit")}
            </Button>
          </div>
        </Modal>

        {pickingFor && (
          <PersonPickerModal
            title={t("family:package.decision.pickTitle", { name: pickingFor.name })}
            allowCreate={false}
            excludeIds={preview.persons.map((p) => p.match?.localId).filter((id): id is string => Boolean(id))}
            onPick={(local) => { decide(pickingFor, { action: "merge", matchId: local.id }); setPickingFor(null); }}
            onClose={() => setPickingFor(null)}
          />
        )}

        {confirming && (
          <ConfirmDialog
            title={t("family:gedcom.confirmReplaceTitle")}
            confirmLabel={t("family:gedcom.confirmReplaceLabel")}
            busyLabel={t("family:gedcom.submitBusy")}
            danger
            busy={busy}
            onConfirm={() => void applyPackage()}
            onCancel={() => setConfirming(false)}
          >
            {t("family:gedcom.confirmReplaceBody", { count: personCount })}
          </ConfirmDialog>
        )}
      </>
    );
  }

  const packageChosen = file != null && isPackage(file);
  return (
    <>
      <Modal
        variant="card"
        title={t("family:gedcom.importTitle")}
        busy={busy}
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          if (packageChosen) void uploadPackage();
          else if (gedcomMode === "replace" && personCount > 0) setConfirming(true);
          else void runGedcom();
        }}
      >
        <p>{t("family:package.fileHint")}</p>
        <label className="field">
          <span>{t("family:package.fileFieldLabel")}</span>
          <input
            type="file"
            accept=".ged,.gedcom,.zip"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }}
            disabled={busy}
          />
        </label>
        {file && !packageChosen && personCount > 0 && (
          <fieldset className="ft-import-mode">
            <legend className="sr-only">{t("family:gedcom.modeLegendSr")}</legend>
            <label className="ft-radio">
              <input type="radio" name="gedcom-mode" checked={gedcomMode === "add"} onChange={() => setGedcomMode("add")} disabled={busy} />
              <span>{t("family:gedcom.modeAdd", { count: personCount })}</span>
            </label>
            <label className="ft-radio">
              <input type="radio" name="gedcom-mode" checked={gedcomMode === "replace"} onChange={() => setGedcomMode("replace")} disabled={busy} />
              <span>{t("family:gedcom.modeReplaceLabel")}</span>
            </label>
          </fieldset>
        )}
        {packageChosen && <p className="ft-modal-hint">{t("family:package.previewHint")}</p>}
        {error && <MessageBox tone="error" title={t("family:gedcom.errors.title")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={!file || busy}>
            <FileUp size={16} aria-hidden="true" />
            {busy
              ? (packageChosen ? t("family:package.uploading") : t("family:gedcom.submitBusy"))
              : (packageChosen ? t("family:package.continue") : t("family:gedcom.submit"))}
          </Button>
        </div>
      </Modal>

      {confirming && (
        <ConfirmDialog
          title={t("family:gedcom.confirmReplaceTitle")}
          confirmLabel={t("family:gedcom.confirmReplaceLabel")}
          busyLabel={t("family:gedcom.submitBusy")}
          danger
          busy={busy}
          onConfirm={() => void runGedcom()}
          onCancel={() => setConfirming(false)}
        >
          {t("family:gedcom.confirmReplaceBody", { count: personCount })}
        </ConfirmDialog>
      )}
    </>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const { t } = useTranslation(["family"]);
  if (warnings.length === 0) return null;
  return (
    <MessageBox tone="warning" title={t("family:gedcom.result.warningsTitle", { count: warnings.length })}>
      <ul className="ft-import-warnings">
        {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>
    </MessageBox>
  );
}
