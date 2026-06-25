import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, DownloadCloud, HardDrive, Play, ShieldCheck, Trash2 } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { useIsMobile } from "../../shared/useIsMobile";
import { formatBytes } from "../../shared/utils";
import { FeedListItem } from "./FeedListItem";
import type { FeedItem } from "./feed";
import { EbookReader } from "../audiobooks/reader/EbookReader";
import type { ReadingProgress } from "../audiobooks/types";
import {
  deleteDownload,
  deleteEbookDownload,
  estimateStorage,
  getDownloadedEpubBlob,
  listDownloads,
  listEbookDownloads,
  requestPersistentStorage,
  type DownloadRecord,
  type EbookDownloadRecord,
  type StorageEstimate
} from "../../offline/downloads";

// Offline records → the home-feed FeedItem shape, so the mobile Downloads list
// reuses the exact home row layout. No progress is carried (offline rows don't
// show a bar); audiobooks surface their duration when the saved detail has it,
// ebooks surface "EPUB · size".
function audioRecordToFeedItem(book: DownloadRecord): FeedItem {
  return {
    id: book.bookId,
    kind: "audiobook",
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverUrl,
    percentComplete: null,
    completedAt: null,
    discoveredAt: book.createdAt,
    durationSeconds: book.bookDetail?.durationSeconds ?? null,
    format: null,
    totalSize: null
  };
}

function ebookRecordToFeedItem(book: EbookDownloadRecord): FeedItem {
  return {
    id: book.bookId,
    kind: "ebook",
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverUrl,
    percentComplete: null,
    completedAt: null,
    discoveredAt: book.createdAt,
    durationSeconds: null,
    format: "epub",
    totalSize: book.totalBytes
  };
}

interface ViewerState {
  bookId: string;
  docId: string;
  format: string;
  url: string;
  title: string;
  author: string;
  coverUrl: string | null;
  blobUrl: string;
  initialProgress: ReadingProgress | null;
}

