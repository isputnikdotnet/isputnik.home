import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronLeft, ChevronRight, Download, Image as ImageIcon, Images, Play, Share2, X } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "../library/UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { InboxRow, type InboxCard } from "./InboxRow";
import { DeliveryRow, type DeliveryCard } from "./DeliveryRow";
import { refreshInboxSummary } from "./useInboxSummary";
import { Button } from "../../shared/Button";
import { formatDate } from "../../shared/dates";

interface SharedBook {
  id: string;
  type: "audiobook" | "ebook" | "gallery" | "gallery_album";
  title: string;
  coverUrl: string | null;
  // Album shares only: how many photos the recipient can currently see.
  itemCount?: number;
  sharedBy: string | null;
  sharedAt: string;
  expiresAt: string | null;
}

// One photo/video in a shared album. Media URLs are authenticated same-origin, so
// the browser sends the session cookie with <img>/<video> automatically.
interface SharedAlbumItem {
  id: string;
  title: string;
  kind: "photo" | "video";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  takenAt: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string;
}

/** A row on For you: something sent, or a delivery into an Inbox. */
export type ForYouRow = (InboxCard & { kind: "sent" }) | DeliveryCard;

// Where opening a shared item takes you: a single photo deep-links into the gallery
// lightbox; books go to their reader/detail page. Albums open in-page (below).
function sharedItemHref(item: SharedBook): string {
  if (item.type === "gallery") return `/gallery/assets/${item.id}`;
  return `${item.type === "ebook" ? "/ebooks" : "/audiobooks"}/books/${item.id}`;
}

