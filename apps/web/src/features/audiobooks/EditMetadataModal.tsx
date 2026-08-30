import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Link2, Pencil, RotateCcw, Save, Search, Upload, X } from "lucide-react";
import { api } from "../../api";
import { PeopleCombobox } from "./PeopleCombobox";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { formatBytes } from "../../shared/utils";
import type { AudiobookBookDetail, CategorySummary, CoverCandidate, MetadataCandidate } from "./types";

export type MetadataTab = "edit" | "tags" | "publishing" | "series" | "cover" | "lookup";

// Applying a result is field-by-field: a provider is right about the narrator and
// wrong about the year often enough that "all of it or none of it" was the wrong
// question. Order follows the comparison table below, which reads top-down as the
// book's own summary. Must stay in step with METADATA_APPLY_FIELDS on the server —
// an unknown field there is a 400.
const METADATA_APPLY_FIELDS = [
  "cover", "title", "authors", "narrators", "year",
  "publisher", "language", "isbn", "asin", "tags", "description"
] as const;

type ApplyField = typeof METADATA_APPLY_FIELDS[number];

// `as const` keeps these literal so they still typecheck as translation keys.
const APPLY_FIELD_LABELS = {
  cover: "book:compare.cover",
  title: "book:metadata.fieldTitle",
  authors: "book:metadata.fieldAuthors",
  narrators: "book:metadata.fieldNarrators",
  year: "book:metadata.fieldYear",
  publisher: "book:metadata.fieldPublisher",
  language: "book:metadata.fieldLanguage",
  isbn: "book:metadata.fieldIsbn",
  asin: "book:metadata.fieldAsin",
  tags: "book:metadata.fieldTags",
  description: "book:metadata.fieldDescription"
} as const satisfies Record<ApplyField, string>;

