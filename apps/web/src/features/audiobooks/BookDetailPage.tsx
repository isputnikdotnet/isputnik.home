import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Bookmark, BookOpen, Calendar, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, File as FileIcon, FileText, Globe, HardDrive, Headphones, Heart, Library, ListMusic, Pencil, Play, RotateCcw, Share2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, isAccessOrMissingApiError, type PublicUser } from "../../api";
import { ShareModal } from "../share/ShareModal";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { EpubReader } from "./EpubReader";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { getDownloadedBookDetail } from "../../offline/downloads";
import { useDownload } from "../../offline/useDownload";
import { isStandalone } from "../../pwa/platform";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBookDetail, BookSave, PlaybackProgress, ReadingProgress } from "./types";

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
    let cancelled = false;
    setBook(null);
    setError("");
    const load = async () => {
      try {
        const payload = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${id}`);
        if (!cancelled) setBook(payload.book);
      } catch (err) {
        const fallback = isAccessOrMissingApiError(err) ? null : await getDownloadedBookDetail(id);
        if (cancelled) return;
        if (fallback) {
          setBook(fallback);
        } else {
          setError(err instanceof Error ? err.message : "Unable to load details");
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [id]);

  return (
    <DashboardShell active={active} user={user} logout={logout}>
      <section className="work-area book-detail-area">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
          {book ? (
            <BookDetailView
              book={book}
              userId={user.id}
              onBack={() => navigate(backTo)}
              backLabel={active === "ebooks" ? "Back to ebooks" : "Back to audiobooks"}
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
  userId,
  onBack,
  backLabel,
  onBookUpdated
}: {
  book: AudiobookBookDetail;
  userId: string;
  onBack: () => void;
  backLabel: string;
  onBookUpdated: (book: AudiobookBookDetail) => void;
}) {
  const [progress, setProgress] = useState<PlaybackProgress | null>(null);
  const [activeBookTab, setActiveBookTab] = useState<"description" | "files">("description");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [save, setSave] = useState<BookSave | null>(null);
  const [saveAction, setSaveAction] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [addToCollectionOpen, setAddToCollectionOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<{ id: string; fileName: string; url: string; format: string } | null>(null);
  const [readingProgress, setReadingProgress] = useState<ReadingProgress | null>(null);
  const offline = useDownload(book);

  // Close the full-screen reader on Escape.
  useEffect(() => {
    if (!viewerDoc) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setViewerDoc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerDoc]);

  // An ebook (or any audio-less book): content is a document, not audio tracks.
  const isEbook = book.files.length === 0 && book.documents.length > 0;
  const primaryReadableDoc = book.documents.find((doc) => VIEWABLE_DOC_FORMATS.has(doc.format)) ?? book.documents[0] ?? null;
  const primaryReaderStorageKey = primaryReadableDoc
    ? `isputnik:epub-progress:${userId}:${book.id}:${primaryReadableDoc.id}`
    : "";
  const [progressAction, setProgressAction] = useState<"complete" | "reset" | "">("");
  const [progressActionError, setProgressActionError] = useState("");

  useEffect(() => {
    setActiveBookTab("description");
    setDescriptionExpanded(false);
    setDetailsExpanded(false);
    setReadingProgress(null);
  }, [book.id]);

  useEffect(() => {
    let cancelled = false;
    setReadingProgress(null);
    if (!primaryReadableDoc || primaryReadableDoc.format !== "epub") {
      return () => { cancelled = true; };
    }

    api<{ progress: ReadingProgress | null }>(
      `/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(primaryReadableDoc.id)}`
    )
      .then((payload) => { if (!cancelled) setReadingProgress(payload.progress); })
      .catch(() => { if (!cancelled) setReadingProgress(null); });

    return () => { cancelled = true; };
  }, [book.id, primaryReadableDoc?.id, primaryReadableDoc?.format]);

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
  const audioFinished = progress?.completedAt != null || (progress?.percentComplete != null && progress.percentComplete >= 0.98);
  const readingFinished = readingProgress?.completedAt != null || (readingProgress?.percentComplete != null && readingProgress.percentComplete >= 0.98);
  const bookFinished = isEbook ? readingFinished : audioFinished;
  const fileState = (index: number): "completed" | "in_progress" | "not_started" => {
    if (bookFinished) return "completed";
    if (currentFileIndex < 0) return "not_started";
    if (index < currentFileIndex) return "completed";
    if (index === currentFileIndex) return "in_progress";
    return "not_started";
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
      if (isEbook && primaryReadableDoc?.format === "epub") {
        await api(`/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(primaryReadableDoc.id)}`, { method: "DELETE" });
        try { localStorage.removeItem(primaryReaderStorageKey); } catch { /* ignore */ }
        setReadingProgress(null);
      } else {
        await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
        setProgress(null);
      }
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
  const progressPercent = isEbook
    ? readingProgress?.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, readingProgress?.percentComplete ?? 0)) * 100)
    : progress?.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, progress?.percentComplete ?? 0)) * 100);
  // "Started" covers any saved progress — even when the percentage is unknown
  // (a book whose total duration wasn't recorded) or rounds down to 0%.
  const hasStarted = isEbook
    ? !bookFinished && readingProgress != null && ((readingProgress.percentComplete ?? 0) > 0 || Boolean(readingProgress.cfi))
    : !bookFinished && progress != null && ((progress.percentComplete ?? 0) > 0 || (progress.positionSeconds ?? 0) > 0 || progress.fileId != null);
  const remainingSeconds = !isEbook && book.durationSeconds != null ? Math.max(0, Math.round(book.durationSeconds * (1 - progressPercent / 100))) : null;
  const progressTitle = isEbook ? "Reading Progress" : "Listening Progress";
  const progressActionLabel = isEbook
    ? (hasStarted ? "Continue Reading" : "Read")
    : bookFinished ? "Listen Again" : hasStarted ? "Continue Listening" : "Start Listening";
  const progressLocation = bookFinished
    ? "Completed"
    : isEbook
      ? readingProgress?.label ?? (hasStarted ? "In progress" : "Not started yet")
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

  return (
    <div className="book-detail-view">
      <div className="book-detail-topbar">
        <button className="audiobook-back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{backLabel}</span>
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
                  className="book-tag-chip book-tag-chip-category"
                  type="button"
                  onClick={() => navigate(`/audiobooks/categories/${book.category?.key}${linkFrom}`)}
                >
                  {book.category.name}
                </button>
              )}
              {book.tags.map((tag) => (
                <button
                  className="book-tag-chip book-tag-chip-tag"
                  key={tag}
                  type="button"
                  onClick={() => navigate(`/audiobooks/tags/${encodeURIComponent(tag)}${linkFrom}`)}
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
                onClick={() => { const doc = primaryReadableDoc; if (doc) setViewerDoc({ id: doc.id, fileName: doc.fileName, url: doc.url, format: doc.format }); }}
                disabled={!primaryReadableDoc || !VIEWABLE_DOC_FORMATS.has(primaryReadableDoc.format)}
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
            <button
              className={`book-detail-icon-action${save?.saved ? " on" : ""}`}
              type="button"
              onClick={toggleSave}
              disabled={saveAction}
              aria-pressed={save?.saved ?? false}
              aria-label={saveAction ? "Saving favorite" : save?.saved ? "Remove from favorites" : "Add to favorites"}
              title={saveAction ? "Saving..." : save?.saved ? "Favorited" : "Add to favorites"}
            >
              <Heart size={18} fill={save?.saved ? "currentColor" : "none"} />
            </button>
            {!isEbook && isStandalone() && book.files.some((f) => f.status === "available") && (
              <button
                className={`book-detail-icon-action${offline.record?.state === "complete" ? " offline-saved" : ""}`}
                type="button"
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
                title={offline.record?.state === "complete" ? "Saved offline" : offline.busy ? `Downloading ${Math.round(offline.progress * 100)}%` : "Save offline"}
              >
                {offline.record?.state === "complete" ? (
                  <CheckCircle2 size={18} />
                ) : offline.busy ? (
                  <Download size={18} />
                ) : (
                  <Download size={18} />
                )}
              </button>
            )}
            <button
              className="book-detail-icon-action"
              type="button"
              onClick={() => setMetadataModalOpen(true)}
              aria-label="Edit metadata"
              title="Edit metadata"
            >
              <Pencil size={18} />
            </button>
            <a
              className="book-detail-icon-action"
              href={isEbook && primaryReadableDoc ? `${primaryReadableDoc.url}?download` : `/api/library/books/${book.id}/download`}
              download
              aria-label="Download"
              title="Download"
            >
              <Download size={18} />
            </a>
            <button
              className="book-detail-icon-action"
              type="button"
              onClick={() => setAddToCollectionOpen(true)}
              aria-label="Add to collection"
              title="Add to collection"
            >
              <ListMusic size={18} />
            </button>
            <button
              className="book-detail-icon-action"
              type="button"
              onClick={() => setShareModalOpen(true)}
              aria-label="Share"
              title="Share"
            >
              <Share2 size={18} />
            </button>
          </div>
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
            {(!isEbook || primaryReadableDoc?.format === "epub") && (
              <div className="book-progress-actions">
                {!isEbook && (
                  <button
                    className="book-progress-action"
                    type="button"
                    onClick={() => { void markBookFinished(); }}
                    disabled={progressAction !== ""}
                    aria-label={progressAction === "complete" ? "Saving finished status" : "Mark finished"}
                  >
                    <span className="book-progress-action-icon">
                      <CheckCircle2 size={18} />
                    </span>
                    <span>
                      <strong>{progressAction === "complete" ? "Saving..." : bookFinished ? "Marked as finished" : "Mark as finished"}</strong>
                      <small>{bookFinished ? "You reached the end" : "Set progress to the end"}</small>
                    </span>
                  </button>
                )}
                <button
                  className="book-progress-action"
                  type="button"
                  onClick={() => { void resetProgress(); }}
                  disabled={progressAction !== ""}
                  aria-label={progressAction === "reset" ? "Resetting progress" : "Reset progress"}
                >
                  <span className="book-progress-action-icon">
                    <RotateCcw size={18} />
                  </span>
                  <span>
                    <strong>{progressAction === "reset" ? "Resetting..." : "Reset progress"}</strong>
                    <small>{isEbook ? "Start reading from the beginning" : "Start listening from the beginning"}</small>
                  </span>
                </button>
              </div>
            )}
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

      {addToCollectionOpen && (
        <AddToCollectionModal entityId={book.id} title={book.title} onClose={() => setAddToCollectionOpen(false)} />
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
            ? (
              <EpubReader
                bookId={book.id}
                documentId={viewerDoc.id}
                url={viewerDoc.url}
                storageKey={`isputnik:epub-progress:${userId}:${book.id}:${viewerDoc.id}`}
                initialProgress={viewerDoc.id === primaryReadableDoc?.id ? readingProgress : null}
                onProgressChange={(next) => {
                  if (next.documentId === primaryReadableDoc?.id) setReadingProgress(next);
                }}
              />
            )
            : <iframe className="doc-viewer-frame" src={viewerDoc.url} title={viewerDoc.fileName} />}
        </div>,
        document.body
      )}

      {metadataModalOpen && (
        <EditMetadataModal
          book={book}
          onBookUpdated={onBookUpdated}
          onClose={() => setMetadataModalOpen(false)}
        />
      )}

    </div>
  );
}
