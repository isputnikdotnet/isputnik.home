import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Bookmark, BookOpen, Calendar, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, File as FileIcon, FileText, Globe, HardDrive, Headphones, Heart, Layers, Library, ListMusic, MoreHorizontal, Pencil, Play, RotateCcw, Share2, Trash2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, isAccessOrMissingApiError, type PublicUser } from "../../api";
import { ShareModal } from "../share/ShareModal";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditMetadataModal } from "./EditMetadataModal";
import { EbookReader } from "./reader/EbookReader";
import { DEFAULT_COVERS } from "./covers";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { getDownloadedBookDetail, getDownloadedEpubBlob } from "../../offline/downloads";
import { useDownload } from "../../offline/useDownload";
import { useEbookDownload } from "../../offline/useEbookDownload";
import { isStandalone } from "../../pwa/platform";
import { formatBytes, formatDuration, isFoliateFormat } from "../../shared/utils";
import { ProgressRing } from "../../shared/ProgressRing";
import type { AudiobookBookDetail, AudiobookFile, BookCapabilities, BookSave, PlaybackProgress, ReadingProgress, TrackProgress, WorkEdition, WorkEditions } from "./types";

// Button gating is cosmetic — the server enforces every operation — so when we
// can't determine capabilities we fail OPEN (show the full menu) rather than hide
// actions from legitimate users. Used before the payload loads and as the fallback
// when an online response omits capabilities (e.g. an older server).
const FULL_CAPABILITIES: BookCapabilities = { canEdit: true, canDownload: true, canCurate: true, canShare: true, canDelete: true };

// Offline-downloaded books have no live capability payload. They were downloaded,
// so allow re-download; editing/sharing need the server and stay off.
const OFFLINE_CAPABILITIES: BookCapabilities = { canEdit: false, canDownload: true, canCurate: false, canShare: false, canDelete: false };

// Document formats we can render in the in-app reader overlay: EPUB and FB2 go to
// the foliate reader, PDF to the native <iframe> viewer. Others (mobi, azw3) get
// download-only — no in-browser renderer.
const VIEWABLE_DOC_FORMATS = new Set(["pdf", "epub", "fb2"]);

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
  const [capabilities, setCapabilities] = useState<BookCapabilities>(FULL_CAPABILITIES);
  const [error, setError] = useState("");
  // Bump to re-fetch the detail (e.g. after this book leaves an edition group).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setError("");
    const load = async () => {
      try {
        const payload = await api<{ book: AudiobookBookDetail; capabilities?: BookCapabilities }>(`/api/library/books/${id}`);
        if (!cancelled) {
          setBook(payload.book);
          // Fail open if the server didn't send capabilities (older server / other path).
          setCapabilities(payload.capabilities ?? FULL_CAPABILITIES);
        }
      } catch (err) {
        const fallback = isAccessOrMissingApiError(err) ? null : await getDownloadedBookDetail(id);
        if (cancelled) return;
        if (fallback) {
          setBook(fallback);
          setCapabilities(OFFLINE_CAPABILITIES);
        } else {
          setError(err instanceof Error ? err.message : "Unable to load details");
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  return (
    <DashboardShell active={active} user={user} logout={logout}>
      <section className="work-area book-detail-area">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
          {book ? (
            <BookDetailView
              book={book}
              capabilities={capabilities}
              userId={user.id}
              onBack={() => navigate(backTo)}
              backLabel={active === "ebooks" ? "Back to ebooks" : "Back to audiobooks"}
              onBookUpdated={setBook}
              onReload={() => setReloadKey((n) => n + 1)}
            />
          ) : !error ? (
            <p className="management-empty">Loading…</p>
          ) : null}
        </div>
      </section>
    </DashboardShell>
  );
}

// Episodic titles are usually "<number> <author> - <story>" (e.g. "121 Konan Dojl
// Artur - Skvoz' pelenu"). Pull them apart so a row can show the story as the title
// and the author as a byline; fall back to the raw name when it doesn't match.
function parseEpisodeTitle(raw: string): { title: string; author: string | null; number: string | null } {
  const withAuthor = raw.match(/^(\d+)\s+(.+?)\s+[-–—]\s+(.+)$/);
  if (withAuthor) {
    return { number: withAuthor[1], author: withAuthor[2].trim(), title: withAuthor[3].trim() };
  }
  const numberOnly = raw.match(/^(\d+)[.)\s-]+(.+)$/);
  if (numberOnly) {
    return { number: numberOnly[1], author: null, title: numberOnly[2].trim() };
  }
  const dashOnly = raw.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashOnly) {
    return { number: null, author: dashOnly[1].trim(), title: dashOnly[2].trim() };
  }
  return { number: null, author: null, title: raw };
}

