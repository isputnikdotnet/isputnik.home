import { useEffect, useRef, useState } from "react";
import { ChevronRight, Download, Headphones, Menu, RotateCcw, X } from "lucide-react";
import { api } from "../../api";
import { AudioPlayer } from "./AudioPlayer";
import type { AudiobookBookDetail, BookSave } from "./types";

export function PlayerPage({ id }: { id: string }) {
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

  useEffect(() => {
    setBook(null);
    setError("");
    setSave(null);
    setNoteEditorOpen(false);
    api<{ book: AudiobookBookDetail }>(`/api/library/books/${id}`)
      .then(({ book }) => {
        setBook(book);
        document.title = `${book.title} — isputnik.home`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load audiobook"));
    api<{ save: BookSave }>(`/api/library/books/${id}/save`)
      .then(({ save }) => setSave(save))
      .catch(() => {});
  }, [id]);

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
      await api(`/api/library/books/${id}/progress/complete`, { method: "POST", body: "{}" });
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
    const { save: updated } = await api<{ save: BookSave }>(`/api/library/books/${id}/save`, {
      method: "PUT",
      body: JSON.stringify({ note })
    });
    setSave(updated);
  };

  const toggleSave = async () => {
    setSavingSave(true);
    try {
      if (save?.saved) {
        await api(`/api/library/books/${id}/save`, { method: "DELETE" });
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
      await api(`/api/library/books/${id}/progress`, { method: "DELETE" });
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
        <img className="popup-logo" src="/Assets/brand/isputnik-brand-icon.svg" alt="isputnik" />
        <div className="popup-more" ref={menuRef}>
          <button
            className="popup-menu-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={menuOpen}
          >
            <Menu size={22} />
          </button>
          {menuOpen && (
            <div className="popup-more-menu">
              <a
                className="popup-more-item"
                href={`/api/library/books/${id}/download`}
                download
                onClick={() => setMenuOpen(false)}
              >
                <Download size={15} />
                <span>Download</span>
              </a>
              <button className="popup-more-item" onClick={resetProgress} disabled={resetting}>
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

        {book.coverLargeUrl ? (
          <img src={book.coverLargeUrl} alt="" className="popup-cover" />
        ) : (
          <div className="popup-cover popup-cover-empty">
            <Headphones size={56} />
          </div>
        )}
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
          book={book}
          showBookmark
          popup
          saved={save?.saved ?? false}
          onToggleSave={toggleSave}
          savingSave={savingSave}
          onAddNote={openNoteEditor}
          onMarkFinished={markFinished}
        />
      </div>
    </div>
  );
}
