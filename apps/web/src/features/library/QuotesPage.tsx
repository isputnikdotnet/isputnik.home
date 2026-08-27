import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Copy, Pencil, Plus, Quote as QuoteIcon, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { Modal } from "../../shared/Modal";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { relativeTime } from "../../shared/utils";
import i18n from "../../i18n";
import type { Quote } from "../audiobooks/types";

// In-reader quotes can be opened back at their spot; the deep link mirrors the
// bookmark Read button (?read=1) and adds the cfi so the reader starts there.
function readerHref(quote: Quote): string | null {
  if (!quote.itemId || !quote.cfi || quote.libraryType === "gallery" || quote.libraryType === null) return null;
  const base = quote.libraryType === "ebook" ? "/ebooks" : "/audiobooks";
  return `${base}/books/${quote.itemId}?read=1&cfi=${encodeURIComponent(quote.cfi)}`;
}

// Module-level helper (no hook access), so it goes through i18n directly.
function attribution(quote: Quote): string {
  const title = quote.sourceTitle || i18n.t("user:quotes.unattributed");
  return quote.sourceAuthors.length > 0 ? `${title} — ${quote.sourceAuthors.join(", ")}` : title;
}

interface QuoteGroup {
  key: string;
  title: string;
  authors: string[];
  external: boolean;
  items: Quote[];
}

// Group quotes under their source (a library book, or a typed-in title), newest
// quote first within a group, groups ordered by their most recent quote.
function groupBySource(quotes: Quote[]): QuoteGroup[] {
  const map = new Map<string, QuoteGroup>();
  for (const quote of quotes) {
    const key = quote.itemId ?? `ext:${(quote.sourceTitle ?? "").toLowerCase()}`;
    const group = map.get(key);
    if (group) {
      group.items.push(quote);
    } else {
      map.set(key, {
        key,
        title: quote.sourceTitle || i18n.t("user:quotes.unattributed"),
        authors: quote.sourceAuthors,
        external: !quote.itemId,
        items: [quote]
      });
    }
  }
  const groups = [...map.values()];
  for (const group of groups) group.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  groups.sort((a, b) => b.items[0].createdAt.localeCompare(a.items[0].createdAt));
  return groups;
}

interface QuoteDraft {
  text: string;
  sourceTitle: string;
  sourceAuthor: string;
  note: string;
}

const emptyDraft: QuoteDraft = { text: "", sourceTitle: "", sourceAuthor: "", note: "" };

