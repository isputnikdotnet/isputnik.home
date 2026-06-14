import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Link2, Pencil, RotateCcw, Save, Search, Upload, X } from "lucide-react";
import { api } from "../../api";
import { PeopleCombobox } from "./PeopleCombobox";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { formatBytes } from "../../shared/utils";
import type { AudiobookBookDetail, CategorySummary, CoverCandidate, MetadataCandidate } from "./types";

export type MetadataTab = "edit" | "publishing" | "series" | "cover" | "lookup";

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
  const [activeMetadataTab, setActiveMetadataTab] = useState<MetadataTab>(initialTab);
  const [metadataQuery, setMetadataQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  const [updateDetails, setUpdateDetails] = useState(true);
  const [updateCover, setUpdateCover] = useState(true);
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
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
  const [coverQuery, setCoverQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
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

  const loadCoverCandidates = useCallback(async () => {
    setCoverLoading(true);
    setCoverError("");
    try {
      const payload = await api<{ covers: CoverCandidate[] }>(`/api/library/books/${book.id}/cover-candidates`);
      setCoverCandidates(payload.covers);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to load cover files");
    } finally {
      setCoverLoading(false);
    }
  }, [book.id]);

  useEffect(() => {
    if (activeMetadataTab === "cover") {
      loadCoverCandidates();
    }
  }, [activeMetadataTab, loadCoverCandidates]);

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
    try {
      const params = new URLSearchParams({
        q: metadataQuery || book.title,
        provider: metadataProvider
      });
      const payload = await api<{ candidates: MetadataCandidate[] }>(`/api/library/books/${book.id}/metadata-search?${params}`);
      setMetadataResults(payload.candidates);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to search metadata");
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
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to read metadata from that link");
    } finally {
      setLinkLoading(false);
    }
  };

  const applyMetadata = async (candidate: MetadataCandidate, index: number) => {
    setApplyingIndex(index);
    setMetadataError("");
    try {
      const payload = await api<{ updated: boolean; book: AudiobookBookDetail }>(`/api/library/books/${book.id}/metadata-match`, {
        method: "POST",
        body: JSON.stringify({
          candidate,
          updateDetails,
          updateCover: updateCover && Boolean(candidate.coverUrl)
        })
      });
      onBookUpdated(payload.book);
      setMetadataResults([]);
      onClose();
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "Unable to apply metadata");
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
      setResetError(err instanceof Error ? err.message : "Unable to reset metadata");
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
      setEditError(err instanceof Error ? err.message : "Unable to save metadata");
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
      showUpdatedCover(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to apply cover");
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
      showUpdatedCover(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to upload cover");
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
      setCoverError(err instanceof Error ? err.message : "Unable to search covers");
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
      showUpdatedCover(payload.book);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Unable to apply cover");
      hideOnlineCover(url);
    } finally {
      setCoverSaving("");
    }
  };

  const showUpdatedCover = (updatedBook: AudiobookBookDetail) => {
    const version = Date.now();
    onBookUpdated({
      ...updatedBook,
      coverUrl: updatedBook.coverUrl ? `${updatedBook.coverUrl}?v=${version}` : updatedBook.coverUrl,
      coverLargeUrl: updatedBook.coverLargeUrl ? `${updatedBook.coverLargeUrl}?v=${version}` : updatedBook.coverLargeUrl
    });
  };

  const metadataEditFooter = (
    <>
      {editError && <MessageBox tone="error" title="Metadata edit error">{editError}</MessageBox>}

      <div className="metadata-actions book-metadata-footer">
        {book.metadataSource === "manual" && !resetConfirm && (
          <button className="secondary-button" onClick={() => setResetConfirm(true)}>
            <RotateCcw size={16} />
            <span>Reset to auto</span>
          </button>
        )}
        <span className="book-metadata-footer-spacer" aria-hidden="true"></span>
        <button className="secondary-button" onClick={closeMetadataModal} disabled={editSaving || resetting}>
          Cancel
        </button>
        <button className="primary-button" onClick={saveManualMetadata} disabled={editSaving || !editForm.title.trim()}>
          <Save size={16} />
          <span>{editSaving ? "Saving..." : "Save metadata"}</span>
        </button>
      </div>

      {resetConfirm && (
        <div className="metadata-reset-confirm">
          <p>This will replace all manually edited fields with data from the file scan. Continue?</p>
          <div className="metadata-actions">
            <button className="primary-button" onClick={resetMetadata} disabled={resetting}>
              <RotateCcw size={16} />
              <span>{resetting ? "Resetting..." : "Yes, reset"}</span>
            </button>
            <button className="secondary-button" onClick={() => setResetConfirm(false)} disabled={resetting}>
              Cancel
            </button>
          </div>
          {resetError && <MessageBox tone="error" title="Reset error">{resetError}</MessageBox>}
        </div>
      )}
    </>
  );

  return (
    <Modal
      variant="panel"
      title="Edit Metadata"
      icon={<Pencil size={22} />}
      className="book-metadata-modal"
      headerClassName="book-metadata-header"
      busy={editSaving || resetting}
      onClose={closeMetadataModal}
    >
        <div className="modal-tabs book-metadata-tabs">
          <button className={`modal-tab${activeMetadataTab === "edit" ? " active" : ""}`} onClick={() => setActiveMetadataTab("edit")}>
            Metadata
          </button>
          <button className={`modal-tab${activeMetadataTab === "publishing" ? " active" : ""}`} onClick={() => setActiveMetadataTab("publishing")}>
            Publishing
          </button>
          <button className={`modal-tab${activeMetadataTab === "series" ? " active" : ""}`} onClick={() => setActiveMetadataTab("series")}>
            Series
          </button>
          <button className={`modal-tab${activeMetadataTab === "cover" ? " active" : ""}`} onClick={() => setActiveMetadataTab("cover")}>
            Cover
          </button>
          <button className={`modal-tab${activeMetadataTab === "lookup" ? " active" : ""}`} onClick={() => setActiveMetadataTab("lookup")}>
            Metadata Lookup
          </button>
        </div>

        <div className="modal-tab-content book-metadata-content">
          {activeMetadataTab === "edit" ? (
            <>
              <div className="metadata-edit-grid">
                <label className="field metadata-field-wide">
                  <span>Title</span>
                  <input value={editForm.title} onChange={(event) => setEditForm((form) => ({ ...form, title: event.target.value }))} />
                </label>
                <div className="field metadata-field-half">
                  <span>Authors</span>
                  <PeopleCombobox
                    value={editForm.authors}
                    onChange={(v) => setEditForm((form) => ({ ...form, authors: v }))}
                    suggestions={libraryPeople}
                    placeholder="Add author…"
                  />
                </div>
                <div className="field metadata-field-half">
                  <span>Narrators</span>
                  <PeopleCombobox
                    value={editForm.narrators}
                    onChange={(v) => setEditForm((form) => ({ ...form, narrators: v }))}
                    suggestions={libraryPeople}
                    placeholder="Add narrator…"
                  />
                </div>
                <label className="field metadata-field-half">
                  <span>Category</span>
                  <select value={editForm.categoryKey} onChange={(event) => setEditForm((form) => ({ ...form, categoryKey: event.target.value }))}>
                    <option value="">Auto (from scan)</option>
                    {categories.map((category) => (
                      <option key={category.key} value={category.key}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <div className="field metadata-field-half">
                  <span>Tags</span>
                  <PeopleCombobox
                    value={editForm.tags}
                    onChange={(v) => setEditForm((form) => ({ ...form, tags: v }))}
                    suggestions={libraryTags}
                    placeholder="Add tag…"
                  />
                </div>
                <label className="field metadata-field-wide">
                  <span>Description</span>
                  <textarea value={editForm.description} onChange={(event) => setEditForm((form) => ({ ...form, description: event.target.value }))} rows={4} />
                </label>
              </div>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "publishing" ? (
            <>
              <div className="metadata-edit-grid">
                <label className="field metadata-field-half">
                  <span>Publisher</span>
                  <input value={editForm.publisher} onChange={(event) => setEditForm((form) => ({ ...form, publisher: event.target.value }))} />
                </label>
                <label className="field metadata-field-half">
                  <span>Year</span>
                  <input type="number" value={editForm.yearPublished} onChange={(event) => setEditForm((form) => ({ ...form, yearPublished: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>Language</span>
                  <input value={editForm.language} onChange={(event) => setEditForm((form) => ({ ...form, language: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>ISBN</span>
                  <input value={editForm.isbn} onChange={(event) => setEditForm((form) => ({ ...form, isbn: event.target.value }))} />
                </label>
                <label className="field metadata-field-third">
                  <span>ASIN</span>
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
                    <span>Series</span>
                    <SuggestInput
                      value={editForm.series}
                      onChange={(v) => setEditForm((form) => ({ ...form, series: v }))}
                      suggestions={librarySeries}
                      placeholder="Series name…"
                    />
                  </div>
                  <label className="field">
                    <span>Position</span>
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
                <p className="muted">Choose an existing series or enter a new one, then set this book's position in the series.</p>
              </div>

              {metadataEditFooter}
            </>
          ) : activeMetadataTab === "cover" ? (
            <>
              <div className="cover-tab-layout">
                <section className="cover-current-panel">
                  <span>Current cover</span>
                  <div className="cover-current-preview">
                    {book.coverUrl ? (
                      <img src={book.coverLargeUrl ?? book.coverUrl} alt="" />
                    ) : (
                      <BookOpen size={34} />
                    )}
                  </div>
                </section>

                <section className="cover-picker-panel">
                  <div className="cover-picker-head">
                    <div>
                      <strong>Folder covers</strong>
                      <span>{coverLoading ? "Scanning folder..." : `${coverCandidates.length} image file${coverCandidates.length === 1 ? "" : "s"}`}</span>
                    </div>
                    <button className="secondary-button compact-button" onClick={loadCoverCandidates} disabled={coverLoading || Boolean(coverSaving)}>
                      <RotateCcw size={14} />
                      <span>Refresh</span>
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
                        <strong>{coverSaving === cover.relativePath ? "Applying..." : "Apply"}</strong>
                      </button>
                    ))}
                    {!coverLoading && coverCandidates.length === 0 && (
                      <p className="management-empty">No cover image files were found in this audiobook folder.</p>
                    )}
                  </div>
                </section>
              </div>

              <section className="cover-online-panel">
                <div className="cover-picker-head">
                  <div>
                    <strong>Find covers online</strong>
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
                      placeholder="Search title or author"
                      aria-label="Search online covers"
                    />
                  </label>
                  <button className="primary-button metadata-search-button" onClick={searchOnlineCovers} disabled={onlineCoversLoading}>
                    <Search size={16} />
                    <span>{onlineCoversLoading ? "Searching..." : "Search"}</span>
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
                            <strong>{coverSaving === cover.url ? "Applying..." : "Use this cover"}</strong>
                          </button>
                        ))}
                    </div>
                  ) : (
                    !onlineCoversLoading && <p className="management-empty">No cover art found. Try a different title or author.</p>
                  )
                )}
              </section>

              <label className="cover-upload-panel">
                <Upload size={18} />
                <span>{coverSaving === "upload" ? "Uploading..." : "Upload new cover"}</span>
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

              {coverError && <MessageBox tone="error" title="Cover error">{coverError}</MessageBox>}
            </>
          ) : (
            <>
              <div className="metadata-search-row">
                <select
                  className="library-filter"
                  value={metadataProvider}
                  onChange={(event) => setMetadataProvider(event.target.value as typeof metadataProvider)}
                  aria-label="Metadata provider"
                >
                  <option value="all">All providers</option>
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
                    placeholder="Search title or ASIN"
                    aria-label="Search metadata"
                  />
                </label>
                <button className="primary-button metadata-search-button" onClick={searchMetadata} disabled={metadataLoading}>
                  <Search size={16} />
                  <span>{metadataLoading ? "Searching..." : "Search"}</span>
                </button>
              </div>

              <div className="metadata-apply-controls">
                <label>
                  <input type="checkbox" checked={updateDetails} onChange={(event) => setUpdateDetails(event.target.checked)} />
                  <span>Update details</span>
                </label>
                <label>
                  <input type="checkbox" checked={updateCover} onChange={(event) => setUpdateCover(event.target.checked)} />
                  <span>Update cover</span>
                </label>
              </div>

              <div className="metadata-link-row">
                <label className="search-field metadata-link-field">
                  <Link2 size={16} aria-hidden="true" />
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(event) => setLinkUrl(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") fetchFromLink(); }}
                    placeholder="…or paste a book link"
                    aria-label="Book metadata link"
                  />
                </label>
                <button className="secondary-button metadata-search-button" onClick={fetchFromLink} disabled={linkLoading || !linkUrl.trim()}>
                  <Link2 size={16} />
                  <span>{linkLoading ? "Fetching..." : "Fetch"}</span>
                </button>
                <small className="metadata-link-hint">Pull metadata straight from an Open Library, Apple Books, FantLab, or LibriVox page.</small>
              </div>

              {metadataError && <MessageBox tone="error" title="Metadata lookup error">{metadataError}</MessageBox>}

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
                      <span>{candidate.authors.length > 0 ? `by ${candidate.authors.join(", ")}` : "Unknown author"}</span>
                      <small>
                        {[candidate.narrators?.length ? `Narrators: ${candidate.narrators.join(", ")}` : "", candidate.publisher, candidate.source]
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
                        <span>{applyingIndex === index ? "Applying..." : "Apply"}</span>
                      </button>
                      <button
                        className="secondary-button compact-button metadata-details-button"
                        onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                        aria-expanded={expandedIndex === index}
                      >
                        {expandedIndex === index ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                        <span>Details</span>
                      </button>
                    </div>
                    {expandedIndex === index && <ResultCompare book={book} candidate={candidate} />}
                  </article>
                ))}
                {!metadataLoading && metadataResults.length === 0 && (
                  <p className="management-empty">Search for a provider match to update details and cover art.</p>
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
function ResultCompare({ book, candidate }: { book: AudiobookBookDetail; candidate: MetadataCandidate }) {
  const rows = [
    { label: "Title", current: book.title, next: candidate.title },
    { label: "Original title", current: "", next: candidate.subtitle ?? "" },
    { label: "Authors", current: book.authors.join(", "), next: candidate.authors.join(", ") },
    { label: "Narrators", current: book.narrators.join(", "), next: (candidate.narrators ?? []).join(", ") },
    { label: "Year", current: book.yearPublished?.toString() ?? "", next: candidate.year?.toString() ?? "" },
    { label: "Publisher", current: book.publisher ?? "", next: candidate.publisher ?? "" },
    { label: "Language", current: book.language ?? "", next: candidate.language ?? "" },
    { label: "ISBN", current: book.isbn ?? "", next: candidate.isbn ?? "" },
    { label: "ASIN", current: book.asin ?? "", next: candidate.asin ?? "" },
    { label: "Tags", current: book.tags.join(", "), next: (candidate.genres ?? []).join(", ") },
    { label: "Description", current: book.description ?? "", next: candidate.description ?? "" }
  ];

  const changed = (current: string, next: string) => next.trim().length > 0 && next.trim() !== current.trim();
  const visible = rows.filter((row) => row.current.trim() || row.next.trim());

  return (
    <div className="metadata-result-compare">
      <div className="compare-row compare-head-row" aria-hidden="true">
        <span></span>
        <span>Current</span>
        <span>From this result</span>
      </div>
      {visible.map((row) => (
        <div className={`compare-row${changed(row.current, row.next) ? " changed" : ""}`} key={row.label}>
          <span className="compare-label">{row.label}</span>
          <span className="compare-current">{row.current || "—"}</span>
          <span className="compare-next">
            {row.next || "—"}
            {changed(row.current, row.next) && <em className="compare-flag">changes</em>}
          </span>
        </div>
      ))}
      <div className="compare-row compare-cover-row">
        <span className="compare-label">Cover</span>
        <span className="compare-current">
          <span className="compare-cover-frame">
            {book.coverUrl ? <img src={book.coverLargeUrl ?? book.coverUrl} alt="" /> : <BookOpen size={20} />}
          </span>
        </span>
        <span className="compare-next">
          <span className="compare-cover-frame">
            {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <BookOpen size={20} />}
          </span>
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
