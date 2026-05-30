import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Headphones, MoreHorizontal } from "lucide-react";
import { api } from "../../api";
import { AudioPlayer } from "./AudioPlayer";
import type { AudiobookBookDetail } from "./types";

export function PlayerPage({ id }: { id: string }) {
  const [book, setBook] = useState<AudiobookBookDetail | null>(null);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [marked, setMarked] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBook(null);
    setError("");
    api<{ book: AudiobookBookDetail }>(`/api/library/books/${id}`)
      .then(({ book }) => {
        setBook(book);
        document.title = `${book.title} — isputnik.home`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load audiobook"));
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
      <div className="popup-book-header">
        <div className="popup-more" ref={menuRef}>
          <button
            className="popup-more-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="More options"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={20} />
          </button>
          {menuOpen && (
            <div className="popup-more-menu">
              <button
                className="popup-more-item"
                onClick={markFinished}
                disabled={marking}
              >
                <CheckCircle2 size={15} />
                <span>{marking ? "Saving..." : "Mark as Finished"}</span>
              </button>
            </div>
          )}
        </div>

        {marked && <p className="popup-marked-notice">Marked as finished</p>}

        {book.coverLargeUrl ? (
          <img src={book.coverLargeUrl} alt="" className="popup-cover" />
        ) : (
          <div className="popup-cover popup-cover-empty">
            <Headphones size={56} />
          </div>
        )}
        <h1 className="popup-title">{book.title}</h1>
        {book.authors.length > 0 && (
          <p className="popup-authors">{book.authors.join(", ")}</p>
        )}
        {book.narrators.length > 0 && (
          <p className="popup-narrators">Narrated by {book.narrators.join(", ")}</p>
        )}
      </div>
      <div className="popup-player-body">
        <AudioPlayer book={book} showBookmark popup />
      </div>
    </div>
  );
}
