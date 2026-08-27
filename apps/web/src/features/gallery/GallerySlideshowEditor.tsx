import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Download, Film, GripVertical, Heart, Image as ImageIcon, Music, Play, RefreshCw, Trash2, Type, X } from "lucide-react";
import { MusicPicker } from "./MusicPicker";
import { SlideshowTitleCardModal } from "./SlideshowTitleCardModal";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatBytes } from "../../shared/utils";
import type { GalleryAsset, GalleryLibrary, GallerySlideshowDetail, SlideshowPatch, SlideshowTransition } from "./types";
import { faceFocusStyle } from "./types";

// The presentation transitions offered in the editor, in display order. The live
// preview (GalleryLightbox) honours these; the future MP4 render will too.

// Slideshow detail + editor. Read-only viewers get the ordered grid and a Play
// button; editors additionally get drag-reorder (with ‹/› fallbacks for touch/
// keyboard), per-photo remove, a transition picker, and a per-slide duration.
// Order/settings changes are optimistic — the parent persists and refreshes.
export function GallerySlideshowEditor({
  slideshow,
  assets,
  total,
  loading,
  canEdit,
  onOpenAt,
  onPlay,
  onLoadMore,
  onReorder,
  onRemove,
  onPatch,
  onRender,
  onDeleteMovie
}: {
  slideshow: GallerySlideshowDetail;
  assets: GalleryAsset[];
  total: number;
  loading: boolean;
  canEdit: boolean;
  onOpenAt: (index: number) => void;
  onPlay: () => void;
  onLoadMore: () => void;
  onReorder: (orderedIds: string[]) => void;
  onRemove: (id: string) => void;
  onPatch: (fields: SlideshowPatch) => Promise<void> | void;
  onRender: () => void;
  onDeleteMovie: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);

  // What the "Title card" button says the card is, without opening it. Deliberately
  // the two things a glance wants: what it sits on, and how long it holds.
  const TITLE_BACKGROUND_LABELS: Record<GallerySlideshowDetail["titleBackground"], string> = {
    black: t("gallery:slideshowEditor.bgBlack"),
    photo: t("gallery:slideshowEditor.bgPhoto"),
    blur: t("gallery:slideshowEditor.bgBlurredPhoto"),
    collage: t("gallery:slideshowEditor.bgCollage")
  };

  const TRANSITIONS: { value: SlideshowTransition; label: string }[] = [
    { value: "crossfade", label: t("gallery:slideshowEditor.transitionCrossfade") },
    { value: "fade", label: t("gallery:slideshowEditor.transitionFade") },
    { value: "slide", label: t("gallery:slideshowEditor.transitionSlide") },
    { value: "kenburns", label: t("gallery:slideshowEditor.transitionKenBurns") },
    { value: "dipblack", label: t("gallery:slideshowEditor.transitionDipBlack") },
    { value: "random", label: t("gallery:slideshowEditor.transitionRandom") },
    { value: "none", label: t("gallery:slideshowEditor.transitionNone") }
  ];

  const [musicOpen, setMusicOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  // Rendering is the heaviest thing this app asks of the machine it runs on, and it
  // is usually somebody's NAS. Nothing starts until this is answered.
  const [renderConfirm, setRenderConfirm] = useState(false);
  // Local working order of item ids. Authoritative while dragging; otherwise it
  // re-syncs from the server-ordered `assets` after every add/remove/reorder.
  const [order, setOrder] = useState<string[]>(() => assets.map((a) => a.id));
  const [dragActive, setDragActive] = useState(false);
  const draggingId = useRef<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    if (dragActive) return;
    setOrder(assets.map((a) => a.id));
  }, [assets, dragActive]);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((a): a is GalleryAsset => Boolean(a)),
    [order, byId]
  );

  // Roughly how long the finished movie runs: the title card, then a slide apiece.
  // Per-slide overrides and video clips make this approximate, which is why it's
  // only ever shown as "about".
  const titleSeconds = (slideshow.titleEnabled ? slideshow.titleSeconds : 0)
    + (slideshow.closingEnabled ? slideshow.closingSeconds : 0);
  const movieMinutes = Math.max(1, Math.round((titleSeconds + ordered.length * slideshow.slideSeconds) / 60));

  // Per-slide seconds: local for a smooth slider, committed on release so a drag
  // isn't a burst of PATCHes.
  const [dwell, setDwell] = useState(slideshow.slideSeconds);
  useEffect(() => { setDwell(slideshow.slideSeconds); }, [slideshow.slideSeconds, slideshow.id]);

  // Transition length (seconds): same local-then-commit pattern as the dwell slider.
  const [transitionLen, setTransitionLen] = useState(slideshow.transitionSeconds);
  useEffect(() => { setTransitionLen(slideshow.transitionSeconds); }, [slideshow.transitionSeconds, slideshow.id]);

  const commitOrder = (next: string[]) => {
    setOrder(next);
    onReorder(next);
  };

  const move = (id: string, delta: number) => {
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    commitOrder(next);
  };

  // Live reordering as the pointer moves over another tile (visual only; the
  // server write happens once on drop/end).
  const dragOverTile = (targetId: string) => {
    const fromId = draggingId.current;
    if (!fromId || fromId === targetId) return;
    setOrder((prev) => {
      const from = prev.indexOf(fromId);
      const to = prev.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, fromId);
      return next;
    });
  };

  const endDrag = () => {
    if (draggingId.current) onReorder(orderRef.current);
    draggingId.current = null;
    setDragActive(false);
  };

  const remaining = total - ordered.length;

  return (
    <>
      {canEdit && ordered.length > 0 && (
        <div className="slideshow-settings" role="group" aria-label={t("gallery:slideshowEditor.settingsAria")}>
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">{t("gallery:slideshowEditor.transitionLabel")}</span>
            <div className="slideshow-transitions">
              {TRANSITIONS.map((tr) => (
                <button
                  key={tr.value}
                  type="button"
                  className={slideshow.transition === tr.value ? "is-on" : ""}
                  aria-pressed={slideshow.transition === tr.value}
                  onClick={() => { if (slideshow.transition !== tr.value) onPatch({ transition: tr.value }); }}
                >
                  {tr.label}
                </button>
              ))}
            </div>
          </div>
          <div className="slideshow-setting">
            <label className="slideshow-setting-label" htmlFor="slideshow-dwell">{t("gallery:slideshowEditor.secondsPerPhotoLabel")}</label>
            <div className="slideshow-dwell">
              <input
                id="slideshow-dwell"
                type="range"
                min={1}
                max={20}
                step={1}
                value={dwell}
                onChange={(e) => setDwell(Number(e.target.value))}
                onPointerUp={() => { if (dwell !== slideshow.slideSeconds) onPatch({ slideSeconds: dwell }); }}
                onKeyUp={() => { if (dwell !== slideshow.slideSeconds) onPatch({ slideSeconds: dwell }); }}
              />
              <span className="slideshow-dwell-value">{dwell}s</span>
            </div>
          </div>
          {slideshow.transition !== "none" && (
            <div className="slideshow-setting">
              <label className="slideshow-setting-label" htmlFor="slideshow-transition-len">{t("gallery:slideshowEditor.transitionLengthLabel")}</label>
              <div className="slideshow-dwell">
                <input
                  id="slideshow-transition-len"
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={transitionLen}
                  onChange={(e) => setTransitionLen(Number(e.target.value))}
                  onPointerUp={() => { if (transitionLen !== slideshow.transitionSeconds) onPatch({ transitionSeconds: transitionLen }); }}
                  onKeyUp={() => { if (transitionLen !== slideshow.transitionSeconds) onPatch({ transitionSeconds: transitionLen }); }}
                />
                <span className="slideshow-dwell-value">{transitionLen}s</span>
              </div>
            </div>
          )}
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">{t("gallery:slideshowEditor.musicLabel")}</span>
            <button type="button" className="slideshow-music-button" onClick={() => setMusicOpen(true)}>
              <Music size={15} aria-hidden="true" />
              <span>{slideshow.musicTitle ?? t("gallery:slideshowEditor.addMusic")}</span>
            </button>
          </div>
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">{t("gallery:slideshowEditor.titleCreditsLabel")}</span>
            <button type="button" className="slideshow-music-button" onClick={() => setTitleOpen(true)}>
              <Type size={15} aria-hidden="true" />
              <span>
                {slideshow.titleEnabled
                  ? t("gallery:slideshowEditor.titleSummary", { bg: TITLE_BACKGROUND_LABELS[slideshow.titleBackground], sec: slideshow.titleSeconds })
                  : t("gallery:slideshowEditor.titleOff")}
                {slideshow.closingEnabled ? t("gallery:slideshowEditor.plusClosing") : ""}
              </span>
            </button>
          </div>
        </div>
      )}

      {musicOpen && (
        <MusicPicker
          selectedId={slideshow.musicTrackId}
          onSelect={(trackId) => { onPatch({ musicTrackId: trackId }); }}
          onClose={() => setMusicOpen(false)}
        />
      )}

      {titleOpen && (
        <SlideshowTitleCardModal
          slideshow={slideshow}
          assets={ordered}
          onPatch={onPatch}
          onClose={() => setTitleOpen(false)}
        />
      )}

      {/* Rendering re-encodes every photo into video: minutes of work and hundreds of
          megabytes of memory on a machine that is usually also serving the family's
          films. Worth one question and some real numbers before it starts. */}
      {renderConfirm && (
        <ConfirmDialog
          title={slideshow.renderStatus === "ready" ? t("gallery:slideshowEditor.rerenderConfirmTitle") : t("gallery:slideshowEditor.renderConfirmTitle")}
          confirmLabel={slideshow.renderStatus === "ready" ? t("gallery:slideshowEditor.rerenderConfirmLabel") : t("gallery:slideshowEditor.renderConfirmLabel")}
          confirmIcon={<Film size={15} aria-hidden="true" />}
          onConfirm={() => { setRenderConfirm(false); onRender(); }}
          onCancel={() => setRenderConfirm(false)}
          rich
        >
          <p>
            {t("gallery:slideshowEditor.renderConfirmBody1", {
              photos: t("gallery:common.counts.photo", { count: ordered.length }),
              minutes: t("gallery:slideshowEditor.minutes", { count: movieMinutes })
            })}
          </p>
          <p>{t("gallery:slideshowEditor.renderConfirmBody2")}</p>
          <p>{t("gallery:slideshowEditor.renderConfirmBody3")}</p>
        </ConfirmDialog>
      )}

      {/* Movie: render an MP4, then watch/download it. Non-editors see only a ready
          movie; editors get the Render/Re-render controls and progress. */}
      {ordered.length > 0 && (slideshow.renderStatus !== "draft" || canEdit) && (
        <div className="slideshow-movie">
          {slideshow.renderStatus === "ready" && slideshow.movieUrl ? (
            <>
              <div className="slideshow-movie-head">
                <h3>{t("gallery:slideshowEditor.movieHeading")}{slideshow.outputBytes != null ? <span className="muted"> · {formatBytes(slideshow.outputBytes)}</span> : null}</h3>
                <div className="slideshow-movie-actions">
                  <a className="secondary-button compact-button" href={`${slideshow.movieUrl}&download`} download>
                    <Download size={15} aria-hidden="true" /> {t("gallery:common.download")}
                  </a>
                  {canEdit && (
                    <button type="button" className="secondary-button compact-button" onClick={() => setRenderConfirm(true)}>
                      <RefreshCw size={15} aria-hidden="true" /> {t("gallery:slideshowEditor.rerenderButton")}
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="secondary-button compact-button" onClick={onDeleteMovie}>
                      <Trash2 size={15} aria-hidden="true" /> {t("gallery:common.deleteWord")}
                    </button>
                  )}
                </div>
              </div>
              {canEdit && slideshow.renderStale && (
                <MessageBox tone="warning" title={t("gallery:slideshowEditor.staleTitle")}>
                  {t("gallery:slideshowEditor.staleBody")}
                </MessageBox>
              )}
              <video className="slideshow-movie-video" controls src={slideshow.movieUrl} />
            </>
          ) : slideshow.renderStatus === "queued" || slideshow.renderStatus === "rendering" ? (
            <div className="slideshow-movie-progress" role="status">
              <Film size={16} aria-hidden="true" />
              <span>{slideshow.renderStatus === "queued" ? t("gallery:slideshowEditor.queued") : t("gallery:slideshowEditor.rendering", { percent: slideshow.renderPercent ?? 0 })}</span>
              <div className="slideshow-progress-track">
                <div className="slideshow-progress-fill" style={{ width: `${slideshow.renderPercent ?? (slideshow.renderStatus === "queued" ? 3 : 6)}%` }} />
              </div>
              <span className="muted gallery-face-hint">
                {t("gallery:slideshowEditor.renderingHint")}
              </span>
            </div>
          ) : canEdit ? (
            <div className="slideshow-movie-cta">
              {slideshow.renderStatus === "failed" && (
                <MessageBox tone="error" title={t("gallery:slideshowEditor.renderFailedTitle")}>{slideshow.renderError || t("gallery:slideshowEditor.renderFailedBody")}</MessageBox>
              )}
              <div className="slideshow-movie-cta-row">
                <button type="button" className="primary-button compact-button" onClick={() => setRenderConfirm(true)}>
                  <Film size={15} aria-hidden="true" /> {slideshow.renderStatus === "failed" ? t("gallery:slideshowEditor.tryAgain") : t("gallery:slideshowEditor.renderConfirmLabel")}
                </button>
                <span className="muted gallery-face-hint">
                  {t("gallery:slideshowEditor.exportHintBase", { musicClause: slideshow.musicTitle ? t("gallery:slideshowEditor.musicClause") : "" })}{" "}
                  {slideshow.titleEnabled ? t("gallery:slideshowEditor.titleClauseOn") : t("gallery:slideshowEditor.titleClauseOff")}{" "}
                  {t("gallery:slideshowEditor.exportHintTail")}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className={`gallery-grid slideshow-editor-grid${canEdit ? " is-editable" : ""}`}>
        {ordered.map((asset, index) => (
          <div
            key={asset.id}
            className={`gallery-tile-wrap slideshow-slide${dragActive && draggingId.current === asset.id ? " dragging" : ""}`}
            draggable={canEdit}
            onDragStart={(e) => { draggingId.current = asset.id; setDragActive(true); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { if (draggingId.current) { e.preventDefault(); dragOverTile(asset.id); } }}
            onDrop={(e) => { e.preventDefault(); endDrag(); }}
            onDragEnd={endDrag}
          >
            <span className="slideshow-slide-num" aria-hidden="true">{index + 1}</span>
            <button
              type="button"
              className="gallery-tile"
              onClick={() => onOpenAt(index)}
              aria-label={t("gallery:assetTile.openAria", { title: asset.title })}
            >
              {asset.coverUrl ? (
                <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} />
              ) : (
                <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
              )}
              {asset.saved && <Heart size={14} className="gallery-like-dot" fill="currentColor" aria-hidden="true" />}
              {asset.kind === "video" && (
                asset.playable === false ? (
                  <span className="gallery-video-badge unplayable" title={t("gallery:assetTile.unplayableTitle")}>
                    <Download size={11} aria-hidden="true" />{t("gallery:common.video")}
                  </span>
                ) : (
                  <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("gallery:common.video")}</span>
                )
              )}
            </button>
            {canEdit && (
              <>
                <span className="slideshow-drag-handle" aria-hidden="true" title={t("gallery:slideshowEditor.dragHandleTitle")}><GripVertical size={15} /></span>
                <div className="slideshow-slide-move">
                  <button type="button" onClick={() => move(asset.id, -1)} disabled={index === 0} aria-label={t("gallery:slideshowEditor.moveEarlierAria", { title: asset.title })} title={t("gallery:slideshowEditor.moveEarlierTitle")}>
                    <ChevronLeft size={15} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => move(asset.id, 1)} disabled={index === ordered.length - 1} aria-label={t("gallery:slideshowEditor.moveLaterAria", { title: asset.title })} title={t("gallery:slideshowEditor.moveLaterTitle")}>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  className="gallery-tile-remove"
                  onClick={() => onRemove(asset.id)}
                  aria-label={t("gallery:assetTile.removeAria", { title: asset.title })}
                  title={t("gallery:slideshowEditor.removeFromSlideshowTitle")}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {!loading && ordered.length === 0 && (
        <p className="management-empty">
          {t("gallery:slideshowEditor.emptyBody")}
        </p>
      )}

      {remaining > 0 && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loading}>
            {loading ? t("gallery:common.loading") : t("gallery:common.loadMoreCount", { count: remaining })}
          </button>
        </div>
      )}
    </>
  );
}
