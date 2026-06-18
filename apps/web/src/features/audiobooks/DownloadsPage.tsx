import { useCallback, useEffect, useState } from "react";
import { BookOpen, DownloadCloud, HardDrive, Play, ShieldCheck, Trash2 } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { LibraryNavTabs } from "./LibraryNavTabs";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import {
  deleteDownload,
  deleteEbookDownload,
  estimateStorage,
  listDownloads,
  listEbookDownloads,
  requestPersistentStorage,
  type DownloadRecord,
  type EbookDownloadRecord,
  type StorageEstimate
} from "../../offline/downloads";

export function DownloadsPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [downloads, setDownloads] = useState<DownloadRecord[] | null>(null);
  const [ebookDownloads, setEbookDownloads] = useState<EbookDownloadRecord[] | null>(null);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [removing, setRemoving] = useState<string[]>([]);
  const [removingEbook, setRemovingEbook] = useState<string[]>([]);

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

  const totalDownloadedBytes =
    (downloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0) +
    (ebookDownloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0);
  const totalCount = (downloads?.length ?? 0) + (ebookDownloads?.length ?? 0);
  const hasAny = totalCount > 0;
  const allLoaded = downloads !== null && ebookDownloads !== null;
  const usagePercent = storage && storage.quota > 0 ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : null;

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <LibraryNavTabs active="downloads" />

        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Downloads</h1>
          </div>
          {hasAny && (
            <span>{totalCount} {totalCount === 1 ? "book" : "books"} · {formatBytes(totalDownloadedBytes)}</span>
          )}
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
        ) : (
          <div>
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
                          onClick={() => navigate(`/ebooks/books/${book.bookId}`)}
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
  );
}