// Editions switcher: when this book is one of several grouped editions of a work,
// list them all, mark the one being viewed, and (for curators) let you set the
// primary or remove an edition. Hidden while loading or once a group dissolves to
// a single book.
function EditionsSwitcher({
  workId,
  currentId,
  canCurate,
  linkFrom,
  onLeftGroup
}: {
  workId: string;
  currentId: string;
  canCurate: boolean;
  linkFrom: string;
  onLeftGroup: () => void;
}) {
  const [editions, setEditions] = useState<WorkEdition[] | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<WorkEdition | null>(null);

  const load = useCallback(() => {
    api<{ work: WorkEditions }>(`/api/library/works/${workId}`)
      .then((payload) => setEditions(payload.work.editions))
      .catch(() => setEditions([]));
  }, [workId]);
  useEffect(() => { load(); }, [load]);

  if (!editions || editions.length < 2) return null;

  const routeFor = (edition: WorkEdition) =>
    `${edition.type === "ebook" ? "/ebooks" : "/audiobooks"}/books/${edition.id}${linkFrom}`;

  const makePrimary = async (edition: WorkEdition) => {
    setBusyId(edition.id);
    setError("");
    try {
      await api(`/api/library/works/${workId}`, { method: "PATCH", body: JSON.stringify({ primaryItemId: edition.id }) });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to set the primary edition");
    } finally {
      setBusyId("");
    }
  };

  const removeEdition = async (edition: WorkEdition) => {
    setBusyId(edition.id);
    setError("");
    try {
      const result = await api<{ dissolved: boolean }>(
        `/api/library/works/${workId}/items/${edition.id}`,
        { method: "DELETE" }
      );
      setConfirmRemove(null);
      // If THIS book left the group, or the group dissolved, the page's workId is
      // stale — reload the detail. Otherwise just refresh the edition list.
      if (result.dissolved || edition.id === currentId) onLeftGroup();
      else load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the edition");
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="book-detail-editions" aria-label="Editions">
      <h2 className="book-detail-editions-title">
        <Layers size={16} aria-hidden="true" /> Editions <span className="muted">({editions.length})</span>
      </h2>
      <div className="editions-switch-list">
        {editions.map((edition) => {
          const current = edition.id === currentId;
          const pct = edition.progress.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, edition.progress.percentComplete ?? 0)) * 100);
          const status = edition.progress.completedAt ? "Finished" : pct > 0 ? `${pct}%` : "Not started";
          const medium = edition.type === "ebook" ? (edition.format ? edition.format.toUpperCase() : "Ebook") : "Audiobook";
          const meta = [medium, edition.publisher, edition.yearPublished ? String(edition.yearPublished) : null].filter(Boolean).join(" · ");
          const cover = edition.coverUrl ?? (edition.type === "ebook" ? DEFAULT_COVERS.ebook : DEFAULT_COVERS.audiobook);
          const inner = (
            <>
              <img src={cover} alt="" />
              <span className="editions-switch-text">
                <strong>{edition.title ?? "Untitled"}</strong>
                <small>{meta} · {status}</small>
              </span>
            </>
          );
          return (
            <div className={`editions-switch-row${current ? " current" : ""}`} key={edition.id}>
              {current ? (
                <div className="editions-switch-main" aria-current="true">{inner}</div>
              ) : (
                <a className="editions-switch-main" href={routeFor(edition)} onClick={(event) => followRoute(event, routeFor(edition))}>{inner}</a>
              )}
              <div className="editions-switch-side">
                {edition.isPrimary && <span className="editions-switch-flag">Primary</span>}
                {current && <span className="editions-switch-here">Viewing</span>}
                {canCurate && !edition.isPrimary && (
                  <button type="button" className="secondary-button compact-button" disabled={busyId !== ""} onClick={() => void makePrimary(edition)}>
                    Make primary
                  </button>
                )}
                {canCurate && (
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busyId !== ""}
                    onClick={() => setConfirmRemove(edition)}
                    aria-label={`Remove ${edition.title ?? "edition"} from the group`}
                    title="Remove from group"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && <MessageBox tone="error" title="Editions error">{error}</MessageBox>}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove "${confirmRemove.title ?? "this edition"}" from the group?`}
          confirmLabel="Remove from group"
          danger
          busy={busyId === confirmRemove.id}
          onConfirm={() => void removeEdition(confirmRemove)}
          onCancel={() => { if (busyId === "") setConfirmRemove(null); }}
        >
          The book stays in your library — it just stops being grouped as an edition of this title.
          {editions.length === 2 ? " As only two editions remain, this ungroups them entirely." : ""}
        </ConfirmDialog>
      )}
    </section>
  );
}

function BookDetailView({
  book,
  capabilities,
  userId,
  onBack,
  backLabel,
  onBookUpdated,
  onReload
}: {
  book: AudiobookBookDetail;
  capabilities: BookCapabilities;
  userId: string;
  onBack: () => void;
  backLabel: string;
  onBookUpdated: (book: AudiobookBookDetail) => void;
  onReload: () => void;
}) {
  const [progress, setProgress] = useState<PlaybackProgress | null>(null);
  const [trackProgress, setTrackProgress] = useState<Record<string, TrackProgress>>({});
  const [activeBookTab, setActiveBookTab] = useState<"description" | "chapters" | "files">("description");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [save, setSave] = useState<BookSave | null>(null);
  const [saveAction, setSaveAction] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [confirmRemoveDownload, setConfirmRemoveDownload] = useState(false);
  const [confirmRemoveEbookDownload, setConfirmRemoveEbookDownload] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [addToCollectionOpen, setAddToCollectionOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<{ id: string; fileName: string; url: string; format: string; blobUrl?: string } | null>(null);
  const [readingProgress, setReadingProgress] = useState<ReadingProgress | null>(null);
  const [progressMenuOpen, setProgressMenuOpen] = useState(false);
  const progressMenuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const offline = useDownload(book);

  // Revoke any blob URL created for offline reading when the viewer closes.
  useEffect(() => {
    const doc = viewerDoc;
    return () => { if (doc?.blobUrl) URL.revokeObjectURL(doc.blobUrl); };
  }, [viewerDoc]);

  // Move this item to the Recycle Bin, then return to the list (where it's now gone).
  // Recoverable from Control Panel → Recycle Bin until it's purged. Shared by both types.
  const moveToRecycleBin = async () => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${book.id}`, { method: "DELETE" });
      onBack();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move to the Recycle Bin");
      setDeleteBusy(false);
    }
  };

  // Close the full-screen reader on Escape.
  useEffect(() => {
    if (!viewerDoc) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setViewerDoc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerDoc]);

  useEffect(() => {
    if (!progressMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!progressMenuRef.current?.contains(event.target as Node)) {
        setProgressMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProgressMenuOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [progressMenuOpen]);

  // An ebook (or any audio-less book): content is a document, not audio tracks.
  const isEbook = book.files.length === 0 && book.documents.length > 0;
  const episodic = book.progressMode === "episodic";
  const markTrack = async (fileId: string, played: boolean) => {
    try {
      await api(`/api/library/books/${book.id}/tracks/${fileId}/progress`, {
        method: "PUT",
        body: JSON.stringify({ played })
      });
      setTrackProgress((prev) => {
        const next = { ...prev };
        if (played) next[fileId] = { fileId, positionSeconds: 0, completedAt: new Date().toISOString() };
        else delete next[fileId];
        return next;
      });
    } catch {
      // best-effort; the next focus refresh reconciles with the server
    }
  };

  const availableFiles = book.files.filter((file) => file.status === "available");
  const playedCount = availableFiles.filter((file) => trackProgress[file.id]?.completedAt != null).length;
  const allPlayed = availableFiles.length > 0 && playedCount === availableFiles.length;
  // Resume an in-progress episode first, else the first with no completion, else
  // (everything played) the very first — so the button always has a target.
  const nextEpisode =
    availableFiles.find((file) => {
      const tp = trackProgress[file.id];
      return tp != null && tp.completedAt == null && tp.positionSeconds > 0;
    })
    ?? availableFiles.find((file) => trackProgress[file.id]?.completedAt == null)
    ?? availableFiles[0]
    ?? null;

  // Point the resume cursor at a file, then open the player (which resumes from that
  // cursor). The popup is opened synchronously and redirected after the write so a
  // popup blocker can't swallow it.
  // Point the resume cursor at a file + position, then open the player there. Used
  // for whole files (episodes) and for jumping into a specific m4b chapter offset.
  const playFrom = (fileId: string, positionSeconds: number) => {
    const resumePos = Math.max(0, Math.floor(positionSeconds));
    const win = window.open("", "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
    const openPlayer = () => { if (win) win.location.href = `/player/${book.id}`; };
    api(`/api/library/books/${book.id}/progress`, {
      method: "PATCH",
      body: JSON.stringify({ fileId, positionSeconds: resumePos })
    })
      .then(() => {
        setProgress((prev) => ({
          fileId,
          positionSeconds: resumePos,
          percentComplete: prev?.percentComplete ?? null,
          completedAt: prev?.completedAt ?? null
        }));
        openPlayer();
      })
      .catch(openPlayer);
  };

  const playEpisode = (file: AudiobookFile) => {
    playFrom(file.id, trackProgress[file.id]?.positionSeconds ?? 0);
  };

  const playNextEpisode = () => {
    if (nextEpisode) playEpisode(nextEpisode);
  };
  const primaryReadableDoc = book.documents.find((doc) => VIEWABLE_DOC_FORMATS.has(doc.format)) ?? book.documents[0] ?? null;
  const canReadPrimaryDoc = Boolean(primaryReadableDoc && VIEWABLE_DOC_FORMATS.has(primaryReadableDoc.format));
  const primaryReaderStorageKey = primaryReadableDoc
    ? `isputnik:epub-progress:${userId}:${book.id}:${primaryReadableDoc.id}`
    : "";
  const ebookMeta = isEbook && isFoliateFormat(primaryReadableDoc?.format) ? {
    bookId: book.id,
    documentId: primaryReadableDoc.id,
    documentUrl: primaryReadableDoc.url,
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverLargeUrl ?? book.coverUrl,
    totalBytes: primaryReadableDoc.size,
    format: primaryReadableDoc.format
  } : null;
  const ebookOffline = useEbookDownload(ebookMeta);
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
    if (!primaryReadableDoc || !isFoliateFormat(primaryReadableDoc.format)) {
      return () => { cancelled = true; };
    }

    api<{ progress: ReadingProgress | null }>(
      `/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(primaryReadableDoc.id)}`
    )
      .then((payload) => { if (!cancelled) setReadingProgress(payload.progress); })
      .catch(() => { if (!cancelled) setReadingProgress(null); });

    return () => { cancelled = true; };
  }, [book.id, primaryReadableDoc?.id, primaryReadableDoc?.format]);

  // Deep-link from a bookmark's Read button: open straight into the reader on the
  // primary document, then drop the ?read flag so a refresh doesn't reopen it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("read")) return;
    if (primaryReadableDoc && VIEWABLE_DOC_FORMATS.has(primaryReadableDoc.format)) {
      setViewerDoc({ id: primaryReadableDoc.id, fileName: primaryReadableDoc.fileName, url: primaryReadableDoc.url, format: primaryReadableDoc.format });
    }
    url.searchParams.delete("read");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [primaryReadableDoc?.id]);

  useEffect(() => {
    const loadProgress = () => api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`)
      .then((payload) => setProgress(payload.progress))
      .catch(() => setProgress(null));
    const loadTracks = () => {
      if (book.progressMode !== "episodic") return;
      api<{ tracks: TrackProgress[] }>(`/api/library/books/${book.id}/tracks/progress`)
        .then((payload) => setTrackProgress(Object.fromEntries(payload.tracks.map((track) => [track.fileId, track]))))
        .catch(() => setTrackProgress({}));
    };
    loadProgress();
    loadTracks();
    // The player opens in a separate window, so refresh when this page regains
    // focus — returning after listening then reflects the latest position.
    const onFocus = () => { loadProgress(); loadTracks(); };
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
  const audioFinished = episodic ? allPlayed : progress?.completedAt != null;
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
      if (isEbook && primaryReadableDoc) {
        await api(`/api/library/books/${book.id}/reading-progress/complete`, { method: "POST", body: JSON.stringify({ documentId: primaryReadableDoc.id }) });
        const now = new Date().toISOString();
        setReadingProgress((prev) => ({
          documentId: primaryReadableDoc.id,
          cfi: prev?.cfi ?? "",
          percentComplete: 1,
          label: prev?.label ?? null,
          updatedAt: now,
          completedAt: now
        }));
        return;
      }
      await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
      const lastFile = book.files.filter((file) => file.status === "available").at(-1) ?? book.files.at(-1);
      setProgress({
        fileId: lastFile?.id ?? null,
        positionSeconds: lastFile?.durationSeconds ?? book.durationSeconds ?? 0,
        percentComplete: 1,
        completedAt: new Date().toISOString()
      });
      if (episodic) {
        const completedAt = new Date().toISOString();
        setTrackProgress(Object.fromEntries(
          availableFiles.map((f) => [f.id, { fileId: f.id, positionSeconds: f.durationSeconds ?? 0, completedAt }])
        ));
      }
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
      if (isEbook && isFoliateFormat(primaryReadableDoc?.format)) {
        await api(`/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(primaryReadableDoc.id)}`, { method: "DELETE" });
        try { localStorage.removeItem(primaryReaderStorageKey); } catch { /* ignore */ }
        setReadingProgress(null);
      } else {
        await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
        setProgress(null);
        setTrackProgress({});
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
  const documentFormat = [...new Set(book.documents.map((doc) => doc.format.toUpperCase()))].join(", ");
  const formatValue = isEbook ? documentFormat : audioFormat || "Audio";
  const progressPercent = isEbook
    ? readingProgress?.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, readingProgress?.percentComplete ?? 0)) * 100)
    : progress?.completedAt ? 100 : Math.round(Math.max(0, Math.min(1, progress?.percentComplete ?? 0)) * 100);
  // "Started" covers any saved progress — even when the percentage is unknown
  // (a book whose total duration wasn't recorded) or rounds down to 0%.
  const hasStarted = isEbook
    ? !bookFinished && readingProgress != null && ((readingProgress.percentComplete ?? 0) > 0 || Boolean(readingProgress.cfi))
    : episodic
      ? !bookFinished && (Object.keys(trackProgress).length > 0 || progress != null)
      : !bookFinished && progress != null && ((progress.percentComplete ?? 0) > 0 || (progress.positionSeconds ?? 0) > 0 || progress.fileId != null);
  const remainingSeconds = !isEbook && book.durationSeconds != null ? Math.max(0, Math.round(book.durationSeconds * (1 - progressPercent / 100))) : null;
  const progressTitle = isEbook ? "Reading Progress" : "Listening Progress";
  const progressActionLabel = isEbook
    ? (hasStarted ? "Continue Reading" : "Read")
    : bookFinished ? "Listen Again" : hasStarted ? "Continue Listening" : "Start Listening";
  const progressStatus = bookFinished
    ? "Completed"
    : hasStarted ? "In progress" : "Not started";
  const remainingLabel = remainingSeconds != null && !progress?.completedAt
    ? `${formatDuration(remainingSeconds)} remaining`
    : null;

  // Authors, series, and the book route differ per media type; link within the
  // current type so an ebook's author/series goes to /ebooks/..., not /audiobooks.
  // Narrators are audiobook-only and never render for ebooks, so they keep their
  // /audiobooks links.
  const mediaBase = isEbook ? "/ebooks" : "/audiobooks";
  // Referrer so detail pages reached from here can offer "Back" to this book.
  const linkFrom = `?from=${encodeURIComponent(`${mediaBase}/books/${book.id}`)}`;
  type DetailLink = { text: string; href: string };
  type DetailRow = { label: string; value: string; icon: LucideIcon; className?: string; links?: DetailLink[] };
  const heroDetailRows = ([
    book.narrators.length > 0 ? {
      label: "Narrator",
      value: book.narrators.join(", "),
      icon: Headphones,
      links: book.narrators.map((name) => ({ text: name, href: `/people/${encodeURIComponent(name)}${linkFrom}` }))
    } : null,
    { label: "Library", value: book.libraryName, icon: Library },
    formatValue ? { label: "Format", value: formatValue, icon: FileIcon } : null,
    book.category ? {
      label: "Category",
      value: book.category.name,
      icon: Bookmark,
      links: [{ text: book.category.name, href: `/categories/${book.category.key}${linkFrom}` }]
    } : null,
    book.durationSeconds != null ? { label: isEbook ? "Length" : "Audio Length", value: formatDuration(book.durationSeconds), icon: Clock } : null,
    book.totalSize > 0 ? { label: "File Size", value: formatBytes(book.totalSize), icon: HardDrive } : null,
    book.series ? {
      label: "Series",
      value: `${book.series}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ""}`,
      icon: BookOpen,
      links: book.seriesId ? [{ text: `${book.series}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ""}`, href: `${mediaBase}/series/${book.seriesId}${linkFrom}` }] : undefined
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
  // Embedded chapters (m4b/m4a) flattened across files for the Chapters tab. MP3
  // books carry none, so the tab is hidden for them. End falls back to the next
  // chapter's start, then the file's duration.
  const bookChapters = book.files.flatMap((file) => {
    const list = file.chapters ?? [];
    return list.map((chapter, index) => {
      const end = chapter.endSeconds ?? list[index + 1]?.startSeconds ?? file.durationSeconds ?? chapter.startSeconds;
      return {
        id: chapter.id,
        fileId: file.id,
        title: chapter.title,
        startSeconds: chapter.startSeconds,
        durationSeconds: Math.max(0, end - chapter.startSeconds)
      };
    });
  });
  const hasChapters = bookChapters.length > 0;

  // Read-only progress for a chapter, derived from the playback cursor. Embedded
  // chapters live in a single file, so the cursor's file matches in practice.
  const chapterRing = (chapter: { fileId: string; startSeconds: number; durationSeconds: number }) => {
    if (progress?.fileId !== chapter.fileId || chapter.durationSeconds <= 0) {
      return { progress: 0, complete: false };
    }
    const pos = progress.positionSeconds ?? 0;
    const end = chapter.startSeconds + chapter.durationSeconds;
    if (pos >= end - 0.5) return { progress: 1, complete: true };
    if (pos > chapter.startSeconds) return { progress: Math.min((pos - chapter.startSeconds) / chapter.durationSeconds, 1), complete: false };
    return { progress: 0, complete: false };
  };

  const detailTabs: { id: "description" | "chapters" | "files"; label: string }[] = [
    { id: "description", label: "Description" },
    ...(hasChapters ? [{ id: "chapters" as const, label: "Chapters" }] : []),
    { id: "files", label: "Files" }
  ];
  const descriptionText = book.description?.trim() ?? "";
  const canExpandDescription = descriptionText.length > 420;
  const visibleDescription = canExpandDescription && !descriptionExpanded
    ? `${descriptionText.slice(0, 420).trimEnd()}...`
    : descriptionText;
  const openPrimaryReader = () => {
    const doc = primaryReadableDoc;
    if (!doc || !VIEWABLE_DOC_FORMATS.has(doc.format)) return;
    if (isFoliateFormat(doc.format) && ebookOffline.record?.state === "complete") {
      void getDownloadedEpubBlob(book.id, doc.id).then((blob) => {
        const blobUrl = blob ? URL.createObjectURL(blob) : undefined;
        setViewerDoc({ id: doc.id, fileName: doc.fileName, url: blobUrl ?? doc.url, format: doc.format, blobUrl });
      });
    } else {
      setViewerDoc({ id: doc.id, fileName: doc.fileName, url: doc.url, format: doc.format });
    }
  };

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
            <img src={book.coverLargeUrl ?? book.coverUrl ?? (isEbook ? DEFAULT_COVERS.ebook : DEFAULT_COVERS.audiobook)} alt="" />
          </div>
          {(book.category || book.tags.length > 0) && (
            <section className="book-tags book-tags-under-cover" aria-label="Tags">
              {book.category && (
                <button
                  className="book-tag-chip book-tag-chip-category"
                  type="button"
                  onClick={() => navigate(`/categories/${book.category?.key}${linkFrom}`)}
                >
                  {book.category.name}
                </button>
              )}
              {book.tags.map((tag) => (
                <button
                  className="book-tag-chip book-tag-chip-tag"
                  key={tag}
                  type="button"
                  onClick={() => navigate(`/tags/${encodeURIComponent(tag)}${linkFrom}`)}
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
                const href = `/people/${encodeURIComponent(name)}${linkFrom}`;
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
            <div className="book-detail-secondary-actions" aria-label="Book actions">
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
              {!isEbook && isStandalone() && capabilities.canDownload && book.files.some((f) => f.status === "available") && (
                <button
                  className={`book-detail-icon-action${offline.record?.state === "complete" ? " offline-saved" : ""}`}
                  type="button"
                  onClick={() => {
                    if (offline.busy) return;
                    if (offline.record?.state === "complete") {
                      setConfirmRemoveDownload(true);
                    } else {
                      void offline.start();
                    }
                  }}
                  disabled={offline.busy}
                  aria-label={offline.record?.state === "complete" ? "Remove offline download" : "Save for offline listening"}
                  title={offline.record?.state === "complete" ? "Saved offline" : offline.busy ? `Downloading ${Math.round(offline.progress * 100)}%` : "Save offline"}
                >
                  {offline.record?.state === "complete" ? <CheckCircle2 size={18} /> : <Download size={18} />}
                </button>
              )}
              {isEbook && isStandalone() && capabilities.canDownload && isFoliateFormat(primaryReadableDoc?.format) && (
                <button
                  className={`book-detail-icon-action${ebookOffline.record?.state === "complete" ? " offline-saved" : ""}`}
                  type="button"
                  onClick={() => {
                    if (ebookOffline.busy) return;
                    if (ebookOffline.record?.state === "complete") {
                      setConfirmRemoveEbookDownload(true);
                    } else {
                      void ebookOffline.start();
                    }
                  }}
                  disabled={ebookOffline.busy}
                  aria-label={ebookOffline.record?.state === "complete" ? "Remove offline download" : "Save for offline reading"}
                  title={ebookOffline.record?.state === "complete" ? "Saved offline" : ebookOffline.busy ? `Downloading ${Math.round(ebookOffline.progress * 100)}%` : "Save offline"}
                >
                  {ebookOffline.record?.state === "complete" ? <CheckCircle2 size={18} /> : <Download size={18} />}
                </button>
              )}
              {capabilities.canEdit && (
                <button
                  className="book-detail-icon-action"
                  type="button"
                  onClick={() => setMetadataModalOpen(true)}
                  aria-label="Edit metadata"
                  title="Edit metadata"
                >
                  <Pencil size={18} />
                </button>
              )}
              {capabilities.canDownload && (
                <a
                  className="book-detail-icon-action"
                  href={isEbook && primaryReadableDoc ? `${primaryReadableDoc.url}?download` : `/api/library/books/${book.id}/download`}
                  download
                  aria-label="Download"
                  title="Download"
                >
                  <Download size={18} />
                </a>
              )}
              <button
                className="book-detail-icon-action"
                type="button"
                onClick={() => setAddToCollectionOpen(true)}
                aria-label="Add to collection"
                title="Add to collection"
              >
                <ListMusic size={18} />
              </button>
              {capabilities.canShare && (
                <button
                  className="book-detail-icon-action"
                  type="button"
                  onClick={() => setShareModalOpen(true)}
                  aria-label="Share"
                  title="Share"
                >
                  <Share2 size={18} />
                </button>
              )}
              {capabilities.canDelete && (
                <button
                  className="book-detail-icon-action danger"
                  type="button"
                  onClick={() => { setDeleteError(""); setConfirmDelete(true); }}
                  aria-label="Move to Recycle Bin"
                  title="Move to Recycle Bin"
                >
                  <Trash2 size={18} />
                </button>
              )}
            </div>
            <div className="book-detail-primary-actions">
              {isEbook ? (
                <button
                  className="primary-button"
                  onClick={openPrimaryReader}
                  disabled={!canReadPrimaryDoc}
                >
                  <BookOpen size={16} />
                  <span>{progressActionLabel}</span>
                </button>
              ) : (
                <>
                  <button
                    className="primary-button"
                    onClick={() => window.open(`/player/${book.id}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes")}
                  >
                    <Play size={16} />
                    <span>{progressActionLabel}</span>
                  </button>
                  {canReadPrimaryDoc && (
                    <button
                      className="secondary-button book-detail-read-button"
                      type="button"
                      onClick={openPrimaryReader}
                    >
                      <BookOpen size={16} />
                      <span>Read</span>
                    </button>
                  )}
                </>
              )}
              {(!isEbook || isFoliateFormat(primaryReadableDoc?.format)) && (
                <div className="book-progress-menu-wrap" ref={progressMenuRef}>
                  <button
                    className="book-progress-menu-trigger"
                    type="button"
                    onClick={() => setProgressMenuOpen((open) => !open)}
                    aria-haspopup="menu"
                    aria-expanded={progressMenuOpen}
                    aria-label="Progress actions"
                    title="Progress actions"
                  >
                    <MoreHorizontal size={20} aria-hidden="true" />
                  </button>
                  {progressMenuOpen && (
                    <div className="book-detail-action-menu book-progress-menu" role="menu" aria-label="Progress actions">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProgressMenuOpen(false);
                          void markBookFinished();
                        }}
                        disabled={progressAction !== ""}
                      >
                        <CheckCircle2 size={16} aria-hidden="true" />
                        <span>{progressAction === "complete" ? "Saving..." : bookFinished ? "Marked finished" : "Mark finished"}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProgressMenuOpen(false);
                          void resetProgress();
                        }}
                        disabled={progressAction !== ""}
                      >
                        <RotateCcw size={16} aria-hidden="true" />
                        <span>{progressAction === "reset" ? "Resetting..." : "Reset progress"}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="book-progress-inline" aria-label={progressTitle}>
              <Clock size={16} aria-hidden="true" />
              {episodic ? (
                <span><strong>{playedCount} / {availableFiles.length}</strong> played</span>
              ) : (
                <span>Progress: <strong>{progressPercent}%</strong></span>
              )}
              <span aria-hidden="true">•</span>
              <span>{progressStatus}</span>
              {episodic
                ? !allPlayed && availableFiles.length - playedCount > 0 && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span>{availableFiles.length - playedCount} {availableFiles.length - playedCount === 1 ? "episode" : "episodes"} left</span>
                    </>
                  )
                : remainingLabel && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span>{remainingLabel}</span>
                    </>
                  )}
            </div>
          </div>
          {saveError && <MessageBox tone="error" title="Favorites error">{saveError}</MessageBox>}
          {progressActionError && <MessageBox tone="error" title="Progress error">{progressActionError}</MessageBox>}
          {offline.error && <MessageBox tone="error" title="Download error">{offline.error}</MessageBox>}
        </div>
      </div>

      {book.workId && (
        <EditionsSwitcher
          workId={book.workId}
          currentId={book.id}
          canCurate={capabilities.canCurate}
          linkFrom={linkFrom}
          onLeftGroup={onReload}
        />
      )}

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

          {activeBookTab === "chapters" && (
            <section className="book-detail-files-tab">
              <section className="book-files-section">
                <div className="book-file-list">
                  {bookChapters.map((chapter, index) => {
                    const ring = chapterRing(chapter);
                    return (
                      <article className="book-file-row" key={chapter.id}>
                        <span className="book-file-num">{index + 1}</span>
                        <button
                          type="button"
                          className="book-file-play"
                          onClick={() => playFrom(chapter.fileId, chapter.startSeconds)}
                          aria-label="Play from this chapter"
                          title="Play from this chapter"
                        >
                          <Play size={15} />
                        </button>
                        <div>
                          <strong>{chapter.title}</strong>
                        </div>
                        <small>{chapter.durationSeconds > 0 ? formatDuration(chapter.durationSeconds) : ""}</small>
                        <ProgressRing progress={ring.progress} complete={ring.complete} />
                      </article>
                    );
                  })}
                </div>
              </section>
            </section>
          )}

          {activeBookTab === "files" && (
            <section className="book-detail-files-tab">
              {book.documents.length > 0 && (
                <section className="book-documents-section">
                  <h2 className="book-documents-title">{isEbook ? "Formats" : "Documents"}</h2>
                  <div className="book-document-list">
                    {book.documents.map((doc) => (
                      <div className="book-document-row" key={doc.id}>
                        <FileText size={18} aria-hidden="true" />
                        <div className="book-document-info">
                          <strong>{doc.format.toUpperCase()}</strong>
                          <small>{doc.fileName} · {formatBytes(doc.size)}</small>
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
                  {episodic && (
                    <div className="book-episode-head">
                      <span className="muted">{playedCount} / {availableFiles.length} played</span>
                      {nextEpisode && (
                        <button type="button" className="book-episode-play-next" onClick={playNextEpisode}>
                          <Play size={14} aria-hidden="true" />
                          {allPlayed ? "Play from start" : "Play next unplayed"}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="book-file-list">
                    {book.files.map((file, index) => {
                      const tp = trackProgress[file.id];
                      const played = tp?.completedAt != null;
                      const isCurrent = progress?.fileId === file.id;
                      const listened = isCurrent ? (progress?.positionSeconds ?? 0) : (tp?.positionSeconds ?? 0);
                      const dur = file.durationSeconds ?? 0;
                      const pct = dur > 0 ? Math.min(listened / dur, 1) : 0;
                      const inProgress = episodic && !played && (isCurrent || listened > 0);
                      const state = fileState(index);
                      const rawTitle = file.chapterTitle || file.relativePath.split(/[\\/]/).at(-1) || file.relativePath;
                      const ep = episodic ? parseEpisodeTitle(rawTitle) : null;
                      // In-progress rows show the resume time in the byline (the ring carries the
                      // visual progress); other rows show the episode number.
                      const detail = inProgress
                        ? `${formatDuration(Math.floor(listened))}${dur > 0 ? ` / ${formatDuration(dur)}` : ""}`
                        : ep?.number ? `#${ep.number}` : "";
                      const bylineEl = (ep?.author || detail) ? (
                        <small className="book-file-byline">
                          {ep?.author}{ep?.author && detail ? " · " : ""}
                          {detail ? (inProgress ? detail : <span className="book-file-epnum">{detail}</span>) : null}
                        </small>
                      ) : null;
                      // Linear chapters drive their ring + subtitle from the book-level cursor
                      // (fileState); the ring there is read-only.
                      const linearPos = state === "in_progress" ? (progress?.positionSeconds ?? 0) : 0;
                      const linearProgress = state === "completed" ? 1 : (state === "in_progress" && dur > 0 ? Math.min(linearPos / dur, 1) : 0);
                      const subtitleEl = episodic
                        ? bylineEl
                        : state === "in_progress" && dur > 0
                          ? <small className="book-file-byline">{formatDuration(Math.floor(linearPos))} / {formatDuration(dur)}</small>
                          : null;
                      return (
                        <article className={`book-file-row${isCurrent ? " current" : ""}`} key={file.id}>
                          <span className="book-file-num">{file.trackNumber ?? index + 1}</span>
                          <button
                            type="button"
                            className="book-file-play"
                            onClick={() => playEpisode(file)}
                            aria-label="Play"
                            title="Play"
                          >
                            <Play size={15} />
                          </button>
                          <div>
                            <strong>{ep ? ep.title : rawTitle}</strong>
                            {subtitleEl}
                          </div>
                          <small>
                            {file.durationSeconds != null ? `${formatDuration(file.durationSeconds)} · ` : ""}
                            {formatBytes(file.size)}
                          </small>
                          {episodic ? (
                            <ProgressRing
                              progress={pct}
                              complete={played}
                              onClick={() => markTrack(file.id, !played)}
                              label={played ? "Mark unplayed" : "Mark played"}
                            />
                          ) : (
                            <ProgressRing progress={linearProgress} complete={state === "completed"} />
                          )}
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
        <ShareModal bookId={book.id} bookTitle={book.title} isEbook={isEbook} onClose={() => setShareModalOpen(false)} />
      )}

      {addToCollectionOpen && (
        <AddToCollectionModal entityType={isEbook ? "ebook" : "audiobook"} entityId={book.id} title={book.title} onClose={() => setAddToCollectionOpen(false)} />
      )}

      {viewerDoc && createPortal(
        isFoliateFormat(viewerDoc.format) ? (
          <EbookReader
            bookId={book.id}
            documentId={viewerDoc.id}
            format={viewerDoc.format}
            url={viewerDoc.url}
            storageKey={`isputnik:epub-progress:${userId}:${book.id}:${viewerDoc.id}`}
            initialProgress={viewerDoc.id === primaryReadableDoc?.id ? readingProgress : null}
            onProgressChange={(next) => {
              if (next.documentId === primaryReadableDoc?.id) setReadingProgress(next);
            }}
            title={book.title}
            author={book.authors.join(", ")}
            coverUrl={book.coverUrl}
            downloadUrl={`${viewerDoc.url}?download`}
            onExit={() => setViewerDoc(null)}
          />
        ) : (
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
            <iframe className="doc-viewer-frame" src={viewerDoc.url} title={viewerDoc.fileName} />
          </div>
        ),
        document.body
      )}

      {metadataModalOpen && (
        <EditMetadataModal
          book={book}
          onBookUpdated={onBookUpdated}
          onClose={() => setMetadataModalOpen(false)}
        />
      )}

      {confirmRemoveDownload && (
        <ConfirmDialog
          title="Remove download?"
          confirmLabel="Remove download"
          danger
          onConfirm={() => { setConfirmRemoveDownload(false); void offline.remove(); }}
          onCancel={() => setConfirmRemoveDownload(false)}
        >
          This downloaded book is removed from this device. You can download it again at any time.
        </ConfirmDialog>
      )}

      {confirmRemoveEbookDownload && (
        <ConfirmDialog
          title="Remove download?"
          confirmLabel="Remove download"
          danger
          onConfirm={() => { setConfirmRemoveEbookDownload(false); void ebookOffline.remove(); }}
          onCancel={() => setConfirmRemoveEbookDownload(false)}
        >
          This ebook is removed from this device. You can download it again at any time.
        </ConfirmDialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Move "${book.title}" to the Recycle Bin?`}
          confirmLabel="Move to Recycle Bin"
          busyLabel="Moving…"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void moveToRecycleBin()}
          onCancel={() => { if (!deleteBusy) setConfirmDelete(false); }}
        >
          {isEbook
            ? "This ebook moves into the Recycle Bin and leaves the library for everyone. An administrator can restore it from Control Panel → Recycle Bin."
            : "This audiobook moves into the Recycle Bin and leaves the library for everyone (any shares stop working). An administrator can restore it from Control Panel → Recycle Bin."}
        </ConfirmDialog>
      )}

    </div>
  );
}
