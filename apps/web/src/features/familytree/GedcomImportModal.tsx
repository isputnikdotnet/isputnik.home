import { useState } from "react";
import { FileUp } from "lucide-react";
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
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal variant="card" title="Import complete" onClose={onImported}>
        <MessageBox tone="success" title={`Added ${result.personsCreated} ${result.personsCreated === 1 ? "person" : "people"}`}>
          {result.unionsCreated} {result.unionsCreated === 1 ? "family" : "families"},{" "}
          {result.childrenLinked} parent–child {result.childrenLinked === 1 ? "link" : "links"}, and{" "}
          {result.eventsCreated} life {result.eventsCreated === 1 ? "event" : "events"} were created
          {result.personsRemoved > 0 && <>; {result.personsRemoved} previous {result.personsRemoved === 1 ? "person" : "people"} were replaced</>}.
          {(result.sourcesCreated > 0 || result.citationsCreated > 0) && (
            <> {result.sourcesCreated} {result.sourcesCreated === 1 ? "source" : "sources"} and{" "}
            {result.citationsCreated} {result.citationsCreated === 1 ? "citation" : "citations"} came along.</>
          )}
        </MessageBox>
        {result.warnings.length > 0 && (
          <MessageBox tone="warning" title={`${result.warnings.length} ${result.warnings.length === 1 ? "entry" : "entries"} needed attention`}>
            <ul className="ft-import-warnings">
              {result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>
          </MessageBox>
        )}
        <div className="modal-actions">
          <Button variant="primary" onClick={onImported}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Modal
        variant="card"
        title="Import GEDCOM"
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
          Import a family tree from a GEDCOM (.ged) file — the format Ancestry, MyHeritage,
          FamilySearch, and Gramps export.
        </p>
        <label className="field">
          <span>GEDCOM file</span>
          <input
            type="file"
            accept=".ged,.gedcom"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }}
            disabled={busy}
          />
        </label>
        {personCount > 0 && (
          <fieldset className="ft-import-mode">
            <legend className="sr-only">What to do with the current tree</legend>
            <label className="ft-radio">
              <input
                type="radio"
                name="gedcom-mode"
                checked={mode === "add"}
                onChange={() => setMode("add")}
                disabled={busy}
              />
              <span>Add to the current tree ({personCount} {personCount === 1 ? "person" : "people"} kept)</span>
            </label>
            <label className="ft-radio">
              <input
                type="radio"
                name="gedcom-mode"
                checked={mode === "replace"}
                onChange={() => setMode("replace")}
                disabled={busy}
              />
              <span>Replace the current tree</span>
            </label>
          </fieldset>
        )}
        {error && <MessageBox tone="error" title="Unable to import">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!file || busy}>
            <FileUp size={16} aria-hidden="true" />
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
      </Modal>

      {confirming && (
        <ConfirmDialog
          title="Replace the family tree?"
          confirmLabel="Replace and import"
          busyLabel="Importing…"
          danger
          busy={busy}
          onConfirm={() => void runImport()}
          onCancel={() => setConfirming(false)}
        >
          All {personCount} current {personCount === 1 ? "person" : "people"}, their relationships,
          portraits, and photo attachments will be deleted before importing. Gallery photos and
          face clusters themselves are not affected.
        </ConfirmDialog>
      )}
    </>
  );
}
