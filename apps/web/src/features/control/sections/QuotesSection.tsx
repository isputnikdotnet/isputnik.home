import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, FileText, Quote as QuoteIcon } from "lucide-react";
import { formatDateTime } from "../../../shared/dates";
import { api } from "../../../api";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ActionRow, AddRow, GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { ControlSectionHead } from "../ControlSectionHead";
import { QuoteImportModal } from "../../library/QuoteImportModal";

// Where quote packs are brought in and taken back out. Importing lives here
// rather than on the Quotes page because a pack decides what the whole house
// reads — it is an administrative act, like adding a library, and the Quotes
// page is where everyone reads and writes their own.
//
// Each import is kept as the event it was, so a pack that turned out to be full
// of rubbish can be undone in one go instead of one quote at a time. Grouped rows
// (control panel v2): the packs as rows ending in "Import a pack", each opening a
// page of its own (?show=import:<id>) with Delete.
interface QuoteImport {
  id: string;
  fileName: string | null;
  createdAt: string;
  /** How many the run brought in. */
  importedCount: number;
  /** How many are still here — lower once quotes have been deleted by hand. */
  remainingCount: number;
}

function formatWhen(value: string): string {
  return formatDateTime(value, "numeric", "seconds") || value;
}

export function QuotesSection() {
  const { t } = useTranslation(["common", "user", "controlAdmin", "control"]);
  const [imports, setImports] = useState<QuoteImport[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<QuoteImport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [show, go] = useQueryPage();

  const load = useCallback(() =>
    api<{ imports: QuoteImport[] }>("/api/library/quotes/imports")
      .then((payload) => setImports(payload.imports))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:common.unableToLoad"))), [t]);

  useEffect(() => { void load(); }, [load]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setError("");
    try {
      const { deleted } = await api<{ deleted: number }>(`/api/library/quotes/imports/${deleting.id}`, {
        method: "DELETE"
      });
      await load();
      setDeleting(null);
      go(null);
      setNotice(t("controlAdmin:quotes.deleted", { count: deleted }));
      window.setTimeout(() => setNotice(""), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:quotes.deleteFailed"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const nameOf = (entry: QuoteImport) => entry.fileName || t("controlAdmin:quotes.unnamedFile");
  // What is left, not what arrived — quotes can be deleted singly.
  const countOf = (entry: QuoteImport) => entry.remainingCount === entry.importedCount
    ? t("controlAdmin:quotes.quoteCount", { count: entry.remainingCount })
    : t("controlAdmin:quotes.quoteCountOf", { remaining: entry.remainingCount, imported: entry.importedCount });

  const open = show?.startsWith("import:") ? imports?.find((entry) => entry.id === show.slice(7)) ?? null : null;

  return (
    <>
      <ControlSectionHead
        section="quotes"
        className="control-head-compact"
        icon={<QuoteIcon size={30} />}
        description={open ? undefined : t("controlAdmin:quotes.headDescription")}
        title={open ? nameOf(open) : undefined}
        back={show ? { href: queryPageHref(null), label: t("control:ui.back") } : undefined}
      >
        {!show && <RefreshButton onRefresh={load} />}
      </ControlSectionHead>

      <div className="grouped-page">
        {error && <MessageBox tone="error" title={t("user:common.unableToLoad")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("controlAdmin:quotes.doneTitle")}>{notice}</MessageBox>}

        {imports === null ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : show ? (
          open ? (
            <>
              <GroupedList>
                <InfoRow icon={<FileText size={17} />} label={nameOf(open)} sub={formatWhen(open.createdAt)} />
                <InfoRow label={t("controlAdmin:quotes.quotesRow")} value={countOf(open)} />
              </GroupedList>
              <GroupedList note={t("controlAdmin:quotes.deleteBody", { count: open.remainingCount })}>
                <ActionRow tone="danger" label={t("controlAdmin:quotes.deleteConfirm")} onClick={() => setDeleting(open)} />
              </GroupedList>
            </>
          ) : <p className="muted">{t("controlAdmin:quotes.gone")}</p>
        ) : (
          <GroupedList note={imports.length === 0 ? t("controlAdmin:quotes.empty") : undefined}>
            {imports.map((entry) => (
              <NavRow
                key={entry.id}
                icon={<FileText size={17} />}
                label={nameOf(entry)}
                sub={formatWhen(entry.createdAt)}
                value={countOf(entry)}
                onClick={() => go(`import:${entry.id}`)}
              />
            ))}
            <AddRow icon={<FileUp size={17} />} label={t("controlAdmin:quotes.import")} onClick={() => setImportOpen(true)} />
          </GroupedList>
        )}
      </div>

      {importOpen && (
        <QuoteImportModal
          onClose={() => setImportOpen(false)}
          onImported={(summary) => {
            setImportOpen(false);
            void load();
            setNotice(t("user:quotes.import.done", { count: summary.imported }));
            window.setTimeout(() => setNotice(""), 4000);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("controlAdmin:quotes.deleteTitle", { name: nameOf(deleting) })}
          confirmLabel={t("controlAdmin:quotes.deleteConfirm")}
          busyLabel={t("user:actions.deleting")}
          danger
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        >
          {t("controlAdmin:quotes.deleteBody", { count: deleting.remainingCount })}
        </ConfirmDialog>
      )}
    </>
  );
}
