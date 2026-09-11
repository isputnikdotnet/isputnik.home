import { useEffect, useState } from "react";
import { api } from "../../../api";
import type { AudiobookBook } from "../types";

export type BookStatus = "finished" | "in_progress" | "none";

export function bookStatus(book: AudiobookBook): BookStatus {
  if (book.progress?.completedAt != null) return "finished";
  if ((book.progress?.percentComplete ?? 0) > 0) return "in_progress";
  return "none";
}

// Which progress a tile's "mark finished" writes: an audiobook's listening
// progress, or an ebook document's reading progress (which needs the document).
export type FinishTrack = "listening" | "reading";

// The like and finished toggles every catalog tile carries (desktop card and
// mobile row alike). Both are optimistic — flipped at once, put back if the
// server refuses — and re-seed from the book whenever the catalog refreshes it.
export function useBookLike(
  book: AudiobookBook & { documentId?: string | null },
  track: FinishTrack = "listening"
) {
  const [liked, setLiked] = useState(book.saved);
  const [likeBusy, setLikeBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => bookStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);

  // Re-seed from the server shape when the catalog refreshes. The reading tile
  // has always re-seeded on any new progress object; the listening one only when
  // the values change.
  const progressKey = track === "reading"
    ? book.progress
    : `${book.progress?.completedAt ?? ""}|${book.progress?.percentComplete ?? ""}`;
  useEffect(() => { setLiked(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(bookStatus(book)); }, [progressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLike = async () => {
    if (likeBusy) return;
    const next = !liked;
    setLiked(next);
    setLikeBusy(true);
    try {
      if (next) await api(`/api/library/books/${book.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
    } catch {
      setLiked(!next);
    } finally {
      setLikeBusy(false);
    }
  };

  const toggleFinished = async () => {
    if (statusBusy) return;
    if (track === "reading" && !book.documentId) return;
    const wasFinished = status === "finished";
    setStatus(wasFinished ? "none" : "finished");
    setStatusBusy(true);
    try {
      if (track === "reading") {
        const documentId = book.documentId!;
        if (wasFinished) {
          await api(`/api/library/books/${book.id}/reading-progress?documentId=${encodeURIComponent(documentId)}`, { method: "DELETE" });
        } else {
          await api(`/api/library/books/${book.id}/reading-progress/complete`, { method: "POST", body: JSON.stringify({ documentId }) });
        }
      } else if (wasFinished) {
        await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
      } else {
        await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
      }
    } catch {
      setStatus(bookStatus(book));
    } finally {
      setStatusBusy(false);
    }
  };

  return { liked, likeBusy, toggleLike, status, statusBusy, toggleFinished };
}