export function DownloadsPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const isMobile = useIsMobile();
  const [downloads, setDownloads] = useState<DownloadRecord[] | null>(null);
  const [ebookDownloads, setEbookDownloads] = useState<EbookDownloadRecord[] | null>(null);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [removing, setRemoving] = useState<string[]>([]);
  const [removingEbook, setRemovingEbook] = useState<string[]>([]);
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const refresh = useCallback(async () => {
    const [list, ebookList, est] = await Promise.all([listDownloads(), listEbookDownloads(), estimateStorage()]);
    setDownloads(list);
    setEbookDownloads(ebookList);
    setStorage(est);
  }, []);

  useEffect(() => {
    void requestPersistentStorage();
    void refresh();
  }, [refresh]);

  const remove = async (bookId: string) => {
    setRemoving((current) => [...current, bookId]);
    try {
      await deleteDownload(bookId);
      await refresh();
    } finally {
      setRemoving((current) => current.filter((id) => id !== bookId));
    }
  };

  const removeEbook = async (bookId: string) => {
    setRemovingEbook((current) => [...current, bookId]);
    try {
      await deleteEbookDownload(bookId);
      await refresh();
    } finally {
      setRemovingEbook((current) => current.filter((id) => id !== bookId));
    }
  };

  // Open a downloaded ebook in the inline reader, straight from its offline
  // blob (this page is the offline surface). Falls back to the detail page only
  // if the file isn't actually present.
  const openReader = useCallback(async (record: EbookDownloadRecord) => {
    const blob = await getDownloadedEpubBlob(record.bookId, record.documentId).catch(() => null);
    if (!blob) { navigate(`/ebooks/books/${record.bookId}`); return; }
    const blobUrl = URL.createObjectURL(blob);
    setViewer({
      bookId: record.bookId,
      docId: record.documentId,
      format: record.format ?? "epub",
      url: blobUrl,
      title: record.title,
      author: record.authors.length > 0 ? record.authors.join(", ") : "Unknown author",
      coverUrl: record.coverUrl,
      blobUrl,
      initialProgress: null
    });
  }, []);

  // Revoke the blob URL when the reader closes or switches books.
  useEffect(() => {
    const current = viewer;
    return () => { if (current?.blobUrl) URL.revokeObjectURL(current.blobUrl); };
  }, [viewer]);

  const totalDownloadedBytes =
    (downloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0) +
    (ebookDownloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0);
  const totalCount = (downloads?.length ?? 0) + (ebookDownloads?.length ?? 0);
  const hasAny = totalCount > 0;
  const statsLabel = hasAny ? `${totalCount} ${totalCount === 1 ? "book" : "books"} · ${formatBytes(totalDownloadedBytes)}` : null;
  const allLoaded = downloads !== null && ebookDownloads !== null;
  const usagePercent = storage && storage.quota > 0 ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : null;

  return (
    <>
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="downloads" />}>
      <section className="work-area audiobook-area downloads-page">
        <div className="section-head audiobook-head">
          <div>
            <h1>Downloads</h1>
            {isMobile && statsLabel && <p className="downloads-subtitle">{statsLabel}</p>}
          </div>
          {!isMobile && statsLabel && <span>{statsLabel}</span>}
        </div>

        {storage && (
          <section className="downloads-storage" aria-label="Device storage">
            <div className="downloads-storage-head">
              <span className="downloads-storage-label">
                <HardDrive size={16} aria-hidden="true" />
                {formatBytes(storage.usage)} used{storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ""}
              </span>
              {storage.persisted && (
                <span className="downloads-storage-persisted" title="Downloads are protected from automatic eviction">
                  <ShieldCheck size={15} aria-hidden="true" /> Protected
                </span>
              )}
            </div>
            {usagePercent != null && (
              <span className="downloads-storage-track">
                <span style={{ width: `${usagePercent}%` }} />
              </span>
            )}
          </section>
        )}

        {allLoaded && !hasAny ? (
          <div className="empty-state library-empty">
            <DownloadCloud size={58} aria-hidden="true" />
            <h2>No downloads yet</h2>
            <p className="muted">Open a book and tap "Save offline" to keep it on this device for listening or reading without a connection.</p>
          </div>
        ) : isMobile ? (
          <div>
            {downloads === null && <p className="management-empty">Loading downloads…</p>}
            {downloads && downloads.length > 0 && (
              <>
                <h2 className="downloads-section-title">Audiobooks</h2>
                <div className="home-feed-list">
                  {downloads.map((book) => (
                    <FeedListItem
                      key={book.bookId}
                      item={audioRecordToFeedItem(book)}
                      hideDownload
                      onDelete={() => void remove(book.bookId)}
                      deleting={removing.includes(book.bookId)}
                    />
                  ))}
                </div>
              </>
            )}
            {ebookDownloads && ebookDownloads.length > 0 && (
              <>
                <h2 className="downloads-section-title">Ebooks</h2>
                <div className="home-feed-list">
                  {ebookDownloads.map((book) => (
                    <FeedListItem
                      key={book.bookId}
                      item={ebookRecordToFeedItem(book)}
                      hideDownload
                      onRead={() => openReader(book)}
                      onDelete={() => void removeEbook(book.bookId)}
                      deleting={removingEbook.includes(book.bookId)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
          {downloads && downloads.length > 0 && <h2 className="downloads-section-title">Audiobooks</h2>}
          <div className="audiobook-grid">
            {(downloads ?? []).map((book) => {
              const isRemoving = removing.includes(book.bookId);
              return (
                <article className="saved-audiobook-card" key={book.bookId}>
                  <button className="audiobook-card" onClick={() => navigate(`/audiobooks/books/${book.bookId}`)}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt="" />
                      ) : (
                        <>
                          <BookOpen size={13} />
                          <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                        </>
                      )}
                    </div>
                    <div className="audiobook-card-body">
                      <strong>{book.title}</strong>
                      <span>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</span>
                      <small>
                        {book.files.length} {book.files.length === 1 ? "chapter" : "chapters"} · {formatBytes(book.totalBytes)}
                        {book.state === "downloading" && " · downloading…"}
                        {book.state === "failed" && " · incomplete"}
                      </small>
                    </div>
                  </button>
                  <div className="downloads-card-actions">
                    <button
                      className="icon-button"
                      onClick={() => window.open(`/player/${book.bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes")}
                      aria-label={`Play ${book.title}`}
                      title="Play"
                    >
                      <Play size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      onClick={() => remove(book.bookId)}
                      disabled={isRemoving}
                      aria-label={`Remove ${book.title} from downloads`}
                      title="Remove download"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
            {downloads === null && <p className="management-empty">Loading downloads…</p>}
          </div>

          {ebookDownloads && ebookDownloads.length > 0 && (
            <>
              <h2 className="downloads-section-title">Ebooks</h2>
              <div className="audiobook-grid">
                {(ebookDownloads ?? []).map((book) => {
                  const isRemoving = removingEbook.includes(book.bookId);
                  return (
                    <article className="saved-audiobook-card" key={book.bookId}>
                      <button className="audiobook-card" onClick={() => navigate(`/ebooks/books/${book.bookId}`)}>
                        <div className="audiobook-cover" aria-hidden="true">
                          {book.coverUrl ? (
                            <img src={book.coverUrl} alt="" />
                          ) : (
                            <>
                              <BookOpen size={13} />
                              <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                            </>
                          )}
                        </div>
                        <div className="audiobook-card-body">
                          <strong>{book.title}</strong>
                          <span>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</span>
                          <small>
                            EPUB · {formatBytes(book.totalBytes)}
                            {book.state === "downloading" && " · downloading…"}
                            {book.state === "failed" && " · incomplete"}
                          </small>
                        </div>
                      </button>
                      <div className="downloads-card-actions">
                        <button
                          className="icon-button"
                          onClick={() => void openReader(book)}
                          aria-label={`Read ${book.title}`}
                          title="Read"
                        >
                          <BookOpen size={16} />
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => removeEbook(book.bookId)}
                          disabled={isRemoving}
                          aria-label={`Remove ${book.title} from downloads`}
                          title="Remove download"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
          </div>
        )}
      </section>
    </DashboardShell>

    {viewer && createPortal(
      <EbookReader
        bookId={viewer.bookId}
        documentId={viewer.docId}
        format={viewer.format}
        url={viewer.url}
        storageKey={`isputnik:epub-progress:${user.id}:${viewer.bookId}:${viewer.docId}`}
        initialProgress={viewer.initialProgress}
        title={viewer.title}
        author={viewer.author}
        coverUrl={viewer.coverUrl}
        downloadUrl={viewer.url}
        onExit={() => setViewer(null)}
      />,
      document.body
    )}
    </>
  );
}
