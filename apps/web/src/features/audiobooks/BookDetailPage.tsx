import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Bookmark, BookOpen, Calendar, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, File as FileIcon, FileText, Globe, HardDrive, Headphones, Heart, Library, MoreHorizontal, Pencil, Play, RotateCcw, Save, Search, Share2, Upload, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { ShareModal } from "../share/ShareModal";
import { EpubReader } from "./EpubReader";
import { PeopleCombobox } from "./PeopleCombobox";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { useDownload } from "../../offline/useDownload";
import { isStandalone } from "../../pwa/platform";
import { InstallCta } from "../../pwa/InstallCta";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBookDetail, BookSave, CategorySummary, CoverCandidate, MetadataCandidate, PlaybackProgress } from "./types";

// Document formats we can render in the in-app reader overlay. Others (mobi,
// azw3) get download-only — no in-browser renderer.
const VIEWABLE_DOC_FORMATS = new Set(["pdf", "epub"]);

export function AudiobookBookPage({
  id,
  user,
  logout,
  active = "audiobooks",
  backTo = "/audiobooks"
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
  active?: "audiobooks" | "ebooks";
  backTo?: string;
}) {
  const [book, setBook] = useState<AudiobookBookDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setBook(null);
    setError("");
    api<{ book: AudiobookBookDetail }>(`/api/library/books/${id}`)
      .then((payload) => setBook(payload.book))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load details"));
  }, [id]);

  return (
    <DashboardShell active={active} user={user} logout={logout}>
      <section className="work-area book-detail-area">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
          {book ? (
            <BookDetailView
              book={book}
              onBack={() => navigate(backTo)}
              onBookUpdated={setBook}
            />
          ) : !error ? (
            <p className="management-empty">Loading…</p>
          ) : null}
        </div>
      </section>
    </DashboardShell>
  );
}

