import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Copy, ListPlus, Pencil, Plus, Quote as QuoteIcon, Trash2 } from "lucide-react";
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
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { PeopleCombobox } from "../audiobooks/PeopleCombobox";
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
//
// An imported pack is mostly author-without-source — a famous line has someone
// who said it but no book behind it — so keying on the title alone would drop a
// whole 1,200-quote import into ONE "Unattributed" group wearing whichever
// author happened to land first. Quotes with no title group by their author and
// wear that name instead.
function groupBySource(quotes: Quote[]): QuoteGroup[] {
  const map = new Map<string, QuoteGroup>();
  for (const quote of quotes) {
    const authorLine = quote.sourceAuthors.join(", ");
    const key = quote.itemId ?? `ext:${quote.sourceTitle ?? ""}|${authorLine}`.toLowerCase();
    const group = map.get(key);
    if (group) {
      group.items.push(quote);
    } else {
      map.set(key, {
        key,
        title: quote.sourceTitle || authorLine || i18n.t("user:quotes.unattributed"),
        // Only a second line when the heading is a title — otherwise it would
        // repeat the author the heading already names.
        authors: quote.sourceTitle ? quote.sourceAuthors : [],
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
  language: string;
  quoteDate: string;
  context: string;
  visibility: "private" | "family";
  inRotation: boolean;
  tags: string[];
  familyTreePersonId: string;
}

const emptyDraft: QuoteDraft = {
  text: "",
  sourceTitle: "",
  sourceAuthor: "",
  note: "",
  language: "",
  quoteDate: "",
  context: "",
  visibility: "private",
  inRotation: false,
  tags: [],
  familyTreePersonId: ""
};

// The languages the UI itself speaks, by their own names (as the A–Z strip's
// script toggle does). A quote imported in some other language keeps its code:
// the editor adds it as an option rather than silently dropping it on save.
const UI_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" }
];

// Same partial ISO dates as a family member's birth date: a year, a month, or a day.
const PARTIAL_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// The page shows the whole house's shared quotes as well as your own, so finding
// one slice of a long list is the everyday case: who saved it, where it came from,
// whether it is in the daily card, and which category it wears. A "tag:" filter is
// any category quotes actually use — free-form, so the row grows only as the
// library does. Anything richer belongs in a real toolbar, which this user-area
// page (unlike a library browse page) does not wear.
const QUOTE_FILTERS = ["all", "mine", "import", "reader", "manual", "rotation"] as const;
type BuiltInFilter = (typeof QUOTE_FILTERS)[number];
type QuoteFilter = BuiltInFilter | `tag:${string}`;

/** Categories worth offering: the ones quotes actually wear, most-used first. */
const SHOWN_TAG_FILTERS = 8;

function matchesFilter(quote: Quote, filter: QuoteFilter): boolean {
  if (filter === "all") return true;
  if (filter === "mine") return quote.mine;
  if (filter === "rotation") return quote.inRotation;
  if (filter.startsWith("tag:")) return quote.tags.includes(filter.slice(4));
  return quote.origin === filter;
}

function popularTags(quotes: Quote[]): string[] {
  const counts = new Map<string, number>();
  for (const quote of quotes) {
    for (const tag of quote.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SHOWN_TAG_FILTERS)
    .map(([tag]) => tag);
}

// The metadata half of a quote, shaped for both write routes: an emptied field
// goes as null so the column is cleared rather than left behind.
function metadataBody(draft: QuoteDraft) {
  return {
    language: draft.language.trim() || null,
    quoteDate: draft.quoteDate.trim() || null,
    context: draft.context.trim() || null,
    visibility: draft.visibility,
    inRotation: draft.inRotation,
    tags: draft.tags,
    familyTreePersonId: draft.familyTreePersonId || null
  };
}

// Add (no editing target) or edit an existing quote. Editing keeps the quote's
// book link intact — only the text/source/note are editable here.
function QuoteEditor({
  editing,
  busy,
  error,
  knownTags,
  familyMembers,
  onSave,
  onClose
}: {
  editing: Quote | null;
  busy: boolean;
  error: string;
  /** Categories already in use, so the house converges on a few rather than 50. */
  knownTags: string[];
  /** The family tree, for saying WHO said it. Empty on installs with no tree. */
  familyMembers: { id: string; name: string }[];
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
          note: editing.note ?? "",
          language: editing.language ?? "",
          quoteDate: editing.quoteDate ?? "",
          context: editing.context ?? "",
          visibility: editing.visibility,
          inRotation: editing.inRotation,
          tags: editing.tags,
          familyTreePersonId: editing.personId ?? ""
        }
      : emptyDraft
  );
  // Set when the draft itself is wrong (a malformed date), as opposed to `error`,
  // which is what the server said about a save that was actually attempted.
  const [draftError, setDraftError] = useState("");
  const linked = Boolean(editing?.itemId);
  const languageOptions = UI_LANGUAGES.some((l) => l.code === draft.language) || !draft.language
    ? UI_LANGUAGES
    : [...UI_LANGUAGES, { code: draft.language, label: draft.language }];

  return (
    <Modal
      variant="card"
      title={editing ? t("user:quotes.editTitle") : t("user:quotes.addTitle")}
      icon={<QuoteIcon size={18} />}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.text.trim()) return;
        const date = draft.quoteDate.trim();
        if (date && !PARTIAL_DATE.test(date)) {
          setDraftError(t("user:quotes.dateInvalid"));
          return;
        }
        setDraftError("");
        onSave(draft);
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
        {familyMembers.length > 0 && (
          <label className="quote-field">
            <span>{t("user:quotes.speakerField")} <em>{t("user:form.optional")}</em></span>
            <select
              value={draft.familyTreePersonId}
              onChange={(e) => setDraft((d) => ({ ...d, familyTreePersonId: e.target.value }))}
            >
              <option value="">{t("user:quotes.speakerNobody")}</option>
              {familyMembers.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="quote-field">
          <span>{t("user:quotes.tagsField")} <em>{t("user:form.optional")}</em></span>
          <PeopleCombobox
            value={draft.tags}
            onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
            suggestions={knownTags}
            placeholder={t("user:quotes.tagsPlaceholder")}
          />
        </div>

        <label className="quote-field">
          <span>{t("user:quotes.noteField")} <em>{t("user:form.optional")}</em></span>
          <textarea
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            placeholder={t("user:quotes.notePlaceholder")}
            rows={2}
          />
        </label>

        <div className="quote-field-row">
          <label className="quote-field">
            <span>{t("user:quotes.languageField")} <em>{t("user:form.optional")}</em></span>
            <select
              value={draft.language}
              onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))}
            >
              <option value="">{t("user:quotes.languageUnset")}</option>
              {languageOptions.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="quote-field">
            <span>{t("user:quotes.dateField")} <em>{t("user:form.optional")}</em></span>
            <input
              value={draft.quoteDate}
              onChange={(e) => setDraft((d) => ({ ...d, quoteDate: e.target.value }))}
              placeholder={t("user:quotes.datePlaceholder")}
              inputMode="numeric"
            />
          </label>
        </div>

        <label className="quote-field">
          <span>{t("user:quotes.contextField")} <em>{t("user:form.optional")}</em></span>
          <input
            value={draft.context}
            onChange={(e) => setDraft((d) => ({ ...d, context: e.target.value }))}
            placeholder={t("user:quotes.contextPlaceholder")}
          />
        </label>

        <div className="quote-field-row">
          <label className="quote-field">
            <span>{t("user:quotes.visibilityField")}</span>
            <select
              value={draft.visibility}
              onChange={(e) => setDraft((d) => ({ ...d, visibility: e.target.value as QuoteDraft["visibility"] }))}
            >
              <option value="private">{t("user:quotes.visibilityPrivate")}</option>
              <option value="family">{t("user:quotes.visibilityFamily")}</option>
            </select>
          </label>
          <label className="field-checkbox quote-field-toggle">
            <input
              type="checkbox"
              checked={draft.inRotation}
              onChange={(e) => setDraft((d) => ({ ...d, inRotation: e.target.checked }))}
            />
            <span>{t("user:quotes.rotationField")}</span>
          </label>
        </div>

        {(draftError || error) && (
          <MessageBox tone="error" title={t("common:errors.unableToSave")}>{draftError || error}</MessageBox>
        )}
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
  const [filter, setFilter] = useState<QuoteFilter>("all");
  const [familyMembers, setFamilyMembers] = useState<{ id: string; name: string }[]>([]);
  const [collecting, setCollecting] = useState<Quote | null>(null);
  const [highlighted, setHighlighted] = useState("");
  const [clearingImports, setClearingImports] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const jumped = useRef(false);

  const loadQuotes = () =>
    api<{ quotes: Quote[] }>("/api/library/quotes")
      .then((payload) => setQuotes(payload.quotes))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:quotes.loadFailed")));

  useEffect(() => { void loadQuotes(); }, []);

  // The family tree, for the editor's "who said it" picker. Reading the tree is
  // open to every signed-in user; an install with no tree simply gets no field.
  useEffect(() => {
    api<{ persons: { id: string; name: string }[] }>("/api/family-tree/persons")
      .then((payload) => setFamilyMembers(payload.persons.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setFamilyMembers([]));
  }, []);

  const visible = useMemo(() => (quotes ?? []).filter((q) => matchesFilter(q, filter)), [quotes, filter]);
  const groups = useMemo(() => groupBySource(visible), [visible]);
  const total = visible.length;
  // Which filters would actually show something — a chip that can only ever lead
  // to an empty page is noise, so an install with no imports never sees one.
  // Arriving from a collection (or any ?quote= link): show that quote whatever
  // the current filter is, scroll to it, and flash it so the eye finds it in a
  // long list. Once only — later edits re-set  and must not re-jump.
  useEffect(() => {
    if (!quotes || jumped.current) return;
    const wanted = new URLSearchParams(window.location.search).get("quote");
    if (!wanted || !quotes.some((quote) => quote.id === wanted)) return;
    jumped.current = true;
    setFilter("all");
    setHighlighted(wanted);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-quote-id="${wanted}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setHighlighted(""), 2500);
    return () => window.clearTimeout(timer);
  }, [quotes]);

  // Mine only: the route deletes the caller's own imported quotes, so the number
  // the confirmation names has to be the number that will actually go.
  const myImportCount = useMemo(
    () => (quotes ?? []).filter((quote) => quote.mine && quote.origin === "import").length,
    [quotes]
  );

  // Every category anyone has used, for the editor's type-ahead.
  const knownTags = useMemo(
    () => [...new Set((quotes ?? []).flatMap((q) => q.tags))].sort((a, b) => a.localeCompare(b)),
    [quotes]
  );
  const offered = useMemo<QuoteFilter[]>(
    () => [
      ...QUOTE_FILTERS.filter((key) => key === "all" || (quotes ?? []).some((q) => matchesFilter(q, key))),
      ...popularTags(quotes ?? []).map((tag) => `tag:${tag}` as QuoteFilter)
    ],
    [quotes]
  );

  const openAdd = () => { setEditing(null); setSaveError(""); setEditorOpen(true); };
  const openEdit = (quote: Quote) => { setEditing(quote); setSaveError(""); setEditorOpen(true); };

  const saveQuote = async (draft: QuoteDraft) => {
    setSaving(true);
    setSaveError("");
    try {
      if (editing) {
        const body: Record<string, string | boolean | string[] | null> = {
          text: draft.text.trim(),
          note: draft.note.trim() || null,
          ...metadataBody(draft)
        };
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
            note: draft.note.trim() || null,
            ...metadataBody(draft)
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

  const clearImported = async () => {
    setClearBusy(true);
    try {
      const { deleted } = await api<{ deleted: number }>("/api/library/quotes/imported", { method: "DELETE" });
      await loadQuotes();
      setFilter("all");
      setClearingImports(false);
      setNotice(t("user:quotes.clearedImported", { count: deleted }));
      window.setTimeout(() => setNotice(""), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:quotes.deleteFailed"));
    } finally {
      setClearBusy(false);
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
          <div className="quote-head-actions">
            {/* Bringing in a pack lives in the control panel (Utilities ›
                Widgets › Quotes): it curates what the whole house reads, and it
                is undone there too, one import at a time. This page is where
                everyone reads and writes their own. */}
            <Button variant="primary" compact onClick={openAdd}>
              <Plus size={16} /> {t("user:quotes.addQuote")}
            </Button>
          </div>
        </div>

        {error && <MessageBox tone="error" title={t("user:quotes.errorTitle")}>{error}</MessageBox>}

        {offered.length > 1 && (
          <div className="quote-filters" role="group" aria-label={t("user:quotes.filterLabel")}>
            {offered.map((key) => (
              <button
                key={key}
                type="button"
                className={`quote-filter${filter === key ? " is-active" : ""}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key.startsWith("tag:")
                  ? key.slice(4)
                  : t(`user:quotes.filters.${key}` as "user:quotes.filters.all")}
              </button>
            ))}
            {/* The undo for a bulk import, offered where its result is on screen.
                Counts only your own — the route cannot touch anyone else's. */}
            {filter === "import" && myImportCount > 0 && (
              <Button variant="text" danger compact onClick={() => setClearingImports(true)}>
                <Trash2 size={15} /> {t("user:quotes.clearImported", { count: myImportCount })}
              </Button>
            )}
          </div>
        )}

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
        ) : visible.length === 0 ? (
          <p className="management-empty">{t("user:quotes.noneMatchFilter")}</p>
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
                        <article
                          className={`quote-card${highlighted === quote.id ? " is-highlighted" : ""}`}
                          data-quote-id={quote.id}
                          key={quote.id}
                        >
                          <blockquote className="quote-text">{quote.text}</blockquote>
                          {quote.note && <p className="quote-note">{quote.note}</p>}
                          {quote.tags.length > 0 && (
                            <div className="quote-tags">
                              {quote.tags.map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  className="quote-tag"
                                  onClick={() => setFilter(`tag:${tag}`)}
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="quote-card-foot">
                            <span className="quote-time">
                              {relativeTime(quote.createdAt)}
                              {quote.personName && (
                                <> · {t("user:quotes.spokenBy", { name: quote.personName })}</>
                              )}
                              {quote.ownerName && (
                                <> · {t("user:quotes.savedBy", { name: quote.ownerName })}</>
                              )}
                            </span>
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
                                onClick={() => setCollecting(quote)}
                                aria-label={t("user:quotes.addToCollectionAria")}
                                title={t("user:collections.addTo")}
                              >
                                <ListPlus size={16} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => copyQuote(quote)}
                                aria-label={t("user:quotes.copyAria")}
                                title={t("user:actions.copy")}
                              >
                                <Copy size={16} />
                              </button>
                              {quote.mine && (
                                <>
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
                                </>
                              )}
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
          knownTags={knownTags}
          familyMembers={familyMembers}
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


      {clearingImports && (
        <ConfirmDialog
          title={t("user:quotes.clearImportedTitle", { count: myImportCount })}
          confirmLabel={t("user:quotes.clearImportedConfirm")}
          busyLabel={t("user:actions.deleting")}
          danger
          busy={clearBusy}
          onConfirm={clearImported}
          onCancel={() => setClearingImports(false)}
        >
          {t("user:quotes.clearImportedBody")}
        </ConfirmDialog>
      )}

      {collecting && (
        <AddToCollectionModal
          entityType="quote"
          entityId={collecting.id}
          title={collecting.text}
          onClose={() => setCollecting(null)}
        />
      )}

      {notice && <div className="quote-toast" role="status">{notice}</div>}
    </DashboardShell>
  );
}
