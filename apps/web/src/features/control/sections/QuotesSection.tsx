import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Quote as QuoteIcon, Trash2 } from "lucide-react";
import i18n from "../../../i18n";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { QuoteImportModal } from "../../library/QuoteImportModal";

// Where quote packs are brought in and taken back out. Importing lives here
// rather than on the Quotes page because a pack decides what the whole house
// reads — it is an administrative act, like adding a library, and the Quotes
// page is where everyone reads and writes their own.
//
// Each import is kept as the event it was, so a pack that turned out to be full
// of rubbish can be undone in one go instead of one quote at a time.
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
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language);
}

export function QuotesSection() {
  const { t } = useTranslation(["common", "user", "controlAdmin"]);
  const [imports, setImports] = useState<QuoteImport[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<QuoteImport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = () =>
    api<{ imports: QuoteImport[] }>("/api/library/quotes/imports")
      .then((payload) => setImports(payload.imports))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:common.unableToLoad")));

  useEffect(() => { void load(); }, []);

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
      setNotice(t("controlAdmin:quotes.deleted", { count: deleted }));
      window.setTimeout(() => setNotice(""), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:quotes.deleteFailed"));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="quotes"
        className="control-head-compact"
        icon={<QuoteIcon size={30} />}
        description={t("controlAdmin:quotes.headDescription")}
      >
        {/* Refresh last, at the right edge — the position it holds on every
            other page in this group. */}
        <div className="row-actions control-head-actions">
          <Button variant="primary" compact onClick={() => setImportOpen(true)}>
            <FileUp size={16} />
            <span>{t("controlAdmin:quotes.import")}</span>
          </Button>
          <RefreshButton onRefresh={load} />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("user:common.unableToLoad")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("controlAdmin:quotes.doneTitle")}>{notice}</MessageBox>}

      {imports === null ? (
        <p className="management-empty">{t("controlAdmin:ui.loading")}</p>
      ) : imports.length === 0 ? (
        <p className="management-empty">{t("controlAdmin:quotes.empty")}</p>
      ) : (
        <div className="quote-import-list">
          {imports.map((entry) => (
            <article className="quote-import-row" key={entry.id}>
              <div className="quote-import-copy">
                <strong>{entry.fileName || t("controlAdmin:quotes.unnamedFile")}</strong>
                <span className="muted">
                  {formatWhen(entry.createdAt)}
                  {" · "}
                  {/* What is left, not what arrived — quotes can be deleted singly. */}
                  {entry.remainingCount === entry.importedCount
                    ? t("controlAdmin:quotes.quoteCount", { count: entry.remainingCount })
                    : t("controlAdmin:quotes.quoteCountOf", {
                        remaining: entry.remainingCount,
                        imported: entry.importedCount
                      })}
                </span>
              </div>
              <Button variant="secondary" danger compact onClick={() => setDeleting(entry)}>
                <Trash2 size={15} /> {t("controlAdmin:quotes.delete")}
              </Button>
            </article>
          ))}
        </div>
      )}

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
          title={t("controlAdmin:quotes.deleteTitle", {
            name: deleting.fileName || t("controlAdmin:quotes.unnamedFile")
          })}
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
