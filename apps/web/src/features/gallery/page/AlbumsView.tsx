import { useTranslation } from "react-i18next";
import { Album, ArrowLeft, Download, FolderPlus, Image as ImageIcon, Pencil, Play, Send, SquareCheck, Trash2, X } from "lucide-react";
import { Button } from "../../../shared/Button";
import { NotesSection } from "../../social/NotesSection";
import type { SendToSubject } from "../../social/SendToSheet";
import { RelatedStories } from "../../stories/RelatedStories";
import { AssetTile, type LightboxSource } from "../AssetTile";
import { GallerySetTags } from "../GallerySetTags";
import type { GalleryAlbum, GalleryAsset } from "../types";
import type { useGalleryAlbums } from "../useGalleryAlbums";

// Albums: the list of albums, or — with one open — its photos, tags, the stories
// it appears in and the notes left on it, under a compact icon topbar.
export function AlbumsView({
  albumsState,
  shownAlbums,
  loading,
  isMobile,
  selectionMode,
  setSelectionMode,
  selectedIds,
  toggleSelect,
  toggleAssetLike,
  openLightbox,
  startSlideshow,
  setSendToSubject,
  setNotice
}: {
  albumsState: ReturnType<typeof useGalleryAlbums>;
  /** `albums` narrowed by the header's name filter. */
  shownAlbums: GalleryAlbum[];
  loading: boolean;
  isMobile: boolean;
  selectionMode: boolean;
  setSelectionMode: (on: boolean) => void;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAssetLike: (asset: GalleryAsset, next: boolean) => Promise<void>;
  openLightbox: (source: LightboxSource, index: number) => void;
  startSlideshow: () => void;
  setSendToSubject: (subject: SendToSubject) => void;
  setNotice: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const {
    albums, selectedAlbum, setSelectedAlbum, albumAssets, setAlbumAssets, albumTotal, setAlbumTotal,
    albumRename, setAlbumRename, setAlbumDeleteOpen, setCoverPickerOpen, setAlbumBrowseOpen,
    loadAlbums, openAlbum, patchAlbum, removeFromAlbum
  } = albumsState;

  if (selectedAlbum) {
    const albumCoverUrl = albums.find((al) => al.id === selectedAlbum.id)?.coverUrl ?? albumAssets[0]?.coverUrl ?? null;
    return (
      <>
        {/* Same idea as the slideshow detail's topbar: Back plus every
            action this album offers, icon-only, replacing the toolbar
            and page header that step aside while it's open. */}
        <div className="slideshow-detail-topbar">
          <Button
            variant="icon"
            title={t("gallery:page.back.albums")}
            aria-label={t("gallery:page.back.albums")}
            onClick={() => { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Button>
          <span className="library-toolbar-divider" aria-hidden="true" />
          <Button
            variant="icon"
            disabled={albumAssets.length < 2}
            title={albumAssets.length < 2 ? t("gallery:albums.playDisabledTitle") : t("gallery:albums.playTitle")}
            aria-label={t("gallery:albums.playTitle")}
            onClick={startSlideshow}
          >
            <Play size={18} aria-hidden="true" />
          </Button>
          {selectedAlbum.canEdit && (
            <Button variant="icon" title={t("gallery:common.addPhotos")} aria-label={t("gallery:common.addPhotos")} onClick={() => setAlbumBrowseOpen(true)}>
              <FolderPlus size={18} aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="icon"
            title={t("gallery:common.sendTo")}
            aria-label={t("gallery:common.sendTo")}
            onClick={() => setSendToSubject({ entityType: "gallery_album", entityId: selectedAlbum.id })}
          >
            <Send size={18} aria-hidden="true" />
          </Button>
          {selectedAlbum.canEdit && (
            <Button variant="icon" title={t("gallery:common.setCoverPhoto")} aria-label={t("gallery:common.setCoverPhoto")} onClick={() => { setNotice(""); setCoverPickerOpen(true); }}>
              <ImageIcon size={18} aria-hidden="true" />
            </Button>
          )}
          <a
            className="icon-button"
            title={t("gallery:albums.downloadTitle")}
            aria-label={t("gallery:albums.downloadTitle")}
            href={`/api/library/gallery/albums/${selectedAlbum.id}/download`}
            download
          >
            <Download size={18} aria-hidden="true" />
          </a>
          {selectedAlbum.canEdit && (
            <Button variant="icon" danger title={t("gallery:albums.deleteIconTitle")} aria-label={t("gallery:albums.deleteAlbumAria")} onClick={() => setAlbumDeleteOpen(true)}>
              <Trash2 size={18} aria-hidden="true" />
            </Button>
          )}
          {!isMobile && !selectionMode && (
            <Button variant="icon" title={t("gallery:common.select")} aria-label={t("gallery:common.selectPhotosAria")} onClick={() => { setNotice(""); setSelectionMode(true); }}>
              <SquareCheck size={18} aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="gallery-album-header">
          <span className="gallery-album-cover">
            {albumCoverUrl ? <img src={albumCoverUrl} alt="" /> : <Album size={30} aria-hidden="true" />}
          </span>
          <div className="gallery-album-heading">
            {albumRename == null ? (
              <div className="gallery-title-row">
                <h2>{selectedAlbum.name}</h2>
                {selectedAlbum.canEdit && (
                  <Button variant="icon" title={t("gallery:common.rename")} aria-label={t("gallery:common.rename")} onClick={() => setAlbumRename(selectedAlbum.name)}>
                    <Pencil size={18} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); if (albumRename.trim()) void patchAlbum(selectedAlbum.id, { name: albumRename.trim() }); }}>
                <input value={albumRename} onChange={(event) => setAlbumRename(event.target.value)} placeholder={t("gallery:albums.namePlaceholder")} autoFocus maxLength={120} />
                <Button variant="primary" compact type="submit" disabled={!albumRename.trim()}>{t("gallery:common.save")}</Button>
                <Button variant="icon" onClick={() => setAlbumRename(null)} aria-label={t("common:common.cancel")}><X size={14} aria-hidden="true" /></Button>
              </form>
            )}
            <p className="gallery-album-sub">
              {t("gallery:common.counts.item", { count: albumTotal })}
              {selectedAlbum.description ? <> · {selectedAlbum.description}</> : null}
            </p>
            {/* Tagging the album is what links it to the stories,
                photos and people that share the tag. */}
            <GallerySetTags
              endpoint={`/api/library/gallery/albums/${selectedAlbum.id}/tags`}
              tags={selectedAlbum.tags}
              canEdit={selectedAlbum.canEdit}
              onSaved={(tags) => setSelectedAlbum({ ...selectedAlbum, tags })}
            />
          </div>
        </div>

        <div className="gallery-grid">
          {albumAssets.map((asset, index) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              onOpen={() => openLightbox("album", index)}
              selectionMode={selectionMode}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onToggleLike={(next) => void toggleAssetLike(asset, next)}
              onRemove={selectedAlbum.canEdit && !selectionMode ? () => void removeFromAlbum(selectedAlbum.id, asset.id) : undefined}
              removeTitle={t("gallery:albums.removeFromAlbumTitle")}
            />
          ))}
        </div>
        {!loading && albumAssets.length === 0 && (
          <p className="management-empty">
            {t("gallery:albums.emptyBody")}
          </p>
        )}
        {albumAssets.length < albumTotal && (
          <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
            <Button variant="secondary" onClick={() => void openAlbum(selectedAlbum.id, albumAssets.length)} disabled={loading}>
              {loading ? t("gallery:common.loading") : t("gallery:common.loadMore")}
            </Button>
          </div>
        )}

        {/* The stories this album appears in — the back-link half of
            "stories reference, never copy". */}
        <RelatedStories entityType="gallery_album" entityId={selectedAlbum.id} />
        <NotesSection entityType="gallery_album" entityId={selectedAlbum.id} />
      </>
    );
  }

  return (
    <>
      {/* New album lives in the page header's primary slot now, with
          every other page's Create button. */}
      <div className="gallery-person-toolbar">
        <span className="muted gallery-face-hint">
          {t("gallery:albums.introHint")}
        </span>
      </div>

      {shownAlbums.length > 0 && (
        <div className="gallery-folder-grid">
          {shownAlbums.map((album) => (
            <Button variant="tile" key={album.id} className="gallery-folder-tile" onClick={() => { setAlbumAssets([]); setAlbumTotal(0); void openAlbum(album.id); }}>
              <span className="gallery-folder-thumb">
                {album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <Album size={28} aria-hidden="true" />}
              </span>
              <strong>{album.name}</strong>
              <small>{t("gallery:common.counts.item", { count: album.itemCount })}</small>
            </Button>
          ))}
        </div>
      )}
      {!loading && albums.length > 0 && shownAlbums.length === 0 && (
        <div className="empty-state library-empty">
          <Album size={48} aria-hidden="true" />
          <h2>{t("gallery:albums.noMatchTitle")}</h2>
        </div>
      )}
      {!loading && albums.length === 0 && (
        <div className="empty-state library-empty">
          <Album size={48} aria-hidden="true" />
          <h2>{t("gallery:albums.emptyTitle")}</h2>
          <p className="muted">
            {t("gallery:albums.emptyBody2")}
          </p>
        </div>
      )}
    </>
  );
}
