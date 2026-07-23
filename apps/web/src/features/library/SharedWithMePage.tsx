import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronLeft, ChevronRight, Download, Image as ImageIcon, Images, Play, Share2, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "./UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";

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

// Where opening a shared item takes you: a single photo deep-links into the gallery
// lightbox; books go to their reader/detail page. Albums open in-page (below).
function sharedItemHref(item: SharedBook): string {
  if (item.type === "gallery") return `/gallery/assets/${item.id}`;
  return `${item.type === "ebook" ? "/ebooks" : "/audiobooks"}/books/${item.id}`;
}

// A live album shared with the viewer: a photo grid + lightweight viewer. Items
// reflect the album's current photos each time it opens (resolved server-side).
function SharedAlbumViewer({ album, onClose }: { album: SharedBook; onClose: () => void }) {
  const [items, setItems] = useState<SharedAlbumItem[] | null>(null);
  const [error, setError] = useState("");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex != null && items ? items[openIndex] : null;

  useEffect(() => {
    api<{ items: SharedAlbumItem[] }>(`/api/library/gallery/shared-albums/${album.id}`)
      .then((payload) => setItems(payload.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to open this album"));
  }, [album.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { openIndex != null ? setOpenIndex(null) : onClose(); return; }
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
            <a className="secondary-button compact-button" href={open.fileUrl} download>
              <Download size={15} /><span>Download</span>
            </a>
          )}
          <button className="icon-button" onClick={() => (openIndex != null ? setOpenIndex(null) : onClose())} aria-label="Close">
            <X size={18} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="share-set-viewer-body">
          {openIndex! > 0 && (
            <button className="share-set-nav prev" onClick={() => setOpenIndex(openIndex! - 1)} aria-label="Previous">
              <ChevronLeft size={26} />
            </button>
          )}
          {open.kind === "video" ? (
            <video key={open.id} src={open.fileUrl} controls playsInline poster={open.previewUrl ?? undefined} />
          ) : (
            <img key={open.id} src={open.previewUrl ?? open.fileUrl} alt={open.title} />
          )}
          {openIndex! < (items?.length ?? 0) - 1 && (
            <button className="share-set-nav next" onClick={() => setOpenIndex(openIndex! + 1)} aria-label="Next">
              <ChevronRight size={26} />
            </button>
          )}
        </div>
      ) : (
        <div className="share-set-viewer-grid-wrap">
          {error && <MessageBox tone="error" title="Unable to open">{error}</MessageBox>}
          {items && items.length === 0 && !error && (
            <p className="muted" style={{ padding: "24px" }}>This album has no photos you can see right now.</p>
          )}
          {items && items.length > 0 && (
            <div className="share-set-grid">
              {items.map((item, index) => (
                <button key={item.id} type="button" className="share-set-tile" onClick={() => setOpenIndex(index)} aria-label={`Open ${item.title}`}>
                  {item.coverUrl ? (
                    <img src={item.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="share-set-fallback"><ImageIcon size={24} aria-hidden="true" /></span>
                  )}
                  {item.kind === "video" && <span className="share-set-video-badge"><Play size={11} aria-hidden="true" />Video</span>}
                </button>
              ))}
            </div>
          )}
          {!items && !error && <p className="management-empty">Loading…</p>}
        </div>
      )}
    </div>,
    document.body
  );
}

export function SharedWithMePage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [books, setBooks] = useState<SharedBook[] | null>(null);
  const [error, setError] = useState("");
  const [openAlbum, setOpenAlbum] = useState<SharedBook | null>(null);

  useEffect(() => {
    api<{ books: SharedBook[] }>("/api/shared-with-me")
      .then((payload) => setBooks(payload.books))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load shared books"));
  }, []);

  const openShared = (book: SharedBook) => {
    if (book.type === "gallery_album") setOpenAlbum(book);
    else navigate(sharedItemHref(book));
  };

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="shared" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Shared with me</h1>
          </div>
          {books && books.length > 0 && (
            <span>{books.length} {books.length === 1 ? "item" : "items"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

        {books && books.length === 0 ? (
          <div className="empty-state library-empty">
            <Share2 size={58} aria-hidden="true" />
            <h2>Nothing shared with you yet</h2>
            <p className="muted">When someone shares a book, photo, or album with your account, it appears here.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(books ?? []).map((book) => (
              <article className="saved-audiobook-card" key={`${book.type}-${book.id}`}>
                <button className="audiobook-card" onClick={() => openShared(book)}>
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
                        ? `Album · ${book.itemCount ?? 0} ${book.itemCount === 1 ? "photo" : "photos"}`
                        : book.sharedBy ? `Shared by ${book.sharedBy}` : "Shared with you"}
                    </span>
                    <small>{book.expiresAt ? `Until ${new Date(book.expiresAt).toLocaleDateString()}` : "No expiry"}</small>
                  </div>
                </button>
              </article>
            ))}
            {books === null && <p className="management-empty">Loading…</p>}
          </div>
        )}
      </section>

      {openAlbum && <SharedAlbumViewer album={openAlbum} onClose={() => setOpenAlbum(null)} />}
    </DashboardShell>
  );
}
