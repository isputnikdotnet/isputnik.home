import { useState } from "react";
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

/** An optimistic flip, remembered against the server value it was made over. The
 *  moment the book comes back carrying a different value, the flip is spent and
 *  the book wins — so both toggles below are DERIVED from the book rather than
 *  copied out of it into state that an effect then has to keep in step. */
interface Optimistic<T> { over: T; value: T }

function settled<T>(pending: Optimistic<T> | null, fromBook: T): T {
  return pending && pending.over === fromBook ? pending.value : fromBook;
}

// The like and finished toggles every catalog tile carries (desktop card and
// mobile row alike). Both are optimistic — flipped at once, put back if the
// server refuses — and both read through the book, so a catalog refresh is
// adopted in the same render rather than one render later.
export function useBookLike(
  book: AudiobookBook & { documentId?: string | null },
  track: FinishTrack = "listening"
) {
  const [pendingLike, setPendingLike] = useState<Optimistic<boolean> | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<Optimistic<BookStatus> | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const liked = settled(pendingLike, book.saved);
  const serverStatus = bookStatus(book);
  const status = settled(pendingStatus, serverStatus);

  const toggleLike = async () => {
    if (likeBusy) return;
    const next = !liked;
    setPendingLike({ over: book.saved, value: next });
    setLikeBusy(true);
    try {
      if (next) await api(`/api/library/books/${book.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${book.id}/save`, { method: "DELETE" });
    } catch {
      setPendingLike(null);
    } finally {
      setLikeBusy(false);
    }
  };

  const toggleFinished = async () => {
    if (statusBusy) return;
    if (track === "reading" && !book.documentId) return;
    const wasFinished = status === "finished";
    setPendingStatus({ over: serverStatus, value: wasFinished ? "none" : "finished" });
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
      setPendingStatus(null);
    } finally {
      setStatusBusy(false);
    }
  };

  return { liked, likeBusy, toggleLike, status, statusBusy, toggleFinished };
}
