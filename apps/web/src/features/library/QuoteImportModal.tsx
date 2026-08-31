import { useState } from "react";
import { FileUp, Quote as QuoteIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

export interface ImportSummary {
  dryRun: boolean;
  total: number;
  imported: number;
  skippedDuplicates: number;
  invalidCount: number;
  invalid: { index: number; reason: string }[];
}

/** How many of the server's per-row complaints to spell out before summarising. */
const SHOWN_ISSUES = 5;

// Bulk-import a JSON quote pack. Picking a file immediately runs it as a DRY RUN,
// which writes nothing — so the counts on screen ("1,240 new, 63 already saved")
// are the real answer for this exact file, not an estimate, and the import button
// commits precisely what was previewed.
export function QuoteImportModal({
  onClose,
  onImported
}: {
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}) {
  const { t } = useTranslation(["common", "user"]);
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState<unknown>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The file's name rides along on the real import so the run can be recognised
  // later and undone as one event. A dry run writes nothing, so it sends none.
  const post = (parsed: unknown, dryRun: boolean) => {
    const body = !dryRun && parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), fileName }
      : parsed;
    return api<ImportSummary>(`/api/library/quotes/import${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  };

  const pickFile = async (file: File | null) => {
    setPayload(null);
    setPreview(null);
    setError("");
    setFileName(file?.name ?? "");
    if (!file) return;
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setPayload(parsed);
      setPreview(await post(parsed, true));
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? t("user:quotes.import.notJson")
          : err instanceof Error ? err.message : t("user:quotes.import.failed")
      );
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (payload === null) return;
    setBusy(true);
    setError("");
    try {
      onImported(await post(payload, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:quotes.import.failed"));
    } finally {
      setBusy(false);
    }
  };

  const issues = preview?.invalid ?? [];

  return (
    <Modal
      variant="card"
      title={t("user:quotes.import.title")}
      icon={<QuoteIcon size={18} />}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (preview && preview.imported > 0) void runImport();
      }}
    >
      <p className="quote-import-intro">{t("user:quotes.import.intro")}</p>

      <label className="field">
        <span>{t("user:quotes.import.fileField")}</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => void pickFile(event.target.files?.[0] ?? null)}
          disabled={busy}
        />
      </label>

      {busy && !preview && fileName && (
        <p className="quote-import-intro">{t("user:quotes.import.checking")}</p>
      )}

      {preview && (
        <MessageBox
          tone={preview.imported > 0 ? "info" : "warning"}
          title={t("user:quotes.import.previewTitle", { count: preview.total })}
        >
          <ul className="quote-import-summary">
            <li>{t("user:quotes.import.newCount", { count: preview.imported })}</li>
            <li>{t("user:quotes.import.duplicateCount", { count: preview.skippedDuplicates })}</li>
            {preview.invalidCount > 0 && (
              <li>{t("user:quotes.import.invalidCount", { count: preview.invalidCount })}</li>
            )}
          </ul>
          {issues.length > 0 && (
            <ul className="quote-import-issues">
              {issues.slice(0, SHOWN_ISSUES).map((issue) => (
                <li key={issue.index}>
                  {t("user:quotes.import.rowIssue", { row: issue.index + 1, reason: issue.reason })}
                </li>
              ))}
              {preview.invalidCount > SHOWN_ISSUES && (
                <li>{t("user:quotes.import.moreIssues", { count: preview.invalidCount - SHOWN_ISSUES })}</li>
              )}
            </ul>
          )}
        </MessageBox>
      )}

      {error && <MessageBox tone="error" title={t("user:quotes.import.errorTitle")}>{error}</MessageBox>}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !preview || preview.imported === 0}>
          <FileUp size={16} aria-hidden="true" />
          {busy && preview
            ? t("user:quotes.import.submitBusy")
            : t("user:quotes.import.submit", { count: preview?.imported ?? 0 })}
        </Button>
      </div>
    </Modal>
  );
}
