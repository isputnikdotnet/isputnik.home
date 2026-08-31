import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, Heart, Info, ListMusic, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { FeedListItem, type FeedRowMenuItem } from "../library/FeedListItem";
import type { FeedItem } from "../library/feed";
import type { AudiobookBook } from "./types";

type BookStatus = "finished" | "in_progress" | "none";

function initialStatus(book: AudiobookBook): BookStatus {
  if (book.progress?.completedAt != null) return "finished";
  if ((book.progress?.percentComplete ?? 0) > 0) return "in_progress";
  return "none";
}

// Mobile / PWA library row: the homepage FeedListItem look, but the ⋮ menu
// carries the full library action set (like, mark played, add to
// collection, view details, download file, edit, delete — permission-gated).
// Only mounts at the mobile breakpoint; desktop keeps its card grid.
export function CatalogRowMobile({
  book,
  kind,
  canEdit,
  canDownload,
  canDelete,
  onEdit,
  onDelete,
  onAddToCollection,
  downloaded,
  onDownload,
  onDownloaded,
  onToast,
  onOpenReader
}: {
  book: AudiobookBook & { format?: string | null };
  kind: "audiobook" | "ebook";
  canEdit: boolean;
  canDownload: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onDelete: (book: AudiobookBook) => void;
  onAddToCollection: (book: AudiobookBook) => void;
  downloaded?: boolean;
  onDownload?: (info: { title: string; progress: number } | null) => void;
  onDownloaded?: (id: string) => void;
  onToast?: (message: string) => void;
  onOpenReader?: () => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [liked, setLiked] = useState(book.saved);
  const [likeBusy, setLikeBusy] = useState(false);
  const [status, setStatus] = useState<BookStatus>(() => initialStatus(book));
  const [statusBusy, setStatusBusy] = useState(false);

  // Re-seed from the server shape when the catalog refreshes.
  useEffect(() => { setLiked(book.saved); }, [book.saved]);
  useEffect(() => { setStatus(initialStatus(book)); }, [book.progress?.completedAt, book.progress?.percentComplete]);

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
    const wasFinished = status === "finished";
    setStatus(wasFinished ? "none" : "finished");
    setStatusBusy(true);
    try {
      if (wasFinished) await api(`/api/library/books/${book.id}/progress`, { method: "DELETE" });
      else await api(`/api/library/books/${book.id}/progress/complete`, { method: "POST", body: "{}" });
    } catch {
      setStatus(initialStatus(book));
    } finally {
      setStatusBusy(false);
    }
  };

  const item: FeedItem = {
    id: book.id,
    kind,
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverUrl,
    percentComplete: book.progress?.percentComplete ?? null,
    completedAt: book.progress?.completedAt ?? null,
    discoveredAt: book.discoveredAt,
    durationSeconds: book.durationSeconds,
    format: kind === "ebook" ? (book.format ?? null) : null,
    totalSize: kind === "ebook" ? book.totalSize : null
  };

  const detailHref = kind === "ebook" ? `/ebooks/books/${book.id}` : `/audiobooks/books/${book.id}`;
  const finished = status === "finished";
  const markLabel = kind === "ebook"
    ? (finished ? t("book:catalog.markUnreadLabel") : t("book:catalog.markAsReadLabel"))
    : (finished ? t("book:catalog.markUnplayedLabel") : t("book:catalog.markAsPlayedLabel"));

  const menuItems: FeedRowMenuItem[] = [
    { icon: Heart, label: liked ? t("book:detail.liked") : t("book:detail.like"), onClick: () => void toggleLike(), active: liked, disabled: likeBusy },
    { icon: finished ? RotateCcw : CheckCircle2, label: markLabel, onClick: () => void toggleFinished(), disabled: statusBusy },
    { icon: ListMusic, label: t("book:detail.addToCollection"), onClick: () => onAddToCollection(book) },
    { icon: Info, label: t("book:catalog.viewDetails"), onClick: () => navigate(detailHref) },
    ...(canDownload ? [{ icon: Download, label: t("book:catalog.downloadFile"), href: `/api/library/books/${book.id}/download` } as FeedRowMenuItem] : []),
    ...(canEdit ? [{ icon: Pencil, label: t("book:catalog.editDetails"), onClick: () => onEdit(book) } as FeedRowMenuItem] : []),
    ...(canDelete ? [{ icon: Trash2, label: t("book:catalog.delete"), onClick: () => onDelete(book), danger: true } as FeedRowMenuItem] : [])
  ];

  return (
    <FeedListItem
      item={item}
      progress
      menuItems={menuItems}
      downloaded={downloaded}
      onDownload={onDownload}
      onDownloaded={onDownloaded}
      onToast={onToast}
      onRead={onOpenReader ? () => Promise.resolve(onOpenReader()) : undefined}
    />
  );
}
