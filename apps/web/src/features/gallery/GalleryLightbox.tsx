import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, Heart, Info, ListMusic, Pencil, Share2, Trash2, X } from "lucide-react";
import { api } from "../../api";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatBytes } from "../../shared/utils";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { ShareModal } from "../share/ShareModal";
import { GalleryEditModal } from "./GalleryEditModal";
import type { GalleryAsset } from "./types";

// Leaflet rides in only when the Info panel shows a geotagged photo — keeps it off
// the initial bundle (and reuses the same chunk as the gallery Map view).
const GalleryMiniMap = lazy(() => import("./GalleryMiniMap").then((m) => ({ default: m.GalleryMiniMap })));

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTaken(takenAt: string | null): string {
  if (!takenAt) return "";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Full-screen photo/video viewer with keyboard navigation. Renders into a portal
// over the whole app (not a shared/Modal — a media lightbox is full-bleed and owns
// its own chrome). Per-asset actions act on the current item.
export function GalleryLightbox({
  assets,
  index,
  onClose,
  onIndexChange,
  onChanged,
  canDelete,
  canEdit,
  canShare
}: {
  assets: GalleryAsset[];
  index: number;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  onChanged: () => void;
  canDelete: boolean;
  canEdit: boolean;
  canShare: boolean;
}) {
  const asset = assets[index];
  const [showInfo, setShowInfo] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [fav, setFav] = useState(asset?.saved ?? false);
  const [favBusy, setFavBusy] = useState(false);

  useEffect(() => { setFav(asset?.saved ?? false); }, [asset?.id, asset?.saved]);

  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (collectionOpen || deleteOpen || editOpen || shareOpen) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (event.key === "ArrowRight" && index < assets.length - 1) onIndexChange(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, assets.length, onClose, onIndexChange, collectionOpen, deleteOpen, editOpen, shareOpen]);

  if (!asset) return null;

  const toggleFav = async () => {
    if (favBusy) return;
    const next = !fav;
    setFav(next);
    setFavBusy(true);
    try {
      if (next) await api(`/api/library/books/${asset.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${asset.id}/save`, { method: "DELETE" });
      onChanged();
    } catch {
      setFav(!next);
    } finally {
      setFavBusy(false);
    }
  };

  const confirmRemove = async () => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/api/library/books/${asset.id}`, { method: "DELETE" });
      setDeleteOpen(false);
      onChanged();
      // Move to a neighbour, or close when it was the last asset.
      if (assets.length <= 1) onClose();
      else onIndexChange(Math.min(index, assets.length - 2));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to move the item to the Recycle Bin");
    } finally {
      setDeleteBusy(false);
    }
  };

  const meta = [
    formatTaken(asset.takenAt),
    asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
    asset.kind === "video" ? formatDuration(asset.durationSeconds) : ""
  ].filter(Boolean).join(" · ");

  return createPortal(
    <div className="gallery-lightbox" role="dialog" aria-label={asset.title} aria-modal="true">
      <div className="gallery-lightbox-bar">
        <div className="gallery-lightbox-title">
          {asset.title}
          {meta && <small>{meta}</small>}
        </div>
        <div className="gallery-lightbox-actions">
          <button
            className={`gallery-lightbox-action${fav ? " is-on" : ""}`}
            type="button"
            onClick={() => void toggleFav()}
            disabled={favBusy}
            aria-pressed={fav}
            aria-label={fav ? "Remove from favorites" : "Add to favorites"}
            title={fav ? "Favorited" : "Favorite"}
          >
            <Heart size={18} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
          </button>
          <button
            className="gallery-lightbox-action"
            type="button"
            onClick={() => setCollectionOpen(true)}
            aria-label="Add to album"
            title="Add to album"
          >
            <ListMusic size={18} aria-hidden="true" />
          </button>
          {canShare && (
            <button
              className="gallery-lightbox-action"
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label="Share"
              title="Share"
            >
              <Share2 size={18} aria-hidden="true" />
            </button>
          )}
          <a
            className="gallery-lightbox-action"
            href={`${asset.fileUrl}`}
            download
            aria-label="Download"
            title="Download"
          >
            <Download size={18} aria-hidden="true" />
          </a>
          <button
            className={`gallery-lightbox-action${showInfo ? " is-on" : ""}`}
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            aria-pressed={showInfo}
            aria-label="Details"
            title="Details"
          >
            <Info size={18} aria-hidden="true" />
          </button>
          {canEdit && (
            <button
              className="gallery-lightbox-action"
              type="button"
              onClick={() => setEditOpen(true)}
              aria-label="Edit details"
              title="Edit details"
            >
              <Pencil size={18} aria-hidden="true" />
            </button>
          )}
          {canDelete && (
            <button
              className="gallery-lightbox-action"
              type="button"
              onClick={() => { setDeleteError(""); setDeleteOpen(true); }}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 size={18} aria-hidden="true" />
            </button>
          )}
          <button className="gallery-lightbox-action" type="button" onClick={onClose} aria-label="Close" title="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="gallery-lightbox-stage">
        {hasPrev && (
          <button className="gallery-lightbox-nav prev" type="button" onClick={() => onIndexChange(index - 1)} aria-label="Previous">
            <ChevronLeft size={26} aria-hidden="true" />
          </button>
        )}
        {asset.kind === "video" ? (
          <video key={asset.id} src={asset.fileUrl} controls autoPlay playsInline poster={asset.previewUrl ?? undefined} />
        ) : (
          <img key={asset.id} src={asset.previewUrl ?? asset.fileUrl} alt={asset.title} />
        )}
        {hasNext && (
          <button className="gallery-lightbox-nav next" type="button" onClick={() => onIndexChange(index + 1)} aria-label="Next">
            <ChevronRight size={26} aria-hidden="true" />
          </button>
        )}
      </div>

      {showInfo && (
        <aside className="gallery-lightbox-info" aria-label="Details">
          <h3>Details</h3>
          <dl>
            <div><dt>Name</dt><dd>{asset.title}</dd></div>
            {asset.description && <div><dt>Description</dt><dd>{asset.description}</dd></div>}
            {asset.takenAt && <div><dt>Date</dt><dd>{formatTaken(asset.takenAt)}</dd></div>}
            <div><dt>Type</dt><dd>{asset.kind === "video" ? "Video" : "Photo"}</dd></div>
            {asset.width != null && asset.height != null && (
              <div><dt>Dimensions</dt><dd>{asset.width} × {asset.height}</dd></div>
            )}
            {asset.kind === "video" && asset.durationSeconds != null && (
              <div><dt>Duration</dt><dd>{formatDuration(asset.durationSeconds)}</dd></div>
            )}
            {asset.size != null && <div><dt>Size</dt><dd>{formatBytes(asset.size)}</dd></div>}
            {asset.camera && (asset.camera.make || asset.camera.model) && (
              <div><dt>Camera</dt><dd>{[asset.camera.make, asset.camera.model].filter(Boolean).join(" ")}</dd></div>
            )}
            {asset.gps && (
              <div>
                <dt>Location</dt>
                <dd>
                  <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
                    <GalleryMiniMap lat={asset.gps.lat} lng={asset.gps.lng} title={asset.title} />
                  </Suspense>
                  <a
                    className="gallery-location-link"
                    href={`https://www.openstreetmap.org/?mlat=${asset.gps.lat}&mlon=${asset.gps.lng}#map=15/${asset.gps.lat}/${asset.gps.lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {asset.gps.lat.toFixed(5)}, {asset.gps.lng.toFixed(5)}
                  </a>
                </dd>
              </div>
            )}
            <div><dt>Folder</dt><dd>{asset.folder || "/"}</dd></div>
            {asset.tags.length > 0 && <div><dt>Tags</dt><dd>{asset.tags.join(", ")}</dd></div>}
          </dl>
        </aside>
      )}

      {editOpen && (
        <GalleryEditModal
          asset={asset}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); onChanged(); }}
        />
      )}

      {collectionOpen && (
        <AddToCollectionModal
          entityType="gallery"
          entityId={asset.id}
          title={asset.title}
          onClose={() => setCollectionOpen(false)}
        />
      )}

      {shareOpen && (
        <ShareModal
          bookId={asset.id}
          bookTitle={asset.title}
          kind="gallery"
          onClose={() => setShareOpen(false)}
        />
      )}

      {deleteOpen && (
        <ConfirmDialog
          title={`Move "${asset.title}" to the Recycle Bin?`}
          confirmLabel="Move to Recycle Bin"
          busyLabel="Moving…"
          busy={deleteBusy}
          error={deleteError}
          danger
          onConfirm={() => void confirmRemove()}
          onCancel={() => { if (!deleteBusy) setDeleteOpen(false); }}
        >
          This item moves into the Recycle Bin and leaves the gallery for everyone. You can restore it
          from the Recycle Bin, or delete it permanently from there.
        </ConfirmDialog>
      )}
    </div>,
    document.body
  );
}
