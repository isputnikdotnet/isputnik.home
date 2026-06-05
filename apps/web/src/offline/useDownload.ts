import { useCallback, useEffect, useState } from "react";
import type { AudiobookBookDetail } from "../features/audiobooks/types";
import { deleteDownload, downloadBook, getDownload, type DownloadRecord } from "./downloads";

export interface UseDownload {
  record: DownloadRecord | null;
  progress: number; // 0–1, meaningful while downloading
  busy: boolean;
  error: string;
  start: () => Promise<void>;
  remove: () => Promise<void>;
}

export function useDownload(book: AudiobookBookDetail | null): UseDownload {
  const [record, setRecord] = useState<DownloadRecord | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const bookId = book?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setProgress(0);
    setError("");
    if (bookId) {
      getDownload(bookId).then((r) => { if (!cancelled) setRecord(r); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [bookId]);

  const start = useCallback(async () => {
    if (!book) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const done = await downloadBook(book, setProgress);
      setRecord(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
      setRecord(await getDownload(book.id).catch(() => null));
    } finally {
      setBusy(false);
    }
  }, [book]);

  const remove = useCallback(async () => {
    if (!book) return;
    await deleteDownload(book.id).catch(() => {});
    setRecord(null);
    setProgress(0);
    setError("");
  }, [book]);

  return { record, progress, busy, error, start, remove };
}
