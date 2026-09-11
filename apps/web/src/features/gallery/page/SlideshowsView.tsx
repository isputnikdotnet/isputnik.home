import { useTranslation } from "react-i18next";
import { ArrowLeft, Film, FolderPlus, Image as ImageIcon, Pencil, Play, Send, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "../../../shared/Button";
import { NotesSection } from "../../social/NotesSection";
import type { SendToSubject } from "../../social/SendToSheet";
import { RelatedStories } from "../../stories/RelatedStories";
import type { LightboxSource } from "../AssetTile";
import { GallerySetTags } from "../GallerySetTags";
import { GallerySlideshowEditor } from "../GallerySlideshowEditor";
import type { GalleryMemorySuggestion, GallerySlideshow } from "../types";
import type { useGallerySlideshows } from "../useGallerySlideshows";

// Slideshows: suggested memories and your slideshows, or — with one open — its
// editor (photos, order, music, transitions, the rendered movie).
export function SlideshowsView({
  slideshowsState,
  shownSlideshows,
  memorySuggestions,
  openSuggestionPreview,
  nameTerm,
  loading,
  openLightbox,
  startSlideshow,
  setSendToSubject,
  setNotice,
  onOpenMovieLibrary
}: {
  slideshowsState: ReturnType<typeof useGallerySlideshows>;
  /** `slideshows` narrowed by the header's name filter. */
  shownSlideshows: GallerySlideshow[];
  memorySuggestions: GalleryMemorySuggestion[];
  openSuggestionPreview: (suggestion: GalleryMemorySuggestion) => Promise<void>;
  nameTerm: string;
  loading: boolean;
  openLightbox: (source: LightboxSource, index: number) => void;
  startSlideshow: () => void;
  setSendToSubject: (subject: SendToSubject) => void;
  setNotice: (message: string) => void;
  onOpenMovieLibrary: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const {
    slideshows, selectedSlideshow, setSelectedSlideshow,
    slideshowAssets, setSlideshowAssets, slideshowTotal, setSlideshowTotal,
    slideshowRename, setSlideshowRename, setSlideshowDeleteOpen,
    setBrowseOpen, setSlideshowCoverPickerOpen, setMovieDeleteOpen,
    loadSlideshows, openSlideshow, patchSlideshow, renderSlideshowMovie,
    reorderSlideshow, removeFromSlideshow
  } = slideshowsState;

  if (selectedSlideshow) {
    const cover = slideshows.find((s) => s.id === selectedSlideshow.id)?.coverUrl ?? slideshowAssets[0]?.coverUrl ?? null;
    return (
      <>
        {/* The toolbar and page header are gone on an open slideshow
            (see showBrowseChrome). This compact icon row is what
            replaces them — Back plus every action, icon-only. */}
        <div className="slideshow-detail-topbar">
          <Button
            variant="icon"
            title={t("gallery:page.back.slideshows")}
            aria-label={t("gallery:page.back.slideshows")}
            onClick={() => { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Button>
          <span className="library-toolbar-divider" aria-hidden="true" />
          <Button
            variant="icon"
            disabled={slideshowAssets.length === 0}
            title={slideshowAssets.length < 2 ? t("gallery:slideshows.playDisabledTitle") : t("gallery:slideshows.playTitle")}
            aria-label={t("gallery:slideshows.playTitle")}
            onClick={startSlideshow}
          >
            <Play size={18} aria-hidden="true" />
          </Button>
          <Button
            variant="icon"
            title={t("gallery:common.sendTo")}
            aria-label={t("gallery:common.sendTo")}
            onClick={() => setSendToSubject({ entityType: "gallery_slideshow", entityId: selectedSlideshow.id })}
          >
            <Send size={18} aria-hidden="true" />
          </Button>
          {selectedSlideshow.canEdit && (
            <Button variant="icon" title={t("gallery:common.addPhotos")} aria-label={t("gallery:common.addPhotos")} onClick={() => setBrowseOpen(true)}>
              <FolderPlus size={18} aria-hidden="true" />
            </Button>
          )}
          {selectedSlideshow.canEdit && (
            <Button variant="icon" title={t("gallery:common.setCoverPhoto")} aria-label={t("gallery:common.setCoverPhoto")} onClick={() => { setNotice(""); setSlideshowCoverPickerOpen(true); }}>
              <ImageIcon size={18} aria-hidden="true" />
            </Button>
          )}
          {selectedSlideshow.canEdit && (
            <Button variant="icon" danger title={t("gallery:common.deleteWord")} aria-label={t("gallery:common.deleteWord")} onClick={() => setSlideshowDeleteOpen(true)}>
              <Trash2 size={18} aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="gallery-album-header">
          <span className="gallery-album-cover">
            {cover ? <img src={cover} alt="" /> : <Film size={30} aria-hidden="true" />}
          </span>
          <div className="gallery-album-heading">
            {slideshowRename == null ? (
              <div className="gallery-title-row">
                <h2>{selectedSlideshow.name}</h2>
                {selectedSlideshow.canEdit && (
                  <Button variant="icon" title={t("gallery:common.rename")} aria-label={t("gallery:common.rename")} onClick={() => setSlideshowRename(selectedSlideshow.name)}>
                    <Pencil size={18} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); if (slideshowRename.trim()) void patchSlideshow(selectedSlideshow.id, { name: slideshowRename.trim() }); }}>
                <input value={slideshowRename} onChange={(event) => setSlideshowRename(event.target.value)} placeholder={t("gallery:slideshows.namePlaceholder")} autoFocus maxLength={120} />
                <Button variant="primary" compact type="submit" disabled={!slideshowRename.trim()}>{t("gallery:common.save")}</Button>
                <Button variant="icon" onClick={() => setSlideshowRename(null)} aria-label={t("common:common.cancel")}><X size={14} aria-hidden="true" /></Button>
              </form>
            )}
            <p className="gallery-album-sub">
              {t("gallery:common.counts.photo", { count: slideshowTotal })}
            </p>
            <GallerySetTags
              endpoint={`/api/library/gallery/slideshows/${selectedSlideshow.id}/tags`}
              tags={selectedSlideshow.tags}
              canEdit={selectedSlideshow.canEdit}
              onSaved={(tags) => setSelectedSlideshow({ ...selectedSlideshow, tags })}
            />
          </div>
        </div>

        <GallerySlideshowEditor
          slideshow={selectedSlideshow}
          assets={slideshowAssets}
          total={slideshowTotal}
          loading={loading}
          canEdit={selectedSlideshow.canEdit}
          onOpenAt={(index) => openLightbox("slideshow", index)}
          onLoadMore={() => void openSlideshow(selectedSlideshow.id, slideshowAssets.length)}
          onReorder={(ids) => void reorderSlideshow(selectedSlideshow.id, ids)}
          onRemove={(id) => void removeFromSlideshow(selectedSlideshow.id, id)}
          onPatch={(fields) => patchSlideshow(selectedSlideshow.id, fields)}
          onRender={() => void renderSlideshowMovie(selectedSlideshow.id)}
          onOpenMovieLibrary={onOpenMovieLibrary}
          onDeleteMovie={() => setMovieDeleteOpen(true)}
        />

        <RelatedStories entityType="gallery_slideshow" entityId={selectedSlideshow.id} />
        <NotesSection entityType="gallery_slideshow" entityId={selectedSlideshow.id} />
      </>
    );
  }

  return (
    <>
      {/* Suggestions are slideshows you don't have yet, so they are
          not something a search of your own can match — they step
          aside while the box has a term in it. Ahead of your own
          slideshows: it's the "make something new" prompt, and a
          single scrollable row (the fetch itself is capped) keeps
          it from pushing your actual list below the fold. */}
      {memorySuggestions.length > 0 && !nameTerm && (
        <section className="gallery-memory-suggestions" aria-label={t("gallery:suggestions.heading")}>
          <div className="gallery-memory-suggestions-head">
            <h2>{t("gallery:suggestions.heading")}</h2>
            <Button
              variant="secondary" compact
              onClick={() => { const pick = memorySuggestions[Math.floor(Math.random() * memorySuggestions.length)]; if (pick) void openSuggestionPreview(pick); }}
            >
              <Sparkles size={15} aria-hidden="true" /> {t("gallery:suggestions.surpriseMe")}
            </Button>
          </div>
          <div className="gallery-suggestion-row">
            {memorySuggestions.map((memory) => (
              <Button
                variant="tile"
                key={memory.id}
                className="gallery-folder-tile gallery-memory-tile"
                onClick={() => void openSuggestionPreview(memory)}
                title={t("gallery:suggestions.previewTitle", { title: memory.title })}
              >
                <span className="gallery-folder-thumb">
                  {memory.coverUrl ? <img src={memory.coverUrl} alt="" loading="lazy" /> : <Sparkles size={28} aria-hidden="true" />}
                  <span className="gallery-memory-play" aria-hidden="true"><Play size={20} /></span>
                </span>
                <strong>{memory.title}</strong>
                <small>{memory.subtitle}</small>
              </Button>
            ))}
          </div>
        </section>
      )}

      {shownSlideshows.length > 0 && (
        <>
          {memorySuggestions.length > 0 && !nameTerm && <h2 className="gallery-memories-title">{t("gallery:slideshows.yourSlideshowsHeading")}</h2>}
          <div className="gallery-folder-grid">
            {shownSlideshows.map((slideshow) => (
              <Button variant="tile" key={slideshow.id} className="gallery-folder-tile" onClick={() => { setSlideshowAssets([]); setSlideshowTotal(0); void openSlideshow(slideshow.id); }}>
                <span className="gallery-folder-thumb">
                  {slideshow.coverUrl ? <img src={slideshow.coverUrl} alt="" loading="lazy" /> : <Film size={28} aria-hidden="true" />}
                  {slideshow.renderStatus === "ready" && <span className="slideshow-card-badge ready" title={t("gallery:slideshows.movieBadgeTitle")}><Play size={11} aria-hidden="true" />{t("gallery:slideshows.movieBadge")}</span>}
                  {(slideshow.renderStatus === "rendering" || slideshow.renderStatus === "queued") && <span className="slideshow-card-badge busy" title={t("gallery:slideshows.renderingBadgeTitle")}>{t("gallery:slideshows.renderingBadge")}</span>}
                </span>
                <strong>{slideshow.name}</strong>
                <small>{t("gallery:common.counts.photo", { count: slideshow.itemCount })}</small>
              </Button>
            ))}
          </div>
        </>
      )}

      {!loading && slideshows.length > 0 && shownSlideshows.length === 0 && (
        <div className="empty-state library-empty">
          <Film size={48} aria-hidden="true" />
          <h2>{t("gallery:slideshows.noMatchTitle")}</h2>
        </div>
      )}
      {!loading && slideshows.length === 0 && memorySuggestions.length === 0 && (
        <div className="empty-state library-empty">
          <Film size={48} aria-hidden="true" />
          <h2>{t("gallery:slideshows.emptyTitle")}</h2>
          <p className="muted">
            {t("gallery:slideshows.emptyBody")}
          </p>
        </div>
      )}
    </>
  );
}