// A live album shared with the viewer: a photo grid + lightweight viewer. Items
// reflect the album's current photos each time it opens (resolved server-side).
function SharedAlbumViewer({ album, onClose }: { album: SharedBook; onClose: () => void }) {
  const { t } = useTranslation(["common", "user"]);
  const [items, setItems] = useState<SharedAlbumItem[] | null>(null);
  const [error, setError] = useState("");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex != null && items ? items[openIndex] : null;

  useEffect(() => {
    api<{ items: SharedAlbumItem[] }>(`/api/library/gallery/shared-albums/${album.id}`)
      .then((payload) => setItems(payload.items))
      .catch((err) => setError(err instanceof Error ? err.message : t("user:shared.albumOpenFailed")));
  }, [album.id, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return; // a dialog on top already answered it
      if (event.key === "Escape") {
        if (openIndex != null) setOpenIndex(null);
        else onClose();
        return;
      }
      if (openIndex == null || !items) return;
      if (event.key === "ArrowRight") setOpenIndex((i) => (i != null && i < items.length - 1 ? i + 1 : i));
      else if (event.key === "ArrowLeft") setOpenIndex((i) => (i != null && i > 0 ? i - 1 : i));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, items, onClose]);

  return createPortal(
    <div className="share-set-viewer" role="dialog" aria-modal="true" aria-label={album.title}>
      <div className="share-set-viewer-head">
        <span className="share-set-viewer-title">{album.title}</span>
        <div className="share-set-viewer-actions">
          {open && (
            <a className="secondary-button compact-button" href={`${open.fileUrl}${open.fileUrl.includes("?") ? "&" : "?"}download=1`} download>
              <Download size={15} /><span>{t("user:actions.download")}</span>
            </a>
          )}
          <Button variant="icon" onClick={() => (openIndex != null ? setOpenIndex(null) : onClose())} aria-label={t("common:common.close")}>
            <X size={18} />
          </Button>
        </div>
      </div>

      {open ? (
        <div className="share-set-viewer-body">
          {openIndex! > 0 && (
            <Button variant="bare" className="share-set-nav prev" onClick={() => setOpenIndex(openIndex! - 1)} aria-label={t("user:viewer.previous")}>
              <ChevronLeft size={26} />
            </Button>
          )}
          {open.kind === "video" ? (
            <video key={open.id} src={open.fileUrl} controls playsInline poster={open.previewUrl ?? undefined} />
          ) : (
            <img key={open.id} src={open.previewUrl ?? open.fileUrl} alt={open.title} />
          )}
          {openIndex! < (items?.length ?? 0) - 1 && (
            <Button variant="bare" className="share-set-nav next" onClick={() => setOpenIndex(openIndex! + 1)} aria-label={t("user:viewer.next")}>
              <ChevronRight size={26} />
            </Button>
          )}
        </div>
      ) : (
        <div className="share-set-viewer-grid-wrap">
          {error && <MessageBox tone="error" title={t("user:shared.unableToOpen")}>{error}</MessageBox>}
          {items && items.length === 0 && !error && (
            <p className="muted" style={{ padding: "24px" }}>{t("user:shared.albumEmpty")}</p>
          )}
          {items && items.length > 0 && (
            <div className="share-set-grid">
              {items.map((item, index) => (
                <Button variant="tile" key={item.id} className="share-set-tile" onClick={() => setOpenIndex(index)} aria-label={t("user:viewer.openItem", { title: item.title })}>
                  {item.coverUrl ? (
                    <img src={item.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="share-set-fallback"><ImageIcon size={24} aria-hidden="true" /></span>
                  )}
                  {item.kind === "video" && <span className="share-set-video-badge"><Play size={11} aria-hidden="true" />{t("user:viewer.video")}</span>}
                </Button>
              ))}
            </div>
          )}
          {!items && !error && <p className="management-empty">{t("user:common.loading")}</p>}
        </div>
      )}
    </div>,
    document.body
  );
}

// For you — docs/for-you-plan.md.
//
// Everything waiting on this person, in one list, each with the one action it
// wants: something a family member sent (Like / Not now), a question about an
// album (Add what you know), a delivery into a Photo Inbox they look after
// (Review, or Add what you know). A row leaves when acted on. Below the list,
// what they can open — the old "Shared with me", unchanged.
//
// It used to be "Shared with me" and, before that, "Sent to me"; both addresses
// still land here. Opening the page IS reading it: the dot goes now, deciding
// about each row is a separate, unhurried thing.
export function ForYouPage() {
  const { t } = useTranslation(["common", "user"]);
  const [books, setBooks] = useState<SharedBook[] | null>(null);
  const [waiting, setWaiting] = useState<ForYouRow[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [openAlbum, setOpenAlbum] = useState<SharedBook | null>(null);

  const loadShares = useCallback(
    () =>
      api<{ books: SharedBook[] }>("/api/shared-with-me")
        .then((payload) => setBooks(payload.books))
        .catch((err) => setError(err instanceof Error ? err.message : t("user:shared.loadFailed"))),
    [t]
  );

  const loadWaiting = useCallback(
    () =>
      api<{ waiting: ForYouRow[] }>("/api/for-you")
        .then((payload) => setWaiting(payload.waiting))
        // A failing half must not take the page with it — the grid still renders.
        .catch(() => setWaiting([])),
    []
  );

  useEffect(() => {
    void loadShares();
    void loadWaiting();
  }, [loadShares, loadWaiting]);

  // Opening the page IS reading it, so this fires once per visit — kept apart from
  // the loads above, which may run again (a language switch re-reads them for the
  // error line) and must not re-mark the inbox as seen each time.
  useEffect(() => {
    api("/api/social/inbox/seen", { method: "POST" }).then(refreshInboxSummary).catch(() => undefined);
  }, []);

  const act = async (card: InboxCard, action: "save" | "dismiss") => {
    setBusyId(card.id);
    setError("");
    try {
      await api(`/api/social/recommendations/${card.id}/${action}`, { method: "POST" });
      await Promise.all([loadWaiting(), loadShares()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:shared.updateFailed"));
    } finally {
      setBusyId("");
    }
  };

  const dismissDelivery = async (card: DeliveryCard) => {
    setBusyId(card.id);
    setError("");
    try {
      await api("/api/for-you/deliveries/dismiss", { method: "POST", body: JSON.stringify({ libraryId: card.libraryId, folder: card.folder }) });
      await loadWaiting();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:forYou.dismissFailed"));
    } finally {
      setBusyId("");
    }
  };

  const openShared = (book: SharedBook) => {
    if (book.type === "gallery_album") setOpenAlbum(book);
    else navigate(sharedItemHref(book));
  };

  // A grant made through "Send to" writes a share row AND a recommendation. While
  // the recommendation is undecided it owns the item, so it appears once, up top.
  const rows = waiting ?? [];
  const pending = new Set(rows.filter((row) => row.kind === "sent").map((row) => `${row.entityType}:${row.entityId}`));
  const shelf = (books ?? []).filter((book) => !pending.has(`${book.type}:${book.id}`));
  const nothingAtAll = books !== null && waiting !== null && shelf.length === 0 && rows.length === 0;

  return (
    <DashboardShell active="user" sideNav={<UserAreaNav active="shared" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">{t("user:shared.eyebrow")}</p>
            <h1>{t("common:nav.forYou")}</h1>
            {waiting !== null && <p className="muted">{t("user:forYou.intro", { count: rows.length })}</p>}
          </div>
          {shelf.length > 0 && (
            <span>{t("user:count.items", { count: shelf.length })}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title={t("user:common.errorTitle")}>{error}</MessageBox>}

        {rows.length > 0 && (
          <>
            <h2 className="inbox-subhead">{t("user:shared.waitingForYou")}</h2>
            <ul className="inbox-list">
              {rows.map((row) => row.kind === "delivery"
                ? <DeliveryRow key={row.id} card={row} busy={busyId === row.id} onDismiss={dismissDelivery} />
                : <InboxRow key={row.id} card={row} busy={busyId === row.id} onAct={act} />)}
            </ul>
          </>
        )}

        {nothingAtAll ? (
          <div className="empty-state library-empty">
            <Share2 size={58} aria-hidden="true" />
            <h2>{t("user:shared.emptyHeading")}</h2>
            <p className="muted">
              {t("user:shared.empty")}
            </p>
          </div>
        ) : (
          <>
            {shelf.length > 0 && <h2 className="inbox-subhead">{t("user:forYou.thingsYouCanOpen")}</h2>}
            <div className="audiobook-grid">
              {shelf.map((book) => (
                <article className="saved-audiobook-card" key={`${book.type}-${book.id}`}>
                  <Button variant="tile" className="audiobook-card" onClick={() => openShared(book)}>
                    <div className="audiobook-cover" aria-hidden="true">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt="" />
                      ) : book.type === "gallery_album" ? (
                        <Images size={20} />
                      ) : book.type === "gallery" ? (
                        <ImageIcon size={20} />
                      ) : (
                        <>
                          <BookOpen size={13} />
                          <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
                        </>
                      )}
                    </div>
                    <div className="audiobook-card-body">
                      <strong>{book.title}</strong>
                      <span>
                        {book.type === "gallery_album"
                          ? `${t("user:shared.album")} · ${t("user:count.photos", { count: book.itemCount ?? 0 })}`
                          : book.sharedBy ? t("user:shared.sharedBy", { name: book.sharedBy }) : t("user:shared.sharedWithYou")}
                      </span>
                      <small>{book.expiresAt ? t("user:share.until", { date: formatDate(book.expiresAt) }) : t("user:share.noExpiry")}</small>
                    </div>
                  </Button>
                </article>
              ))}
              {books === null && <p className="management-empty">{t("user:common.loading")}</p>}
            </div>
          </>
        )}
      </section>

      {openAlbum && <SharedAlbumViewer album={openAlbum} onClose={() => setOpenAlbum(null)} />}
    </DashboardShell>
  );
}
