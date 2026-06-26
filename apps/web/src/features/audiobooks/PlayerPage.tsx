import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Download, ListMusic, MoreVertical, RotateCcw, SkipForward, StickyNote, X } from "lucide-react";
import { api, isAccessOrMissingApiError } from "../../api";
import { navigate } from "../../router";
import { getDownloadedBookDetail } from "../../offline/downloads";
import { AudioPlayer } from "./AudioPlayer";
import { DEFAULT_COVERS } from "./covers";
import type { AudiobookBookDetail, BookSave } from "./types";
import type { CollectionDetail } from "../collections/types";

interface QueueEntry {
  entityId: string;
  title: string;
}

export function PlayerPage({ id }: { id: string }) {
  // The collection ("playlist") this player is walking through, if any. The book
  // being played is tracked separately so we can advance through the queue
  // without reopening the window.
  const collectionId = useMemo(() => new URLSearchParams(window.location.search).get("collection"), []);

  // The player is reached two ways: a desktop popup window (window.open, so it
  // has an opener) the user closes with the OS chrome, or an in-app full-screen
  // route on mobile/PWA (navigate()) that otherwise has no way out. The dismiss
  // control adapts: close the popup window, else step back through app history.
  const isPopupWindow = useMemo(
    () => typeof window !== "undefined" && (window.opener != null || window.name === "isputnik-player"),
    []
  );
  const dismiss = () => {
    if (isPopupWindow) { window.close(); return; }
    if (window.history.length > 1) window.history.back();
    else navigate("/");
  };

  const [currentId, setCurrentId] = useState(id);
  const [autoPlay, setAutoPlay] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [collectionName, setCollectionName] = useState("");

  const [book, setBook] = useState<AudiobookBookDetail | null>(null);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [marked, setMarked] = useState(false);
  const [save, setSave] = useState<BookSave | null>(null);
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingSave, setSavingSave] = useState(false);
  const [resetting, setResetting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load the queue once: only available, playable audiobook members, in order.
  useEffect(() => {
    if (!collectionId) return;
    api<{ collection: CollectionDetail }>(`/api/collections/${collectionId}`)
      .then(({ collection }) => {
        setCollectionName(collection.name);
        setQueue(
          collection.items
            .filter((item) => item.available && item.playable && item.entityType === "audiobook")
            .map((item) => ({ entityId: item.entityId, title: item.title }))
        );
      })
      .catch(() => {});
  }, [collectionId]);

  // Load the current book (re-runs each time we advance through the queue).
  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setError("");
    setSave(null);
    setNoteEditorOpen(false);
    // Keep the address bar pointed at the book actually playing so a refresh resumes here.
    window.history.replaceState(null, "", `/player/${currentId}${collectionId ? `?collection=${collectionId}` : ""}`);
    const loadBook = async () => {
      try {
        const { book } = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${currentId}`);
        if (cancelled) return;
        setBook(book);
        document.title = `${book.title} - isputnik.home`;
      } catch (err) {
        const fallback = isAccessOrMissingApiError(err) ? null : await getDownloadedBookDetail(currentId);
        if (cancelled) return;
        if (fallback) {
          setBook(fallback);
          document.title = `${fallback.title} - isputnik.home`;
        } else {
          setError(err instanceof Error ? err.message : "Unable to load audiobook");
        }
      }
    };
    void loadBook();
    api<{ save: BookSave }>(`/api/library/books/${currentId}/save`)
      .then(({ save }) => { if (!cancelled) setSave(save); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentId, collectionId]);

  const queueIndex = queue.findIndex((entry) => entry.entityId === currentId);
  const nextEntry = queueIndex >= 0 && queueIndex < queue.length - 1 ? queue[queueIndex + 1] : null;

  const goToBook = (entityId: string) => {
    setAutoPlay(true);
    setCurrentId(entityId);
  };

  const handleEndReached = () => {
    if (nextEntry) goToBook(nextEntry.entityId);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const markFinished = async () => {
    setMarking(true);
    try {
      await api(`/api/library/books/${currentId}/progress/complete`, { method: "POST", body: "{}" });
      setMarked(true);
      setTimeout(() => setMarked(false), 3000);
    } catch {
      // best-effort
    } finally {
      setMarking(false);
      setMenuOpen(false);
    }
  };

  const putSave = async (note: string | null) => {
    const { save: updated } = await api<{ save: BookSave }>(`/api/library/books/${currentId}/save`, {
      method: "PUT",
      body: JSON.stringify({ note })
    });
    setSave(updated);
  };

  const toggleSave = async () => {
    setSavingSave(true);
    try {
      if (save?.saved) {
        await api(`/api/library/books/${currentId}/save`, { method: "DELETE" });
        setSave({ saved: false, note: null });
        setNoteEditorOpen(false);
      } else {
        await putSave(null);
      }
    } catch {
      // best-effort
    } finally {
      setSavingSave(false);
      setMenuOpen(false);
    }
  };

  const openNoteEditor = () => {
    setNoteDraft(save?.note ?? "");
    setNoteEditorOpen(true);
    setMenuOpen(false);
  };

  const submitNote = async () => {
    setSavingSave(true);
    try {
      await putSave(noteDraft.trim() || null);
      setNoteEditorOpen(false);
    } catch {
      // best-effort
    } finally {
      setSavingSave(false);
    }
  };

  const resetProgress = async () => {
    setResetting(true);
    try {
      await api(`/api/library/books/${currentId}/progress`, { method: "DELETE" });
    } catch {
      // best-effort
    } finally {
      setResetting(false);
      setMenuOpen(false);
    }
  };

  if (error) {
    return (
      <div className="popup-player-page">
        <p className="popup-status popup-error">{error}</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="popup-player-page">
        <p className="popup-status">Loading...</p>
      </div>
    );
  }

  return (
    <div className="popup-player-page">
      <div className="popup-topbar">
        <button
          className="popup-menu-btn popup-back-btn"
          onClick={dismiss}
          aria-label={isPopupWindow ? "Close player" : "Back"}
          title={isPopupWindow ? "Close" : "Back"}
        >
          {isPopupWindow ? <X size={22} /> : <ChevronDown size={24} />}
        </button>
        {collectionId && queue.length > 0 && (
          <div className="popup-queue-badge" title={collectionName}>
            <ListMusic size={15} />
            <span>{queueIndex >= 0 ? `${queueIndex + 1} / ${queue.length}` : collectionName}</span>
          </div>
        )}
        <div className="popup-more" ref={menuRef}>
          <button
            className="popup-menu-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-label="More options"
            aria-expanded={menuOpen}
            title="More options"
          >
            <MoreVertical size={22} />
          </button>
          {menuOpen && (
            <div className="popup-more-menu" role="menu" aria-label="Player options">
              <button className="popup-more-item" role="menuitem" onClick={openNoteEditor}>
                <StickyNote size={15} />
                <span>Add note</span>
              </button>
              <button className="popup-more-item" role="menuitem" onClick={markFinished} disabled={marking}>
                <CheckCircle2 size={15} />
                <span>{marking ? "Marking..." : "Mark as finished"}</span>
              </button>
              <a
                className="popup-more-item"
                role="menuitem"
                href={`/api/library/books/${currentId}/download`}
                download
                onClick={() => setMenuOpen(false)}
              >
                <Download size={15} />
                <span>Download</span>
              </a>
              <button className="popup-more-item danger" role="menuitem" onClick={resetProgress} disabled={resetting}>
                <RotateCcw size={15} />
                <span>{resetting ? "Resetting…" : "Reset progress"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="popup-book-header">
        {noteEditorOpen && (
          <div className="popup-note-editor">
            <div className="popup-note-editor-head">
              <span>Note for this book</span>
              <button onClick={() => setNoteEditorOpen(false)} aria-label="Close note editor">
                <X size={15} />
              </button>
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Your thoughts on this book…"
              rows={3}
              autoFocus
            />
            <div className="popup-note-editor-actions">
              <button className="primary-button compact-button" onClick={submitNote} disabled={savingSave}>
                {savingSave ? "Saving..." : "Save note"}
              </button>
            </div>
          </div>
        )}

        {marked && <p className="popup-marked-notice">Marked as finished</p>}
        {save?.saved && !noteEditorOpen && save.note && (
          <p className="popup-save-note">{save.note}</p>
        )}

        <img src={book.coverLargeUrl ?? DEFAULT_COVERS.audiobook} alt="" className="popup-cover" />
        <h1 className="popup-title">{book.title}</h1>
        {book.authors.length > 0 && (
          <p className="popup-authors">
            <span>{book.authors.join(", ")}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </p>
        )}
        {book.narrators.length > 0 && (
          <p className="popup-narrators">Narrated by {book.narrators.join(", ")}</p>
        )}
      </div>
      <div className="popup-player-body">
        <AudioPlayer
          key={currentId}
          book={book}
          showBookmark
          popup
          autoPlay={autoPlay}
          onEndReached={nextEntry ? handleEndReached : undefined}
          saved={save?.saved ?? false}
          onToggleSave={toggleSave}
          savingSave={savingSave}
        />

        {nextEntry && (
          <button className="popup-next-up" onClick={() => goToBook(nextEntry.entityId)}>
            <SkipForward size={15} aria-hidden="true" />
            <span className="popup-next-up-text">
              <small>Up next</small>
              <strong>{nextEntry.title}</strong>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
