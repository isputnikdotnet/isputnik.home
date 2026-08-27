import { useState } from "react";
import { FileUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

interface ImportResult {
  personsCreated: number;
  unionsCreated: number;
  childrenLinked: number;
  eventsCreated: number;
  sourcesCreated: number;
  citationsCreated: number;
  personsRemoved: number;
  warnings: string[];
}

// Imports a GEDCOM (.ged) family-tree file. The file's text goes up as JSON;
// "replace" mode is confirmed separately because it deletes the current tree.
export function GedcomImportModal({
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
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const runImport = async () => {
    if (!file) return;
    setConfirming(false);
    setBusy(true);
    setError("");
    try {
      const gedcom = await file.text();
      setResult(await api<ImportResult>("/api/family-tree/import", {
        method: "POST",
        body: JSON.stringify({ gedcom, mode })
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:gedcom.errors.default"));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const removedClause = result.personsRemoved > 0
      ? t("family:gedcom.result.removedClause", { count: result.personsRemoved })
      : "";
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
        {result.warnings.length > 0 && (
          <MessageBox tone="warning" title={t("family:gedcom.result.warningsTitle", { count: result.warnings.length })}>
            <ul className="ft-import-warnings">
              {result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>
          </MessageBox>
        )}
        <div className="modal-actions">
          <Button variant="primary" onClick={onImported}>{t("common.done")}</Button>
        </div>
      </Modal>
    );
  }

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
          if (mode === "replace" && personCount > 0) setConfirming(true);
          else void runImport();
        }}
      >
        <p>
          {t("family:gedcom.introText")}
        </p>
        <label className="field">
          <span>{t("family:gedcom.fileFieldLabel")}</span>
          <input
            type="file"
            accept=".ged,.gedcom"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }}
            disabled={busy}
          />
        </label>
        {personCount > 0 && (
          <fieldset className="ft-import-mode">
            <legend className="sr-only">{t("family:gedcom.modeLegendSr")}</legend>
            <label className="ft-radio">
              <input
                type="radio"
                name="gedcom-mode"
                checked={mode === "add"}
                onChange={() => setMode("add")}
                disabled={busy}
              />
              <span>{t("family:gedcom.modeAdd", { count: personCount })}</span>
            </label>
            <label className="ft-radio">
              <input
                type="radio"
                name="gedcom-mode"
                checked={mode === "replace"}
                onChange={() => setMode("replace")}
                disabled={busy}
              />
              <span>{t("family:gedcom.modeReplaceLabel")}</span>
            </label>
          </fieldset>
        )}
        {error && <MessageBox tone="error" title={t("family:gedcom.errors.title")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={!file || busy}>
            <FileUp size={16} aria-hidden="true" />
            {busy ? t("family:gedcom.submitBusy") : t("family:gedcom.submit")}
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
          onConfirm={() => void runImport()}
          onCancel={() => setConfirming(false)}
        >
          {t("family:gedcom.confirmReplaceBody", { count: personCount })}
        </ConfirmDialog>
      )}
    </>
  );
}