// The full metadata editor used both on the book detail page and from the
// audiobooks grid "Edit metadata" action. It owns its own metadata-related
// state; the host only supplies the book, an updated-book callback, and close.
export function EditMetadataModal({
  book,
  initialTab = "edit",
  onBookUpdated,
  onClose
}: {
  book: AudiobookBookDetail;
  initialTab?: MetadataTab;
  onBookUpdated: (book: AudiobookBookDetail) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [activeMetadataTab, setActiveMetadataTab] = useState<MetadataTab>(initialTab);
  // Title only. The lookup returns matches for exactly what stands in the box
  // and nothing else, so an author prefilled here would quietly rule out every
  // provider that spells the name differently ("Leo Tolstoy" vs "Лев Толстой").
  // Add one by hand to narrow a common title.
  const [metadataQuery, setMetadataQuery] = useState(book.title);
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  // Everything is taken by default; unticking a field is how you keep the value
  // you already have — the book's own narrator, say, over the provider's.
  const [applyFields, setApplyFields] = useState<Set<ApplyField>>(() => new Set(METADATA_APPLY_FIELDS));
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
  // The query a result list belongs to; "" until the first search. Separates
  // "nothing searched yet" from "searched, nothing matched what you typed".
  const [searchedQuery, setSearchedQuery] = useState("");
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetError, setResetError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [coverCandidates, setCoverCandidates] = useState<CoverCandidate[]>([]);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverSaving, setCoverSaving] = useState("");
  const [coverError, setCoverError] = useState("");
  const [coverQuery, setCoverQuery] = useState(book.title);
  // null = not searched yet; [] = searched, found nothing.
  const [onlineCovers, setOnlineCovers] = useState<{ url: string; source: string }[] | null>(null);
  const [onlineCoversLoading, setOnlineCoversLoading] = useState(false);
  const [hiddenCoverUrls, setHiddenCoverUrls] = useState<Set<string>>(new Set());
  const [libraryPeople, setLibraryPeople] = useState<string[]>([]);
  const [librarySeries, setLibrarySeries] = useState<string[]>([]);
  const [libraryTags, setLibraryTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [editForm, setEditForm] = useState(() => ({
    title: book.title,
    series: book.series ?? "",
    seriesPosition: book.seriesPosition?.toString() ?? "",
    authors: book.authors,
    narrators: book.narrators,
    tags: book.tags,
    categoryKey: book.category?.key ?? "",
    publisher: book.publisher ?? "",
    yearPublished: book.yearPublished?.toString() ?? "",
    language: book.language ?? "",
    isbn: book.isbn ?? "",
    asin: book.asin ?? "",
    description: book.description ?? ""
  }));

  useEffect(() => {
    setEditForm({
      title: book.title,
      series: book.series ?? "",
      seriesPosition: book.seriesPosition?.toString() ?? "",
      authors: book.authors,
      narrators: book.narrators,
      tags: book.tags,
      categoryKey: book.category?.key ?? "",
      publisher: book.publisher ?? "",
      yearPublished: book.yearPublished?.toString() ?? "",
      language: book.language ?? "",
      isbn: book.isbn ?? "",
      asin: book.asin ?? "",
      description: book.description ?? ""
    });
  }, [book]);

  // Ebooks are single files: no scannable cover folder and no narrators. Hide the
  // audiobook-only folder-cover scan (it 404s "Audiobook not found" for them) and
  // the Narrators field.
  const isEbook = book.files.length === 0 && book.documents.length > 0;

  const loadCoverCandidates = useCallback(async () => {
    setCoverLoading(true);
    setCoverError("");
    try {
      const payload = await api<{ covers: CoverCandidate[] }>(`/api/library/books/${book.id}/cover-candidates`);
      setCoverCandidates(payload.covers);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("book:metadata.unableLoadCovers"));
    } finally {
      setCoverLoading(false);
    }
  }, [book.id]);

  useEffect(() => {
    if (activeMetadataTab === "cover" && !isEbook) {
      loadCoverCandidates();
    }
  }, [activeMetadataTab, isEbook, loadCoverCandidates]);

  useEffect(() => {
    api<{ people: string[] }>(`/api/library/audiobook-libraries/${book.libraryId}/people`)
      .then((payload) => setLibraryPeople(payload.people))
      .catch(() => {});
    api<{ series: { id: string; name: string }[] }>(`/api/library/audiobook-libraries/${book.libraryId}/series`)
      .then((payload) => setLibrarySeries(payload.series.map((s) => s.name)))
      .catch(() => {});
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch(() => {});
    api<{ tags: { name: string; count: number }[] }>("/api/library/tags")
      .then((payload) => setLibraryTags(payload.tags.map((t) => t.name)))
      .catch(() => {});
  }, [book.libraryId]);

  const searchMetadata = async () => {
    setMetadataLoading(true);
    setMetadataError("");
    setExpandedIndex(null);
    const query = metadataQuery.trim() || book.title;
    try {
      const params = new URLSearchParams({ q: query, provider: metadataProvider });
      const payload = await api<{ candidates: MetadataCandidate[] }>(`/api/library/books/${book.id}/metadata-search?${params}`);
      setMetadataResults(payload.candidates);
      setSearchedQuery(query);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : t("book:metadata.unableSearch"));
    } finally {
      setMetadataLoading(false);
    }
  };

  // Resolve a pasted book-page link (Open Library / Apple Books / FantLab /
  // LibriVox) into the same results list the search populates.
  const fetchFromLink = async () => {
    const url = linkUrl.trim();
    if (!url) {
      return;
    }
    setLinkLoading(true);
    setMetadataError("");
    setExpandedIndex(null);
    try {
      const params = new URLSearchParams({ url });
      const payload = await api<{ candidates: MetadataCandidate[] }>(`/api/library/books/${book.id}/metadata-from-url?${params}`);
      setMetadataResults(payload.candidates);
      setSearchedQuery("");
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : t("book:metadata.unableReadLink"));
    } finally {
      setLinkLoading(false);
    }
  };

  const toggleApplyField = (field: ApplyField) => {
    setApplyFields((current) => {
      const next = new Set(current);
      if (!next.delete(field)) {
        next.add(field);
      }
      return next;
    });
  };

  const applyMetadata = async (candidate: MetadataCandidate, index: number) => {
    setApplyingIndex(index);
    setMetadataError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata-match`, {
        method: "POST",
        body: JSON.stringify({ candidate, fields: [...applyFields] })
      });
      onBookUpdated(payload.book);
      setMetadataResults([]);
      onClose();
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : t("book:metadata.unableApply"));
    } finally {
      setApplyingIndex(null);
    }
  };

  const resetMetadata = async () => {
    setResetting(true);
    setResetError("");
    try {
      const payload = await api<{ reset: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata-reset`, { method: "POST" });
      onBookUpdated(payload.book);
      setResetConfirm(false);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : t("book:metadata.unableReset"));
    } finally {
      setResetting(false);
    }
  };

  const saveManualMetadata = async () => {
    setEditSaving(true);
    setEditError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editForm.title,
          series: editForm.series || null,
          seriesPosition: editForm.seriesPosition ? Number(editForm.seriesPosition) : null,
          authors: editForm.authors,
          narrators: editForm.narrators,
          tags: editForm.tags,
          categoryKey: editForm.categoryKey || null,
          publisher: editForm.publisher || null,
          yearPublished: editForm.yearPublished ? Number(editForm.yearPublished) : null,
          description: editForm.description || null,
          language: editForm.language || null,
          isbn: editForm.isbn || null,
          asin: editForm.asin || null
        })
      });
      onBookUpdated(payload.book);
      onClose();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t("book:metadata.unableSave"));
    } finally {
      setEditSaving(false);
    }
  };

  const closeMetadataModal = () => {
    setResetConfirm(false);
    onClose();
  };

  const applyFolderCover = async (cover: CoverCandidate) => {
    setCoverSaving(cover.relativePath);
    setCoverError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/cover`, {
        method: "POST",
        body: JSON.stringify({ relativePath: cover.relativePath })
      });
      onBookUpdated(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("book:metadata.unableApplyCover"));
    } finally {
      setCoverSaving("");
    }
  };

  const uploadCover = async (file: File | null) => {
    if (!file) {
      return;
    }

    setCoverSaving("upload");
    setCoverError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/cover`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      onBookUpdated(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("book:metadata.unableUploadCover"));
    } finally {
      setCoverSaving("");
    }
  };

  // Online cover picker (Cover tab): reuse the metadata search to gather cover
  // art from every provider, then apply only the chosen image — no other
  // metadata is touched.
  const searchOnlineCovers = async () => {
    setOnlineCoversLoading(true);
    setCoverError("");
    setHiddenCoverUrls(new Set());
    try {
      const params = new URLSearchParams({ q: coverQuery || book.title, provider: "all" });
      const payload = await api<{ candidates: MetadataCandidate[] }>(`/api/library/books/${book.id}/metadata-search?${params}`);
      const seen = new Set<string>();
      const covers = payload.candidates
        .filter((candidate) => candidate.coverUrl && !seen.has(candidate.coverUrl) && seen.add(candidate.coverUrl))
        .map((candidate) => ({ url: candidate.coverUrl!, source: candidate.source }));
      setOnlineCovers(covers);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("book:metadata.unableSearchCovers"));
    } finally {
      setOnlineCoversLoading(false);
    }
  };

  const hideOnlineCover = (url: string) => {
    setHiddenCoverUrls((current) => new Set(current).add(url));
  };

  const applyOnlineCover = async (url: string) => {
    setCoverSaving(url);
    setCoverError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/cover-from-url`, {
        method: "POST",
        body: JSON.stringify({ url })
      });
      onBookUpdated(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("book:metadata.unableApplyCover"));
      hideOnlineCover(url);
    } finally {
      setCoverSaving("");
    }
  };

  const metadataEditFooter = (
    <>
      {editError && <MessageBox tone="error" title={t("book:metadata.editErrorTitle")}>{editError}</MessageBox>}

      <div className="metadata-actions book-metadata-footer">
        {book.metadataSource === "manual" && !resetConfirm && (
          <button className="secondary-button" onClick={() => setResetConfirm(true)}>
            <RotateCcw size={16} />
            <span>{t("book:metadata.resetToAuto")}</span>
          </button>
        )}
        <span className="book-metadata-footer-spacer" aria-hidden="true"></span>
        <button className="secondary-button" onClick={closeMetadataModal} disabled={editSaving || resetting}>
          {t("common.cancel")}
        </button>
        <button className="primary-button" onClick={saveManualMetadata} disabled={editSaving || !editForm.title.trim()}>
          <Save size={16} />
          <span>{editSaving ? t("book:metadata.saving") : t("book:metadata.save")}</span>
        </button>
      </div>

      {resetConfirm && (
        <div className="metadata-reset-confirm">
          <p>{t("book:metadata.resetConfirmBody")}</p>
          <div className="metadata-actions">
            <button className="primary-button" onClick={resetMetadata} disabled={resetting}>
              <RotateCcw size={16} />
              <span>{resetting ? t("book:metadata.resetting") : t("book:metadata.confirmReset")}</span>
            </button>
            <button className="secondary-button" onClick={() => setResetConfirm(false)} disabled={resetting}>
              {t("common.cancel")}
            </button>
          </div>
          {resetError && <MessageBox tone="error" title={t("book:metadata.resetErrorTitle")}>{resetError}</MessageBox>}
        </div>
      )}
    </>
  );

  return (
    <Modal
      variant="panel"
      title={t("book:metadata.title")}
      icon={<Pencil size={22} />}
      className="book-metadata-modal"
      headerClassName="book-metadata-header"
      busy={editSaving || resetting}
      onClose={closeMetadataModal}
    >
        <div className="modal-tabs book-metadata-tabs">
          <button className={`modal-tab${activeMetadataTab === "edit" ? " active" : ""}`} onClick={() => setActiveMetadataTab("edit")}>
            {t("book:metadata.tabMetadata")}
          </button>
          <button className={`modal-tab${activeMetadataTab === "tags" ? " active" : ""}`} onClick={() => setActiveMetadataTab("tags")}>
            {t("book:metadata.tabTags")}
          </button>
          <button className={`modal-tab${activeMetadataTab === "publishing" ? " active" : ""}`} onClick={() => setActiveMetadataTab("publishing")}>
            {t("book:metadata.tabPublishing")}
          </button>
          <button className={`modal-tab${activeMetadataTab === "series" ? " active" : ""}`} onClick={() => setActiveMetadataTab("series")}>
            {t("book:metadata.tabSeries")}
          </button>
          <button className={`modal-tab${activeMetadataTab === "cover" ? " active" : ""}`} onClick={() => setActiveMetadataTab("cover")}>
            {t("book:metadata.tabCover")}
          </button>
          <button className={`modal-tab${activeMetadataTab === "lookup" ? " active" : ""}`} onClick={() => setActiveMetadataTab("lookup")}>
            {t("book:metadata.tabLookup")}
          </button>
        </div>

        <div className="modal-tab-content book-metadata-content">
          {activeMetadataTab === "edit" ? (
            <>
              <div className="metadata-edit-grid">
                <label className="field metadata-field-wide">
                  <span>{t("book:metadata.fieldTitle")}</span>
                  <input value={editForm.title} onChange={(event) => setEditForm((form) => ({ ...form, title: event.target.value }))} />
                </label>
                <div className="field metadata-field-half">
                  <span>{t("book:metadata.fieldAuthors")}</span>
                  <PeopleCombobox
                    value={editForm.authors}
                    onChange={(v) => setEditForm((form) => ({ ...form, authors: v }))}
                    suggestions={libraryPeople}
                    placeholder={t("book:metadata.addAuthor")}
                  />
                </div>
                {!isEbook && (
                  <div className="field metadata-field-half">
                    <span>{t("book:metadata.fieldNarrators")}</span>
                    <PeopleCombobox
                      value={editForm.narrators}
                      onChange={(v) => setEditForm((form) => ({ ...form, narrators: v }))}
                      suggestions={libraryPeople}
                      placeholder={t("book:metadata.addNarrator")}
                    />
                  </div>
                )}
                <label className="field metadata-field-half">
                  <span>{t("book:metadata.fieldCategory")}</span>
                  <select value={editForm.categoryKey} onChange={(event) => setEditForm((form) => ({ ...form, categoryKey: event.target.value }))}>
                    <option value="">{t("book:metadata.categoryAuto")}</option>
                    {categories.map((category) => (
                      <option key={category.key} value={category.key}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field metadata-field-wide">
                  <span>{t("book:metadata.fieldDescription")}</span>
                  <textarea value={editForm.description} onChange={(event) => setEditForm((form) => ({ ...form, description: event.target.value }))} rows={4} />
                </label>
              </div>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "tags" ? (
            <>
              <div className="metadata-edit-grid">
                <div className="field metadata-field-wide">
                  <span>{t("book:metadata.fieldTags")}</span>
                  <PeopleCombobox
                    value={editForm.tags}
                    onChange={(v) => setEditForm((form) => ({ ...form, tags: v }))}
                    suggestions={libraryTags}
                    placeholder={t("book:metadata.addTag")}
                  />
                </div>
              </div>
              <p className="muted">{t("book:metadata.tagsHint")}</p>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "publishing" ? (
            <>
              <div className="metadata-edit-grid">
                <label className="field metadata-field-half">
                  <span>{t("book:metadata.fieldPublisher")}</span>
                  <input value={editForm.publisher} onChange={(event) => setEditForm((form) => ({ ...form, publisher: event.target.value }))} />
                </label>
                <label className="field metadata-field-half">
                  <span>{t("book:metadata.fieldYear")}</span>
                  <input type="number" value={editForm.yearPublished} onChange={(event) => setEditForm((form) => ({ ...form, yearPublished: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>{t("book:metadata.fieldLanguage")}</span>
                  <input value={editForm.language} onChange={(event) => setEditForm((form) => ({ ...form, language: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>{t("book:metadata.fieldIsbn")}</span>
                  <input value={editForm.isbn} onChange={(event) => setEditForm((form) => ({ ...form, isbn: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>{t("book:metadata.fieldAsin")}</span>
                  <input value={editForm.asin} onChange={(event) => setEditForm((form) => ({ ...form, asin: event.target.value }))} />
                </label>
              </div>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "series" ? (
            <>
              <div className="metadata-series-panel">
                <div className="metadata-series-grid">
                  <div className="field">
                    <span>{t("book:metadata.fieldSeries")}</span>
                    <SuggestInput
                      value={editForm.series}
                      onChange={(v) => setEditForm((form) => ({ ...form, series: v }))}
                      suggestions={librarySeries}
                      placeholder={t("book:metadata.seriesPlaceholder")}
                    />
                  </div>
                  <label className="field">
                    <span>{t("book:metadata.fieldPosition")}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={editForm.seriesPosition}
                      onChange={(event) => setEditForm((form) => ({ ...form, seriesPosition: event.target.value }))}
                      placeholder="1"
                    />
                  </label>
                </div>
                <p className="muted">{t("book:metadata.seriesHint")}</p>
              </div>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "cover" ? (
            <>
              <div className="cover-tab-layout">
                <section className="cover-current-panel">
                  <span>{t("book:metadata.currentCover")}</span>
                  <div className="cover-current-preview">
                    {book.coverUrl ? (
                      <img src={book.coverLargeUrl ?? book.coverUrl} alt="" />
                    ) : (
                      <BookOpen size={34} />
                    )}
                  </div>
                </section>

                {!isEbook && (
                <section className="cover-picker-panel">
                  <div className="cover-picker-head">
                    <div>
                      <strong>{t("book:metadata.folderCovers")}</strong>
                      <span>{coverLoading ? t("book:metadata.scanningFolder") : t("book:metadata.imageFiles", { count: coverCandidates.length })}</span>
                    </div>
                    <button className="secondary-button compact-button" onClick={loadCoverCandidates} disabled={coverLoading || Boolean(coverSaving)}>
                      <RotateCcw size={14} />
                      <span>{t("refresh.refresh")}</span>
                    </button>
                  </div>

                  <div className="cover-candidate-grid">
                    {coverCandidates.map((cover) => (
                      <button
                        className="cover-candidate"
                        key={cover.relativePath}
                        onClick={() => applyFolderCover(cover)}
                        disabled={Boolean(coverSaving)}
                      >
                        <img src={cover.previewUrl} alt="" />
                        <span>{cover.name}</span>
                        <small>{formatBytes(cover.size)}</small>
                        <strong>{coverSaving === cover.relativePath ? t("book:metadata.applying") : t("book:metadata.apply")}</strong>
                      </button>
                    ))}
                    {!coverLoading && coverCandidates.length === 0 && (
                      <p className="management-empty">{t("book:metadata.noFolderCovers")}</p>
                    )}
                  </div>
                </section>
                )}
              </div>

              <section className="cover-online-panel">
                <div className="cover-picker-head">
                  <div>
                    <strong>{t("book:metadata.findCoversOnline")}</strong>
                    <span>iTunes · Open Library · FantLab · LibriVox</span>
                  </div>
                </div>
                <div className="cover-online-search">
                  <label className="search-field">
                    <Search size={17} aria-hidden="true" />
                    <input
                      type="search"
                      value={coverQuery}
                      onChange={(event) => setCoverQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") searchOnlineCovers(); }}
                      placeholder={t("book:metadata.searchCoversPlaceholder")}
                      aria-label={t("book:metadata.searchCoversAria")}
                    />
                  </label>
                  <button className="primary-button metadata-search-button" onClick={searchOnlineCovers} disabled={onlineCoversLoading}>
                    <Search size={16} />
                    <span>{onlineCoversLoading ? t("book:metadata.searching") : t("book:metadata.search")}</span>
                  </button>
                </div>

                {onlineCovers !== null && (
                  onlineCovers.filter((cover) => !hiddenCoverUrls.has(cover.url)).length > 0 ? (
                    <div className="cover-candidate-grid">
                      {onlineCovers
                        .filter((cover) => !hiddenCoverUrls.has(cover.url))
                        .map((cover) => (
                          <button
                            className="cover-candidate"
                            key={cover.url}
                            onClick={() => applyOnlineCover(cover.url)}
                            disabled={Boolean(coverSaving)}
                          >
                            <img src={cover.url} alt="" onError={() => hideOnlineCover(cover.url)} />
                            <span>{cover.source}</span>
                            <strong>{coverSaving === cover.url ? t("book:metadata.applying") : t("book:metadata.useThisCover")}</strong>
                          </button>
                        ))}
                    </div>
                  ) : (
                    !onlineCoversLoading && <p className="management-empty">{t("book:metadata.noCoversFound")}</p>
                  )
                )}
              </section>

              <label className="cover-upload-panel">
                <Upload size={18} />
                <span>{coverSaving === "upload" ? t("book:metadata.uploading") : t("book:metadata.uploadNewCover")}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={Boolean(coverSaving)}
                  onChange={(event) => {
                    uploadCover(event.target.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }}
                />
              </label>

              {coverError && <MessageBox tone="error" title={t("book:metadata.coverErrorTitle")}>{coverError}</MessageBox>}
            </>
          ) : (
            <>
              <div className="metadata-search-row">
                <select
                  className="library-filter"
                  value={metadataProvider}
                  onChange={(event) => setMetadataProvider(event.target.value as typeof metadataProvider)}
                  aria-label={t("book:metadata.providerAria")}
                >
                  <option value="all">{t("book:metadata.allProviders")}</option>
                  <option value="audible">Audible</option>
                  <option value="itunes">iTunes</option>
                  <option value="openlibrary">Open Library</option>
                  <option value="fantlab">FantLab</option>
                  <option value="librivox">LibriVox</option>
                </select>
                <label className="search-field">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={metadataQuery}
                    onChange={(event) => setMetadataQuery(event.target.value)}
                    placeholder={t("book:metadata.searchPlaceholder")}
                    aria-label={t("book:metadata.searchMetadataAria")}
                  />
                </label>
                <button className="primary-button metadata-search-button" onClick={searchMetadata} disabled={metadataLoading}>
                  <Search size={16} />
                  <span>{metadataLoading ? t("book:metadata.searching") : t("book:metadata.search")}</span>
                </button>
              </div>

              <div className="metadata-apply-fields">
                <div className="metadata-apply-fields-head">
                  <strong>{t("book:metadata.applyFieldsTitle")}</strong>
                  <span>{t("book:metadata.applyFieldsCount", { count: applyFields.size, total: METADATA_APPLY_FIELDS.length })}</span>
                  <button type="button" className="metadata-field-link" onClick={() => setApplyFields(new Set(METADATA_APPLY_FIELDS))}>
                    {t("book:metadata.applyFieldsAll")}
                  </button>
                  <button type="button" className="metadata-field-link" onClick={() => setApplyFields(new Set())}>
                    {t("book:metadata.applyFieldsNone")}
                  </button>
                </div>
                <div className="metadata-apply-controls">
                  {METADATA_APPLY_FIELDS.map((field) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={applyFields.has(field)}
                        onChange={() => toggleApplyField(field)}
                      />
                      <span>{t(APPLY_FIELD_LABELS[field])}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="metadata-link-row">
                <label className="search-field metadata-link-field">
                  <Link2 size={16} aria-hidden="true" />
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(event) => setLinkUrl(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") fetchFromLink(); }}
                    placeholder={t("book:metadata.pasteLinkPlaceholder")}
                    aria-label={t("book:metadata.linkAria")}
                  />
                </label>
                <button className="secondary-button metadata-search-button" onClick={fetchFromLink} disabled={linkLoading || !linkUrl.trim()}>
                  <Link2 size={16} />
                  <span>{linkLoading ? t("book:metadata.fetching") : t("book:metadata.fetch")}</span>
                </button>
                <small className="metadata-link-hint">{t("book:metadata.linkHint")}</small>
              </div>

              {metadataError && <MessageBox tone="error" title={t("book:metadata.lookupErrorTitle")}>{metadataError}</MessageBox>}

              <div className="metadata-results">
                {metadataResults.map((candidate, index) => (
                  <article className="metadata-result-card" key={`${candidate.source}-${candidate.title}-${index}`}>
                    <div className="metadata-result-cover" aria-hidden="true">
                      {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <BookOpen size={22} />}
                    </div>
                    <div className="metadata-result-body">
                      <div className="metadata-result-title-row">
                        <strong>{candidate.title}</strong>
                        {candidate.year && <b>{candidate.year}</b>}
                      </div>
                      <span>{candidate.authors.length > 0 ? t("book:metadata.byAuthors", { authors: candidate.authors.join(", ") }) : t("book:metadata.unknownAuthor")}</span>
                      <small>
                        {[candidate.narrators?.length ? t("book:metadata.narratorsList", { names: candidate.narrators.join(", ") }) : "", candidate.publisher, candidate.source]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                      {candidate.subtitle && <em>{candidate.subtitle}</em>}
                      {candidate.description && <p>{candidate.description}</p>}
                    </div>
                    <div className="metadata-result-actions">
                      <button
                        className="primary-button compact-button metadata-apply-button"
                        onClick={() => applyMetadata(candidate, index)}
                        disabled={applyingIndex !== null}
                      >
                        <CheckCircle2 size={15} />
                        <span>{applyingIndex === index ? t("book:metadata.applying") : t("book:metadata.apply")}</span>
                      </button>
                      <button
                        className="secondary-button compact-button metadata-details-button"
                        onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                        aria-expanded={expandedIndex === index}
                      >
                        {expandedIndex === index ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                        <span>{t("book:metadata.details")}</span>
                      </button>
                    </div>
                    {expandedIndex === index && <ResultCompare book={book} candidate={candidate} applyFields={applyFields} />}
                  </article>
                ))}
                {!metadataLoading && metadataResults.length === 0 && (
                  <p className="management-empty">
                    {searchedQuery
                      ? t("book:metadata.lookupNoMatches", { query: searchedQuery })
                      : t("book:metadata.lookupEmpty")}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
    </Modal>
  );
}

// Side-by-side of the current book vs. a search/link result, so the user can see
// exactly what applying it would change before committing. A field is flagged
// "changes" when the result has a non-empty value that differs from the current
// one — mirroring the gap-fill/overwrite rules in applyMetadataCandidate.
function ResultCompare({ book, candidate, applyFields }: {
  book: AudiobookBookDetail;
  candidate: MetadataCandidate;
  applyFields: Set<ApplyField>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const rows: { field: ApplyField | null; label: string; current: string; next: string }[] = [
    { field: "title", label: t("book:metadata.fieldTitle"), current: book.title, next: candidate.title },
    // The original title is shown for context only — nothing applies it.
    { field: null, label: t("book:compare.originalTitle"), current: "", next: candidate.subtitle ?? "" },
    { field: "authors", label: t("book:metadata.fieldAuthors"), current: book.authors.join(", "), next: candidate.authors.join(", ") },
    { field: "narrators", label: t("book:metadata.fieldNarrators"), current: book.narrators.join(", "), next: (candidate.narrators ?? []).join(", ") },
    { field: "year", label: t("book:metadata.fieldYear"), current: book.yearPublished?.toString() ?? "", next: candidate.year?.toString() ?? "" },
    { field: "publisher", label: t("book:metadata.fieldPublisher"), current: book.publisher ?? "", next: candidate.publisher ?? "" },
    { field: "language", label: t("book:metadata.fieldLanguage"), current: book.language ?? "", next: candidate.language ?? "" },
    { field: "isbn", label: t("book:metadata.fieldIsbn"), current: book.isbn ?? "", next: candidate.isbn ?? "" },
    { field: "asin", label: t("book:metadata.fieldAsin"), current: book.asin ?? "", next: candidate.asin ?? "" },
    { field: "tags", label: t("book:metadata.fieldTags"), current: book.tags.join(", "), next: (candidate.genres ?? []).join(", ") },
    { field: "description", label: t("book:metadata.fieldDescription"), current: book.description ?? "", next: candidate.description ?? "" }
  ];

  // A row is skipped when its field is unticked above — the result has something
  // to say and this book won't take it. Shown rather than hidden so the toggles
  // read back here as "what would change".
  const skipped = (field: ApplyField | null) => field !== null && !applyFields.has(field);
  const changed = (current: string, next: string) => next.trim().length > 0 && next.trim() !== current.trim();
  const visible = rows.filter((row) => row.current.trim() || row.next.trim());

  const rowFlag = (field: ApplyField | null, current: string, next: string) => {
    if (!changed(current, next)) return null;
    return skipped(field)
      ? <em className="compare-flag compare-flag-skipped">{t("book:compare.skipped")}</em>
      : <em className="compare-flag">{t("book:compare.changes")}</em>;
  };

  return (
    <div className="metadata-result-compare">
      <div className="compare-row compare-head-row" aria-hidden="true">
        <span></span>
        <span>{t("book:compare.current")}</span>
        <span>{t("book:compare.fromResult")}</span>
      </div>
      {visible.map((row) => (
        <div
          className={`compare-row${changed(row.current, row.next) && !skipped(row.field) ? " changed" : ""}${skipped(row.field) ? " skipped" : ""}`}
          key={row.label}
        >
          <span className="compare-label">{row.label}</span>
          <span className="compare-current">{row.current || "—"}</span>
          <span className="compare-next">
            {row.next || "—"}
            {rowFlag(row.field, row.current, row.next)}
          </span>
        </div>
      ))}
      <div className={`compare-row compare-cover-row${skipped("cover") ? " skipped" : ""}`}>
        <span className="compare-label">{t("book:compare.cover")}</span>
        <span className="compare-current">
          <span className="compare-cover-frame">
            {book.coverUrl ? <img src={book.coverLargeUrl ?? book.coverUrl} alt="" /> : <BookOpen size={20} />}
          </span>
        </span>
        <span className="compare-next">
          <span className="compare-cover-frame">
            {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <BookOpen size={20} />}
          </span>
          {candidate.coverUrl && skipped("cover") && (
            <em className="compare-flag compare-flag-skipped">{t("book:compare.skipped")}</em>
          )}
        </span>
      </div>
    </div>
  );
}

function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase()));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="suggest-input" ref={containerRef}>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") setOpen(false); }}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="people-combobox-dropdown">
          {filtered.map((s) => (
            <button key={s} type="button" className="people-combobox-option" onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); }}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
