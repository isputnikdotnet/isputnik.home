import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, X } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { CommandRow, GroupedList, InfoRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";
import { useAppName } from "../sections/AppsSection";
import { downloadReportText, HIDE_KINDS, type ReportSpan } from "./ReportDialog";

// Saved reports (modules/diagnostics/saved.ts): the report text exactly as an admin
// saved it from the report window, so one made before a fix can sit beside one made
// after, or be attached later. The server keeps the last 10. Diagnostics lists them
// all; a part's own page only those that carry that part.

export interface SavedReportSummary {
  id: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  span: ReportSpan;
  parts: string[];
  hidden: string[];
  sizeBytes: number;
}

/** A part's key in a saved report: this server's sections all count as "system". */
export const savedPartKey = (part: string) => (part === "home" ? "system" : `container:${part}`);

export function useSavedReports(part?: string) {
  const [reports, setReports] = useState<SavedReportSummary[] | null>(null);
  const [kept, setKept] = useState(10);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const body = await api<{ reports: SavedReportSummary[]; kept: number }>(`/api/admin/diagnostics/saved${part ? `?part=${encodeURIComponent(savedPartKey(part))}` : ""}`);
      setReports(Array.isArray(body.reports) ? body.reports : []);
      setKept(typeof body.kept === "number" ? body.kept : 10);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [part]);
  useEffect(() => {
    void load();
  }, [load]);
  return { reports, kept, error, load };
}

/** "iSputnik, Video" — the parts a report carries, by who they belong to. */
function useOwners() {
  const { t } = useTranslation(["controlAdmin"]);
  const appName = useAppName();
  return (parts: string[]) => {
    const owners: string[] = [];
    if (parts.some((key) => !key.startsWith("container:"))) owners.push(t("controlAdmin:diagnostics.home"));
    for (const key of parts) if (key.startsWith("container:")) owners.push(appName(key.slice("container:".length)));
    return owners.join(", ");
  };
}

export function SavedReports({ saved }: { saved: ReturnType<typeof useSavedReports> }) {
  const { t, i18n } = useTranslation(["controlAdmin"]);
  const owners = useOwners();
  const [open, setOpen] = useState<SavedReportSummary | null>(null);
  const { reports, kept, error, load } = saved;

  const when = (at: string) => new Date(at).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const privacy = (hidden: string[]) =>
    hidden.length >= HIDE_KINDS.length ? t("controlAdmin:diagnostics.saved.privacyHidden") : hidden.length === 0 ? t("controlAdmin:diagnostics.saved.privacyAll") : t("controlAdmin:diagnostics.saved.privacySome");
  const subOf = (report: SavedReportSummary) =>
    [relativeTime(report.createdAt), t(`controlAdmin:diagnostics.report.span.${report.span}`), owners(report.parts), privacy(report.hidden)].join(" · ");

  return (
    <>
      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.saved.loadFailed")}>{error}</MessageBox>}
      <GroupedList id="saved-reports" title={t("controlAdmin:diagnostics.saved.title")} note={t("controlAdmin:diagnostics.saved.note", { count: kept })}>
        {reports?.map((report) => (
          <CommandRow
            key={report.id}
            icon={<FileText size={17} />}
            label={when(report.createdAt)}
            sub={subOf(report)}
            value={t("controlAdmin:diagnostics.saved.view")}
            onClick={() => setOpen(report)}
          />
        ))}
        {reports !== null && reports.length === 0 && <InfoRow label={t("controlAdmin:diagnostics.saved.empty")} />}
        {reports === null && !error && <InfoRow label={t("controlAdmin:diagnostics.looking")} />}
      </GroupedList>
      {open && (
        <SavedReportViewer
          report={open}
          when={when(open.createdAt)}
          title={t("controlAdmin:diagnostics.saved.viewTitle", { when: when(open.createdAt) })}
          subtitle={[subOf(open), formatBytes(open.sizeBytes), open.createdByName ? t("controlAdmin:diagnostics.saved.by", { name: open.createdByName }) : null].filter(Boolean).join(" · ")}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function SavedReportViewer({ report, when, title, subtitle, onClose, onDeleted }: { report: SavedReportSummary; when: string; title: string; subtitle: string; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation(["controlAdmin", "common"]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    let live = true;
    api<{ report: { text: string } }>(`/api/admin/diagnostics/saved/${encodeURIComponent(report.id)}`)
      .then((body) => live && setText(body.report.text))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [report.id]);

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("controlAdmin:diagnostics.copyFailed"));
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/admin/diagnostics/saved/${encodeURIComponent(report.id)}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal
        title={title}
        subtitle={subtitle}
        icon={<FileText size={20} />}
        onClose={onClose}
        className="diagnostics-report-modal"
        headerAction={
          <Button variant="bare" className="modal-close" onClick={onClose} aria-label={t("common:common.close")} title={t("common:common.close")}>
            <X size={18} aria-hidden="true" />
          </Button>
        }
      >
        {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.saved.openFailed")}>{error}</MessageBox>}
        <div className="diagnostics-report-body">
          <pre className="diagnostics-text" tabIndex={0} aria-label={t("controlAdmin:diagnostics.previewTitle")}>
            {text ?? t("controlAdmin:diagnostics.making")}
          </pre>
        </div>
        <div className="modal-actions">
          <Button variant="danger" className="diagnostics-saved-delete" onClick={() => setConfirming(true)} disabled={text === null}>{t("controlAdmin:diagnostics.saved.delete")}</Button>
          <Button variant="secondary" onClick={() => void copy()} disabled={text === null}>
            {copied ? t("controlAdmin:diagnostics.copied") : t("controlAdmin:diagnostics.copy")}
          </Button>
          <Button variant="primary" onClick={() => text !== null && downloadReportText(text, report.createdAt)} disabled={text === null}>{t("controlAdmin:diagnostics.download")}</Button>
        </div>
      </Modal>
      {confirming && (
        <ConfirmDialog
          title={t("controlAdmin:diagnostics.saved.deleteTitle", { when })}
          confirmLabel={t("controlAdmin:diagnostics.saved.deleteConfirm")}
          busyLabel={t("controlAdmin:diagnostics.saved.deleting")}
          danger
          busy={deleting}
          error={deleteError}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        >
          {t("controlAdmin:diagnostics.saved.deleteBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
