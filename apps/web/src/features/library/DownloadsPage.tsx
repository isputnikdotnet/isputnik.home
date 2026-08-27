import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, DownloadCloud, HardDrive, Play, ShieldCheck, Trash2 } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { useIsMobile } from "../../shared/useIsMobile";
import { formatBytes } from "../../shared/utils";
import { FeedListItem } from "./FeedListItem";
import { audioRecordToFeedItem, ebookRecordToFeedItem } from "./feed";
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

interface ViewerState {
  bookId: string;
  docId: string;
  format: string;
  blob: Blob;
  title: string;
  author: string;
  coverUrl: string | null;
  initialProgress: ReadingProgress | null;
}

export function DownloadsPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
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
    setViewer({
      bookId: record.bookId,
      docId: record.documentId,
      format: record.format ?? "epub",
      blob,
      title: record.title,
      author: record.authors.length > 0 ? record.authors.join(", ") : t("user:feed.unknownAuthor"),
      coverUrl: record.coverUrl,
      initialProgress: null
    });
  }, []);

  const totalDownloadedBytes =
    (downloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0) +
    (ebookDownloads ?? []).reduce((sum, d) => sum + d.totalBytes, 0);
  const totalCount = (downloads?.length ?? 0) + (ebookDownloads?.length ?? 0);
  const hasAny = totalCount > 0;
  const statsLabel = hasAny ? `${t("user:count.books", { count: totalCount })} · ${formatBytes(totalDownloadedBytes)}` : null;
  const allLoaded = downloads !== null && ebookDownloads !== null;
  const usagePercent = storage && storage.quota > 0 ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : null;

  return (
    <>
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="downloads" />}>
      <section className="work-area audiobook-area downloads-page">
        <div className="section-head audiobook-head">
          <div>
            <h1>{t("common:nav.downloads")}</h1>
            {isMobile && statsLabel && <p className="downloads-subtitle">{statsLabel}</p>}
          </div>
          {!isMobile && statsLabel && <span>{statsLabel}</span>}
        </div>

        {storage && (
          <section className="downloads-storage" aria-label={t("user:downloads.deviceStorage")}>
            <div className="downloads-storage-head">
              <span className="downloads-storage-label">
                <HardDrive size={16} aria-hidden="true" />
                {storage.quota > 0
                  ? t("user:downloads.usedOf", { used: formatBytes(storage.usage), quota: formatBytes(storage.quota) })
                  : t("user:downloads.used", { used: formatBytes(storage.usage) })}
              </span>
              {storage.persisted && (
                <span className="downloads-storage-persisted" title={t("user:downloads.protectedHint")}>
                  <ShieldCheck size={15} aria-hidden="true" /> {t("user:downloads.protected")}
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
            <h2>{t("user:downloads.emptyHeading")}</h2>
            <p className="muted">{t("user:downloads.empty")}</p>
          </div>
        ) : isMobile ? (
          <div>
            {downloads === null && <p className="management-empty">{t("user:downloads.loading")}</p>}
            {downloads && downloads.length > 0 && (
              <>
                <h2 className="downloads-section-title">{t("common:nav.audiobooks")}</h2>
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
                <h2 className="downloads-section-title">{t("common:nav.ebooks")}</h2>
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
          {downloads && downloads.length > 0 && <h2 className="downloads-section-title">{t("common:nav.audiobooks")}</h2>}
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
                      <span>{book.authors.length > 0 ? book.authors.join(", ") : t("user:feed.unknownAuthor")}</span>
                      <small>
                        {t("user:downloads.chapters", { count: book.files.length })} · {formatBytes(book.totalBytes)}
                        {book.state === "downloading" && ` · ${t("user:downloads.stateDownloading")}`}
                        {book.state === "failed" && ` · ${t("user:downloads.stateIncomplete")}`}
                      </small>
                    </div>
                  </button>
                  <div className="downloads-card-actions">
                    <button
                      className="icon-button"
                      onClick={() => window.open(`/player/${book.bookId}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes")}
                      aria-label={t("common:home.playTitle", { title: book.title })}
                      title={t("common:home.play")}
                    >
                      <Play size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      onClick={() => remove(book.bookId)}
                      disabled={isRemoving}
                      aria-label={t("user:downloads.removeFromDownloadsAria", { title: book.title })}
                      title={t("user:downloads.removeDownload")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
            {downloads === null && <p className="management-empty">{t("user:downloads.loading")}</p>}
          </div>

          {ebookDownloads && ebookDownloads.length > 0 && (
            <>
              <h2 className="downloads-section-title">{t("common:nav.ebooks")}</h2>
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
                          <span>{book.authors.length > 0 ? book.authors.join(", ") : t("user:feed.unknownAuthor")}</span>
                          <small>
                            EPUB · {formatBytes(book.totalBytes)}
                            {book.state === "downloading" && ` · ${t("user:downloads.stateDownloading")}`}
                            {book.state === "failed" && ` · ${t("user:downloads.stateIncomplete")}`}
                          </small>
                        </div>
                      </button>
                      <div className="downloads-card-actions">
                        <button
                          className="icon-button"
                          onClick={() => void openReader(book)}
                          aria-label={t("common:home.readTitle", { title: book.title })}
                          title={t("common:home.read")}
                        >
                          <BookOpen size={16} />
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => removeEbook(book.bookId)}
                          disabled={isRemoving}
                          aria-label={t("user:downloads.removeFromDownloadsAria", { title: book.title })}
                          title={t("user:downloads.removeDownload")}
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
        blob={viewer.blob}
        storageKey={`isputnik:epub-progress:${user.id}:${viewer.bookId}:${viewer.docId}`}
        initialProgress={viewer.initialProgress}
        title={viewer.title}
        author={viewer.author}
        coverUrl={viewer.coverUrl}
        onExit={() => setViewer(null)}
      />,
      document.body
    )}
    </>
  );
}
