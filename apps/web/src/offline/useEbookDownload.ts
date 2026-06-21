import { useCallback, useEffect, useState } from "react";
import {
  deleteEbookDownload, downloadEbook, getEbookDownload,
  type EbookDownloadRecord
} from "./downloads";

export interface EbookMeta {
  bookId: string;
  documentId: string;
  documentUrl: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  totalBytes: number;
  // The document's format ("epub" | "fb2"), so the offline blob keeps its real
  // type and the reader names it correctly — rather than assuming EPUB.
  format: string;
}

export interface UseEbookDownload {
  record: EbookDownloadRecord | null;
  progress: number; // 0–1, meaningful while downloading
  busy: boolean;
  error: string;
  start: () => Promise<void>;
  remove: () => Promise<void>;
}

export function useEbookDownload(meta: EbookMeta | null): UseEbookDownload {
  const [record, setRecord] = useState<EbookDownloadRecord | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const bookId = meta?.bookId ?? null;

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setProgress(0);
    setError("");
    if (bookId) {
      getEbookDownload(bookId).then((r) => { if (!cancelled) setRecord(r); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [bookId]);

  const start = useCallback(async () => {
    if (!meta) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const done = await downloadEbook(
        meta.bookId,
        meta.documentId,
        meta.documentUrl,
        { title: meta.title, authors: meta.authors, coverUrl: meta.coverUrl, totalBytes: meta.totalBytes, format: meta.format },
        setProgress
      );
      setRecord(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
      setRecord(await getEbookDownload(meta.bookId).catch(() => null));
    } finally {
      setBusy(false);
    }
  }, [meta]);

  const remove = useCallback(async () => {
    if (!meta) return;
    await deleteEbookDownload(meta.bookId).catch(() => {});
    setRecord(null);
    setProgress(0);
    setError("");
  }, [meta]);

  return { record, progress, busy, error, start, remove };
}