// Add (no editing target) or edit an existing quote. Editing keeps the quote's
// book link intact — only the text/source/note are editable here.
function QuoteEditor({
  editing,
  busy,
  error,
  onSave,
  onClose
}: {
  editing: Quote | null;
  busy: boolean;
  error: string;
  onSave: (draft: QuoteDraft) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "user"]);
  const [draft, setDraft] = useState<QuoteDraft>(
    editing
      ? {
          text: editing.text,
          sourceTitle: editing.itemId ? "" : (editing.sourceTitle ?? ""),
          sourceAuthor: editing.itemId ? "" : (editing.sourceAuthors.join(", ") ?? ""),
          note: editing.note ?? ""
        }
      : emptyDraft
  );
  const linked = Boolean(editing?.itemId);

  return (
    <Modal
      variant="card"
      title={editing ? t("user:quotes.editTitle") : t("user:quotes.addTitle")}
      icon={<QuoteIcon size={18} />}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.text.trim()) onSave(draft);
      }}
    >
      <div className="quote-form">
        <label className="quote-field">
          <span>{t("user:quotes.quoteField")}</span>
          <textarea
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            placeholder={t("user:quotes.quotePlaceholder")}
            rows={4}
            autoFocus
            required
          />
        </label>
        {linked ? (
          <p className="quote-form-linked">{t("user:quotes.fromLibrary")} <strong>{attribution(editing!)}</strong></p>
        ) : (
          <div className="quote-field-row">
            <label className="quote-field">
              <span>{t("user:quotes.sourceField")}</span>
              <input
                value={draft.sourceTitle}
                onChange={(e) => setDraft((d) => ({ ...d, sourceTitle: e.target.value }))}
                placeholder={t("user:quotes.titlePlaceholder")}
              />
            </label>
            <label className="quote-field">
              <span>{t("user:quotes.authorField")}</span>
              <input
                value={draft.sourceAuthor}
                onChange={(e) => setDraft((d) => ({ ...d, sourceAuthor: e.target.value }))}
                placeholder={t("user:quotes.authorField")}
              />
            </label>
          </div>
        )}
        <label className="quote-field">
          <span>{t("user:quotes.noteField")} <em>{t("user:form.optional")}</em></span>
          <textarea
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            placeholder={t("user:quotes.notePlaceholder")}
            rows={2}
          />
        </label>
        {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || !draft.text.trim()}>
            {busy ? t("user:actions.saving") : editing ? t("user:actions.save") : t("user:quotes.addQuote")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function QuotesPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleting, setDeleting] = useState<Quote | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    api<{ quotes: Quote[] }>("/api/library/quotes")
      .then((payload) => setQuotes(payload.quotes))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:quotes.loadFailed")));
  }, []);

  const groups = useMemo(() => groupBySource(quotes ?? []), [quotes]);
  const total = quotes?.length ?? 0;

  const openAdd = () => { setEditing(null); setSaveError(""); setEditorOpen(true); };
  const openEdit = (quote: Quote) => { setEditing(quote); setSaveError(""); setEditorOpen(true); };

  const saveQuote = async (draft: QuoteDraft) => {
    setSaving(true);
    setSaveError("");
    try {
      if (editing) {
        const body: Record<string, string | null> = { text: draft.text.trim(), note: draft.note.trim() || null };
        // Source fields are only editable for externally-typed quotes.
        if (!editing.itemId) {
          body.sourceTitle = draft.sourceTitle.trim() || null;
          body.sourceAuthor = draft.sourceAuthor.trim() || null;
        }
        const { quote } = await api<{ quote: Quote }>(`/api/library/quotes/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body)
        });
        setQuotes((current) => current?.map((q) => (q.id === quote.id ? quote : q)) ?? current);
      } else {
        const { quote } = await api<{ quote: Quote }>("/api/library/quotes", {
          method: "POST",
          body: JSON.stringify({
            text: draft.text.trim(),
            sourceTitle: draft.sourceTitle.trim() || null,
            sourceAuthor: draft.sourceAuthor.trim() || null,
            note: draft.note.trim() || null
          })
        });
        setQuotes((current) => [quote, ...(current ?? [])]);
      }
      setEditorOpen(false);
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("user:quotes.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api(`/api/library/quotes/${deleting.id}`, { method: "DELETE" });
      setQuotes((current) => current?.filter((q) => q.id !== deleting.id) ?? current);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:quotes.deleteFailed"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const copyQuote = async (quote: Quote) => {
    const text = `“${quote.text}”\n— ${attribution(quote)}`;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("user:quotes.copied"));
      window.setTimeout(() => setNotice(""), 2000);
    } catch {
      setNotice(t("user:quotes.copyBlocked"));
      window.setTimeout(() => setNotice(""), 2500);
    }
  };

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="quotes" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">{t("user:area.eyebrow")}</p>
            <h1>{t("common:nav.quotes")}</h1>
          </div>
          <Button variant="primary" compact onClick={openAdd}>
            <Plus size={16} /> {t("user:quotes.addQuote")}
          </Button>
        </div>

        {error && <MessageBox tone="error" title={t("user:quotes.errorTitle")}>{error}</MessageBox>}

        {quotes === null ? (
          <p className="management-empty">{t("user:quotes.loading")}</p>
        ) : quotes.length === 0 ? (
          <div className="empty-state library-empty">
            <QuoteIcon size={58} aria-hidden="true" />
            <h2>{t("user:quotes.emptyHeading")}</h2>
            <p className="muted">
              {t("user:quotes.empty")}
            </p>
          </div>
        ) : (
          <>
            <div className="quote-groups">
              {groups.map((group) => (
                <section className="quote-group" key={group.key}>
                  <div className="quote-group-head">
                    <span className="quote-group-mark" aria-hidden="true"><QuoteIcon size={16} /></span>
                    <span className="quote-group-meta">
                      <strong>{group.title}</strong>
                      {group.authors.length > 0 && <span>{group.authors.join(", ")}</span>}
                    </span>
                    <span className="quote-count">{group.items.length}</span>
                  </div>

                  <div className="quote-list">
                    {group.items.map((quote) => {
                      const href = readerHref(quote);
                      return (
                        <article className="quote-card" key={quote.id}>
                          <blockquote className="quote-text">{quote.text}</blockquote>
                          {quote.note && <p className="quote-note">{quote.note}</p>}
                          <div className="quote-card-foot">
                            <span className="quote-time">{relativeTime(quote.createdAt)}</span>
                            <div className="quote-card-actions">
                              {href && (
                                <button
                                  type="button"
                                  className="icon-button"
                                  onClick={() => navigate(href)}
                                  aria-label={t("user:quotes.openInReader")}
                                  title={t("user:quotes.openInReader")}
                                >
                                  <BookOpen size={16} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => copyQuote(quote)}
                                aria-label={t("user:quotes.copyAria")}
                                title={t("user:actions.copy")}
                              >
                                <Copy size={16} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => openEdit(quote)}
                                aria-label={t("user:quotes.editAria")}
                                title={t("user:actions.edit")}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                type="button"
                                className="icon-button danger"
                                onClick={() => setDeleting(quote)}
                                aria-label={t("user:quotes.deleteAria")}
                                title={t("user:actions.delete")}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <p className="bookmark-footer">
              {t("user:quotes.sources", { count: groups.length })} · {t("user:quotes.count", { count: total })}
            </p>
          </>
        )}
      </section>

      {editorOpen && (
        <QuoteEditor
          editing={editing}
          busy={saving}
          error={saveError}
          onSave={saveQuote}
          onClose={() => { setEditorOpen(false); setEditing(null); }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("user:quotes.deleteTitle")}
          confirmLabel={t("user:quotes.deleteConfirm")}
          busyLabel={t("user:actions.deleting")}
          danger
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        >
          {t("user:quotes.deleteBody")}
        </ConfirmDialog>
      )}

      {notice && <div className="quote-toast" role="status">{notice}</div>}
    </DashboardShell>
  );
}