function BookDetailView({
  book,
  onBack,
  onBookUpdated
}: {
  book: AudiobookBookDetail;
  onBack: () => void;
  onBookUpdated: (book: AudiobookBookDetail) => void;
}) {
  const [progress, setProgress] = useState<PlaybackProgress | null>(null);
  const [activeBookTab, setActiveBookTab] = useState<"description" | "files">("description");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [save, setSave] = useState<BookSave | null>(null);
  const [saveAction, setSaveAction] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<{ id: string; fileName: string; url: string; format: string } | null>(null);
  const detailMenuRef = useRef<HTMLDivElement>(null);
  const offline = useDownload(book);

  // Close the full-screen reader on Escape.
  useEffect(() => {
    if (!viewerDoc) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setViewerDoc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerDoc]);

  useEffect(() => {
    if (!detailMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (detailMenuRef.current && !detailMenuRef.current.contains(event.target as Node)) {
        setDetailMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDetailMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [detailMenuOpen]);

  // An ebook (or any audio-less book): content is a document, not audio tracks.
  const isEbook = book.files.length === 0 && book.documents.length > 0;
  const [activeMetadataTab, setActiveMetadataTab] = useState<"edit" | "publishing" | "series" | "cover" | "lookup">("edit");
  const [metadataQuery, setMetadataQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [metadataProvider, setMetadataProvider] = useState<"all" | MetadataCandidate["source"]>("all");
  const [updateDetails, setUpdateDetails] = useState(true);
  const [updateCover, setUpdateCover] = useState(true);
  const [metadataResults, setMetadataResults] = useState<MetadataCandidate[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetError, setResetError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [progressAction, setProgressAction] = useState<"complete" | "reset" | "">("");
  const [progressActionError, setProgressActionError] = useState("");
  const [coverCandidates, setCoverCandidates] = useState<CoverCandidate[]>([]);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverSaving, setCoverSaving] = useState("");
  const [coverError, setCoverError] = useState("");
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

  useEffect(() => {
    setActiveBookTab("description");
    setDescriptionExpanded(false);
    setDetailsExpanded(false);
    setDetailMenuOpen(false);
  }, [book.id]);

  useEffect(() => {
    const loadProgress = () => api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`)
      .then((payload) => setProgress(payload.progress))
      .catch(() => setProgress(null));
    loadProgress();
    // The player opens in a separate window, so refresh when this page regains
    // focus — returning after listening then reflects the latest position.
    const onFocus = () => loadProgress();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [book.id]);

  useEffect(() => {
    setSave(null);
    setSaveError("");
    api<{ save: BookSave }>(`/api/library/books/${book.id}/save`)
      .then((payload) => setSave(payload.save))
      .catch(() => setSave(null));
  }, [book.id]);

  // Derive per-file listened status from the book-level progress (current file +
  // linear order). Accurate for sequential listening; an approximation if the
  // user jumped around.
  const currentFileIndex = progress?.fileId ? book.files.findIndex((f) => f.id === progress.fileId) : -1;
  const bookFinished = progress?.completedAt != null || (progress?.percentComplete != null && progress.percentComplete >= 0.98);
  const fileState = (index: number): "completed" | "in_progress" | "not_started" => {
    if (bookFinished) return "completed";
    if (currentFileIndex < 0) return "not_started";
    if (index < currentFileIndex) return "completed";
    if (index === currentFileIndex) return "in_progress";
    return "not_started";
  };

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
    if (metadataModalOpen && activeMetadataTab === "cover") {
      loadCoverCandidates();
    }
  }, [activeMetadataTab, loadCoverCandidates, metadataModalOpen]);

  useEffect(() => {
    if (!metadataModalOpen) return;
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
  }, [metadataModalOpen, book.libraryId]);

  const searchMetadata = async () => {
    setMetadataLoading(true);
    setMetadataError("");
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
      setMetadataModalOpen(false);
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
      setMetadataModalOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save metadata");
    } finally {
      setEditSaving(false);
    }
  };

  const closeMetadataModal = () => {
    setMetadataModalOpen(false);
    setResetConfirm(false);
  };

  const markBookFinished = async () => {
    setProgressAction("complete");
    setProgressActionError("");
    try {
      await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
      const lastFile = book.files.filter((file) => file.status === "available").at(-1) ?? book.files.at(-1);
      setProgress({
        fileId: lastFile?.id ?? null,
        positionSeconds: lastFile?.durationSeconds ?? book.durationSeconds ?? 0,
        percentComplete: 1,
        completedAt: new Date().toISOString()
      });
    } catch (err) {
      setProgressActionError(err instanceof Error ? err.message : "Unable to mark book finished");
    } finally {
      setProgressAction("");
    }
  };

  const resetProgress = async () => {
    setProgressAction("reset");
    setProgressActionError("");
    try {
      await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
      setProgress(null);
    } catch (err) {
      setProgressActionError(err instanceof Error ? err.message : "Unable to reset progress");
    } finally {
      setProgressAction("");
    }
  };

  const toggleSave = async () => {
    setSaveAction(true);
    setSaveError("");
    try {
      if (save?.saved) {
        await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
        setSave({ saved: false, note: null });
      } else {
        const payload = await api<{ save: BookSave }>(`/api/library/books/${book.id}/save`, {
          method: "PUT",
          body: JSON.stringify({ note: null })
        });
        setSave(payload.save);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to update favorites");
    } finally {
      setSaveAction(false);
    }
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

  const showUpdatedCover = (updatedBook: AudiobookBookDetail) => {
    const version = Date.now();
    onBookUpdated({
      ...updatedBook,
      coverUrl: updatedBook.coverUrl ? `${updatedBook.coverUrl}?v=${version}` : updatedBook.coverUrl,
      coverLargeUrl: updatedBook.coverLargeUrl ? `${updatedBook.coverLargeUrl}?v=${version}` : updatedBook.coverLargeUrl
    });
  };

  const fileFormat = (relativePath: string) => {
    const extension = relativePath.split(/[\\/]/).at(-1)?.split(".").at(-1);
    return extension && extension !== relativePath ? extension.toUpperCase() : null;
  };
  const audioFormat = [...new Set(book.files.map((file) => fileFormat(file.relativePath)).filter(Boolean))]
    .slice(0, 2)
    .join(", ");
  const documentFormat = book.documents[0]?.format.toUpperCase() ?? "";
  const formatValue = isEbook ? documentFormat : audioFormat || "Audio";
  const currentProgressFile = progress?.fileId ? book.files.find((file) => file.id === progress.fileId) : null;
  const progressPercent = progress?.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, progress?.percentComplete ?? 0)) * 100);
  // "Started" covers any saved progress — even when the percentage is unknown
  // (a book whose total duration wasn't recorded) or rounds down to 0%.
  const hasStarted = !bookFinished && progress != null
    && ((progress.percentComplete ?? 0) > 0 || (progress.positionSeconds ?? 0) > 0 || progress.fileId != null);
  const remainingSeconds = book.durationSeconds != null ? Math.max(0, Math.round(book.durationSeconds * (1 - progressPercent / 100))) : null;
  const progressTitle = isEbook ? "Reading Progress" : "Listening Progress";
  const progressActionLabel = isEbook
    ? (hasStarted ? "Continue Reading" : "Read")
    : bookFinished ? "Listen Again" : hasStarted ? "Continue Listening" : "Start Listening";
  const progressLocation = progress?.completedAt
    ? "Completed"
    : currentProgressFile
      ? currentProgressFile.chapterTitle || currentProgressFile.relativePath.split(/[\\/]/).at(-1) || currentProgressFile.relativePath
      : hasStarted ? "In progress" : "Not started yet";

  // Referrer so detail pages reached from here can offer "Back" to this book.
  const linkFrom = `?from=${encodeURIComponent(`/audiobooks/books/${book.id}`)}`;
  type DetailLink = { text: string; href: string };
  type DetailRow = { label: string; value: string; icon: LucideIcon; className?: string; links?: DetailLink[] };
  const heroDetailRows = ([
    book.narrators.length > 0 ? {
      label: "Narrator",
      value: book.narrators.join(", "),
      icon: Headphones,
      links: book.narrators.map((name) => ({ text: name, href: `/audiobooks/narrators/${encodeURIComponent(name)}${linkFrom}` }))
    } : null,
    { label: "Library", value: book.libraryName, icon: Library },
    formatValue ? { label: "Format", value: formatValue, icon: FileIcon } : null,
    book.category ? {
      label: "Category",
      value: book.category.name,
      icon: Bookmark,
      links: [{ text: book.category.name, href: `/audiobooks/categories/${book.category.key}${linkFrom}` }]
    } : null,
    book.durationSeconds != null ? { label: isEbook ? "Length" : "Audio Length", value: formatDuration(book.durationSeconds), icon: Clock } : null,
    book.totalSize > 0 ? { label: "File Size", value: formatBytes(book.totalSize), icon: HardDrive } : null,
    book.series ? {
      label: "Series",
      value: `${book.series}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ""}`,
      icon: BookOpen,
      links: book.seriesId ? [{ text: `${book.series}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ""}`, href: `/audiobooks/series/${book.seriesId}${linkFrom}` }] : undefined
    } : null
  ] as (DetailRow | null)[]).filter((row): row is DetailRow => Boolean(row));
  const detailRows = ([
    book.yearPublished ? { label: "Published", value: String(book.yearPublished), icon: Calendar } : null,
    ...heroDetailRows,
    { label: "Publisher", value: book.publisher || "Not available", icon: BookOpen },
    book.language ? { label: "Language", value: book.language, icon: Globe } : null,
    { label: "ISBN", value: book.isbn || "Not available", icon: FileText },
    { label: "ASIN", value: book.asin || "Not available", icon: FileText },
    {
      label: "Path",
      value: book.folderPath,
      icon: FileText,
      className: "book-folder-path"
    }
  ] as (DetailRow | null)[]).filter((row): row is DetailRow => Boolean(row));
  const moreDetailRows = detailRows.filter(
    (row) => !heroDetailRows.some((heroRow) => heroRow.label === row.label && heroRow.value === row.value)
  );
  const detailTabs = [
    { id: "description", label: "Description" },
    { id: "files", label: "Files" }
  ] as const;
  const descriptionText = book.description?.trim() ?? "";
  const canExpandDescription = descriptionText.length > 420;
  const visibleDescription = canExpandDescription && !descriptionExpanded
    ? `${descriptionText.slice(0, 420).trimEnd()}...`
    : descriptionText;

  const renderRowValue = (row: DetailRow) =>
    row.links
      ? row.links.map((lnk, i) => (
          <Fragment key={lnk.href}>
            {i > 0 && ", "}
            <a className="book-detail-link" href={lnk.href} onClick={(event) => followRoute(event, lnk.href)}>{lnk.text}</a>
          </Fragment>
        ))
      : row.value;

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
    <div className="book-detail-view">
      <div className="book-detail-topbar">
        <button className="audiobook-back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Back to audiobooks</span>
        </button>
      </div>

      <div className="book-detail-head">
        <div className="book-detail-cover-col">
          <div className="book-detail-cover" aria-hidden="true">
            {book.coverUrl ? (
              <img src={book.coverLargeUrl ?? book.coverUrl} alt="" />
            ) : (
              <>
                <BookOpen size={32} />
                <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
              </>
            )}
          </div>
          {(book.category || book.tags.length > 0) && (
            <section className="book-tags book-tags-under-cover" aria-label="Tags">
              {book.category && (
                <button
                  className="book-tag-chip"
                  type="button"
                  onClick={() => navigate(`/audiobooks/categories/${book.category?.key}${linkFrom}`)}
                >
                  {book.category.name}
                </button>
              )}
              {book.tags.map((tag) => (
                <button
                  className="book-tag-chip"
                  key={tag}
                  type="button"
                  onClick={() => navigate(`/audiobooks/tags/${encodeURIComponent(tag)}`)}
                >
                  {tag}
                </button>
              ))}
            </section>
          )}
        </div>

        <div className="book-detail-info">
          <h1 className="book-detail-title">{book.title}</h1>
          {book.authors.length > 0 && (
            <p className="book-detail-author">
              {book.authors.map((name, i) => {
                const href = `/audiobooks/authors/${encodeURIComponent(name)}${linkFrom}`;
                return (
                  <Fragment key={name}>
                    {i > 0 && ", "}
                    <a className="book-detail-link" href={href} onClick={(event) => followRoute(event, href)}>{name}</a>
                  </Fragment>
                );
              })}
            </p>
          )}

          <dl className="book-detail-meta-grid">
            {heroDetailRows.map((row) => (
              <div className="book-detail-meta-item" key={`${row.label}-${row.value}`}>
                <row.icon size={18} aria-hidden="true" />
                <dt>{row.label}</dt>
                <dd className={row.className}>{renderRowValue(row)}</dd>
              </div>
            ))}
          </dl>
          {moreDetailRows.length > 0 && (
            <div className="book-detail-more-details">
              <button
                className="book-detail-more"
                type="button"
                onClick={() => setDetailsExpanded((expanded) => !expanded)}
                aria-expanded={detailsExpanded}
              >
                {detailsExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                <span>{detailsExpanded ? "Hide details" : "More details"}</span>
              </button>
              {detailsExpanded && (
                <section className="book-detail-more-details-panel" aria-label="More details">
                  <dl className="book-detail-meta-grid full">
                    {moreDetailRows.map((row) => (
                      <div className="book-detail-meta-item" key={`${row.label}-${row.value}`}>
                        <row.icon size={18} aria-hidden="true" />
                        <dt>{row.label}</dt>
                        <dd className={row.className}>{renderRowValue(row)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
            </div>
          )}

          <div className="book-detail-actions">
            {isEbook ? (
              <button
                className="primary-button"
                onClick={() => { const doc = book.documents[0]; if (doc) setViewerDoc({ id: doc.id, fileName: doc.fileName, url: doc.url, format: doc.format }); }}
              >
                <BookOpen size={16} />
                <span>{progressActionLabel}</span>
              </button>
            ) : (
              <button
                className="primary-button"
                onClick={() => window.open(`/player/${book.id}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes")}
              >
                <Play size={16} />
                <span>{progressActionLabel}</span>
              </button>
            )}
            <button className="secondary-button" onClick={toggleSave} disabled={saveAction} aria-pressed={save?.saved ?? false}>
              <Heart size={16} fill={save?.saved ? "currentColor" : "none"} />
              <span>{saveAction ? "Saving..." : save?.saved ? "Favorited" : "Add to Favorites"}</span>
            </button>
            {!isEbook && isStandalone() && book.files.some((f) => f.status === "available") && (
              <button
                className={`secondary-button${offline.record?.state === "complete" ? " offline-saved" : ""}`}
                onClick={() => {
                  if (offline.busy) return;
                  if (offline.record?.state === "complete") {
                    if (window.confirm("Remove this downloaded book from this device?")) void offline.remove();
                  } else {
                    void offline.start();
                  }
                }}
                disabled={offline.busy}
                aria-label={offline.record?.state === "complete" ? "Remove offline download" : "Save for offline listening"}
              >
                {offline.record?.state === "complete" ? (
                  <><CheckCircle2 size={16} /><span>Saved offline</span></>
                ) : offline.busy ? (
                  <><Download size={16} /><span>Downloading {Math.round(offline.progress * 100)}%</span></>
                ) : (
                  <><Download size={16} /><span>Save offline</span></>
                )}
              </button>
            )}
            <div className="book-detail-menu-wrap" ref={detailMenuRef}>
              <button
                className="secondary-button book-detail-more-action"
                type="button"
                onClick={() => setDetailMenuOpen((open) => !open)}
                aria-expanded={detailMenuOpen}
                aria-haspopup="menu"
                aria-label="More options"
                title="More options"
              >
                <MoreHorizontal size={17} />
              </button>
              {detailMenuOpen && (
                <div className="book-detail-action-menu" role="menu" aria-label="Book actions">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActiveMetadataTab("edit");
                      setMetadataModalOpen(true);
                      setDetailMenuOpen(false);
                    }}
                  >
                    <Pencil size={17} aria-hidden="true" />
                    <span>Edit metadata</span>
                  </button>
                  {!isEbook && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDetailMenuOpen(false);
                        void markBookFinished();
                      }}
                      disabled={progressAction !== ""}
                    >
                      <CheckCircle2 size={17} aria-hidden="true" />
                      <span>{progressAction === "complete" ? "Saving..." : "Mark finished"}</span>
                    </button>
                  )}
                  {!isEbook && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDetailMenuOpen(false);
                        void resetProgress();
                      }}
                      disabled={progressAction !== ""}
                    >
                      <RotateCcw size={17} aria-hidden="true" />
                      <span>{progressAction === "reset" ? "Resetting..." : "Reset progress"}</span>
                    </button>
                  )}
                  <a
                    role="menuitem"
                    href={`/api/library/books/${book.id}/download`}
                    download
                    onClick={() => setDetailMenuOpen(false)}
                  >
                    <Download size={17} aria-hidden="true" />
                    <span>Download</span>
                  </a>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShareModalOpen(true);
                      setDetailMenuOpen(false);
                    }}
                  >
                    <Share2 size={17} aria-hidden="true" />
                    <span>Share</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          {!isEbook && !isStandalone() && book.files.some((f) => f.status === "available") && (
            <InstallCta
              title="Download for offline"
              subtitle="Install the app to save this book and listen without a connection."
            />
          )}
          {saveError && <MessageBox tone="error" title="Favorites error">{saveError}</MessageBox>}
          {progressActionError && <MessageBox tone="error" title="Progress error">{progressActionError}</MessageBox>}
          {offline.error && <MessageBox tone="error" title="Download error">{offline.error}</MessageBox>}

          <section className="book-progress-card" aria-label={progressTitle}>
            <div className="book-progress-head">
              <strong>{progressTitle}</strong>
              <b>{progressPercent}%</b>
            </div>
            <span className="book-progress-track">
              <span style={{ width: `${progressPercent}%` }} />
            </span>
            <div className="book-progress-meta">
              <span>{progressLocation}</span>
              {remainingSeconds != null && !progress?.completedAt && <span>{formatDuration(remainingSeconds)} left</span>}
            </div>
          </section>
        </div>
      </div>

      <section className="book-detail-tabs-section">
        <nav className="book-detail-tabs" aria-label="Book detail sections">
          {detailTabs.map((tab) => (
            <button
              className={activeBookTab === tab.id ? "active" : ""}
              key={tab.id}
              type="button"
              onClick={() => setActiveBookTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="book-detail-tab-panel">
          {activeBookTab === "description" && (
            <section className="book-description-block">
              {descriptionText ? (
                <>
                  <p className="book-description">{visibleDescription}</p>
                  {canExpandDescription && (
                    <button
                      className="book-detail-more book-description-more"
                      type="button"
                      onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                      aria-expanded={descriptionExpanded}
                    >
                      {descriptionExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                      <span>{descriptionExpanded ? "Show less description" : "Show full description"}</span>
                    </button>
                  )}
                </>
              ) : (
                <p className="book-description muted">No description yet.</p>
              )}
            </section>
          )}

          {activeBookTab === "files" && (
            <section className="book-detail-files-tab">
              {book.documents.length > 0 && (
                <section className="book-documents-section">
                  <h2 className="book-documents-title">Documents</h2>
                  <div className="book-document-list">
                    {book.documents.map((doc) => (
                      <div className="book-document-row" key={doc.id}>
                        <FileText size={18} aria-hidden="true" />
                        <div className="book-document-info">
                          <strong>{doc.fileName}</strong>
                          <small>{doc.format.toUpperCase()} · {formatBytes(doc.size)}</small>
                        </div>
                        {VIEWABLE_DOC_FORMATS.has(doc.format) && (
                          <button
                            className="secondary-button compact-button"
                            onClick={() => setViewerDoc({ id: doc.id, fileName: doc.fileName, url: doc.url, format: doc.format })}
                          >
                            <BookOpen size={15} />
                            <span>Read</span>
                          </button>
                        )}
                        <a className="secondary-button compact-button" href={`${doc.url}?download`} download>
                          <Download size={15} />
                          <span>Download</span>
                        </a>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!isEbook && (
                <section className="book-files-section">
                  <div className="book-file-list">
                    {book.files.map((file, index) => {
                      const state = fileState(index);
                      return (
                        <article className="book-file-row" key={file.id}>
                          <span>{file.trackNumber ?? "-"}</span>
                          <div>
                            <strong>{file.chapterTitle || file.relativePath.split(/[\\/]/).at(-1) || file.relativePath}</strong>
                            <small>{file.relativePath}</small>
                          </div>
                          <span className={`book-file-status ${state}`}>
                            {state === "completed" && (<><CheckCircle2 size={13} /> Done</>)}
                            {state === "in_progress" && (<><span className="book-file-dot" /> Playing</>)}
                            {state === "not_started" && "-"}
                          </span>
                          <small>
                            {file.durationSeconds != null ? `${formatDuration(file.durationSeconds)} · ` : ""}
                            {formatBytes(file.size)}
                          </small>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}
            </section>
          )}
        </div>
      </section>

      {shareModalOpen && (
        <ShareModal bookId={book.id} bookTitle={book.title} onClose={() => setShareModalOpen(false)} />
      )}

      {viewerDoc && createPortal(
        <div className="doc-viewer-backdrop" role="dialog" aria-modal="true" aria-label={viewerDoc.fileName}>
          <div className="doc-viewer-head">
            <span className="doc-viewer-name">{viewerDoc.fileName}</span>
            <div className="doc-viewer-actions">
              <a className="secondary-button compact-button" href={`${viewerDoc.url}?download`} download>
                <Download size={15} />
                <span>Download</span>
              </a>
              <button className="modal-close" onClick={() => setViewerDoc(null)} aria-label="Close reader">
                <X size={18} />
              </button>
            </div>
          </div>
          {viewerDoc.format === "epub"
            ? <EpubReader url={viewerDoc.url} />
            : <iframe className="doc-viewer-frame" src={viewerDoc.url} title={viewerDoc.fileName} />}
        </div>,
        document.body
      )}

      {metadataModalOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeMetadataModal(); }}>
          <div className="metadata-modal book-metadata-modal" role="dialog" aria-modal="true" aria-label="Edit Metadata">
            <div className="modal-header book-metadata-header">
              <div className="book-metadata-title">
                <span className="book-metadata-title-icon" aria-hidden="true">
                  <Pencil size={22} />
                </span>
                <h2>Edit Metadata</h2>
              </div>
              <button className="modal-close" onClick={closeMetadataModal} aria-label="Close">
                <X size={22} />
              </button>
            </div>

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
                        <button
                          className="primary-button compact-button metadata-apply-button"
                          onClick={() => applyMetadata(candidate, index)}
                          disabled={applyingIndex !== null}
                        >
                          <CheckCircle2 size={15} />
                          <span>{applyingIndex === index ? "Applying..." : "Apply"}</span>
                        </button>
                      </article>
                    ))}
                    {!metadataLoading && metadataResults.length === 0 && (
                      <p className="management-empty">Search for a provider match to update details and cover art.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

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

