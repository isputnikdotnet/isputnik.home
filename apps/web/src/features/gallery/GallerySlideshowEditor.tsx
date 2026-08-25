import { useEffect, useMemo, useRef, useState } from "react";
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
// What the "Title card" button says the card is, without opening it. Deliberately the
// two things a glance wants: what it sits on, and how long it holds.
const TITLE_BACKGROUND_LABELS: Record<GallerySlideshowDetail["titleBackground"], string> = {
  black: "Black",
  photo: "Photo",
  blur: "Blurred photo",
  collage: "Collage"
};

const TRANSITIONS: { value: SlideshowTransition; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "fade", label: "Fade" },
  { value: "slide", label: "Slide" },
  { value: "kenburns", label: "Ken Burns" },
  { value: "dipblack", label: "Dip to black" },
  { value: "random", label: "Random" },
  { value: "none", label: "None" }
];

// Slideshow detail + editor. Read-only viewers get the ordered grid and a Play
// button; editors additionally get drag-reorder (with ‹/› fallbacks for touch/
// keyboard), per-photo remove, a transition picker, and a per-slide duration.
// Order/settings changes are optimistic — the parent persists and refreshes.
export function GallerySlideshowEditor({
  slideshow,
  assets,
  libraries,
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
  /** For the Title & credits dialog's clip picker. */
  libraries: GalleryLibrary[];
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
        <div className="slideshow-settings" role="group" aria-label="Slideshow settings">
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">Transition</span>
            <div className="slideshow-transitions">
              {TRANSITIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={slideshow.transition === t.value ? "is-on" : ""}
                  aria-pressed={slideshow.transition === t.value}
                  onClick={() => { if (slideshow.transition !== t.value) onPatch({ transition: t.value }); }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="slideshow-setting">
            <label className="slideshow-setting-label" htmlFor="slideshow-dwell">Seconds per photo</label>
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
              <label className="slideshow-setting-label" htmlFor="slideshow-transition-len">Transition length</label>
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
            <span className="slideshow-setting-label">Music</span>
            <button type="button" className="slideshow-music-button" onClick={() => setMusicOpen(true)}>
              <Music size={15} aria-hidden="true" />
              <span>{slideshow.musicTitle ?? "Add music"}</span>
            </button>
          </div>
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">Title &amp; credits</span>
            <button type="button" className="slideshow-music-button" onClick={() => setTitleOpen(true)}>
              <Type size={15} aria-hidden="true" />
              <span>
                {slideshow.titleEnabled
                  ? `${TITLE_BACKGROUND_LABELS[slideshow.titleBackground]} · ${slideshow.titleSeconds}s`
                  : "Off"}
                {slideshow.closingEnabled ? " + closing" : ""}
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
          libraries={libraries}
          onPatch={onPatch}
          onClose={() => setTitleOpen(false)}
        />
      )}

      {/* Rendering re-encodes every photo into video: minutes of work and hundreds of
          megabytes of memory on a machine that is usually also serving the family's
          films. Worth one question and some real numbers before it starts. */}
      {renderConfirm && (
        <ConfirmDialog
          title={slideshow.renderStatus === "ready" ? "Re-render this movie?" : "Render this movie?"}
          confirmLabel={slideshow.renderStatus === "ready" ? "Re-render movie" : "Render movie"}
          confirmIcon={<Film size={15} aria-hidden="true" />}
          onConfirm={() => { setRenderConfirm(false); onRender(); }}
          onCancel={() => setRenderConfirm(false)}
          rich
        >
          <p>
            {ordered.length} {ordered.length === 1 ? "photo" : "photos"} becomes about {movieMinutes} minute
            {movieMinutes === 1 ? "" : "s"} of video. Every one is re-encoded frame by frame, which is the
            heaviest thing this server does.
          </p>
          <p>
            Expect several minutes, and longer on a small machine. It runs at low priority in the background —
            you can leave this page — but the rest of the server may feel slower while it works.
          </p>
          <p>
            Nothing is changed until it finishes, and you can stop it at any time from the control panel’s
            Tasks page.
          </p>
        </ConfirmDialog>
      )}

      {/* Movie: render an MP4, then watch/download it. Non-editors see only a ready
          movie; editors get the Render/Re-render controls and progress. */}
      {ordered.length > 0 && (slideshow.renderStatus !== "draft" || canEdit) && (
        <div className="slideshow-movie">
          {slideshow.renderStatus === "ready" && slideshow.movieUrl ? (
            <>
              <div className="slideshow-movie-head">
                <h3>Movie{slideshow.outputBytes != null ? <span className="muted"> · {formatBytes(slideshow.outputBytes)}</span> : null}</h3>
                <div className="slideshow-movie-actions">
                  <a className="secondary-button compact-button" href={`${slideshow.movieUrl}&download`} download>
                    <Download size={15} aria-hidden="true" /> Download
                  </a>
                  {canEdit && (
                    <button type="button" className="secondary-button compact-button" onClick={() => setRenderConfirm(true)}>
                      <RefreshCw size={15} aria-hidden="true" /> Re-render
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="secondary-button compact-button" onClick={onDeleteMovie}>
                      <Trash2 size={15} aria-hidden="true" /> Delete
                    </button>
                  )}
                </div>
              </div>
              {canEdit && slideshow.renderStale && (
                <MessageBox tone="warning" title="Movie is out of date">
                  This movie doesn’t include your latest changes. Re-render to update it.
                </MessageBox>
              )}
              <video className="slideshow-movie-video" controls src={slideshow.movieUrl} />
            </>
          ) : slideshow.renderStatus === "queued" || slideshow.renderStatus === "rendering" ? (
            <div className="slideshow-movie-progress" role="status">
              <Film size={16} aria-hidden="true" />
              <span>{slideshow.renderStatus === "queued" ? "Queued to render…" : `Rendering movie… ${slideshow.renderPercent ?? 0}%`}</span>
              <div className="slideshow-progress-track">
                <div className="slideshow-progress-fill" style={{ width: `${slideshow.renderPercent ?? (slideshow.renderStatus === "queued" ? 3 : 6)}%` }} />
              </div>
              <span className="muted gallery-face-hint">
                Rendering runs in the background and can take a few minutes — you can leave this page and come back.
                The server is working hard while this runs, so everything else on it may feel slower; you can stop it
                from the control panel’s Tasks page.
              </span>
            </div>
          ) : canEdit ? (
            <div className="slideshow-movie-cta">
              {slideshow.renderStatus === "failed" && (
                <MessageBox tone="error" title="Render failed">{slideshow.renderError || "The movie couldn’t be encoded."}</MessageBox>
              )}
              <div className="slideshow-movie-cta-row">
                <button type="button" className="primary-button compact-button" onClick={() => setRenderConfirm(true)}>
                  <Film size={15} aria-hidden="true" /> {slideshow.renderStatus === "failed" ? "Try again" : "Render movie"}
                </button>
                <span className="muted gallery-face-hint">
                  Export a downloadable MP4 of your photos and videos, transitions{slideshow.musicTitle ? ", and music" : ""}. {slideshow.titleEnabled ? "The movie opens with the title card set above — its words, its length, and whether it sits on black, a photo, or a collage." : "There is no title card, so the movie opens straight on the first photo."} Rendering runs in the background and can take a few minutes for a large slideshow. Ken Burns exports as a crossfade, and Random varies the transition at every cut. When a default movie library is set, the finished movie is also saved to your gallery.
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
              aria-label={`Open ${asset.title}`}
            >
              {asset.coverUrl ? (
                <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} />
              ) : (
                <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
              )}
              {asset.saved && <Heart size={14} className="gallery-fav-dot" fill="currentColor" aria-hidden="true" />}
              {asset.kind === "video" && (
                asset.playable === false ? (
                  <span className="gallery-video-badge unplayable" title="Can’t play in browser — download to view">
                    <Download size={11} aria-hidden="true" />Video
                  </span>
                ) : (
                  <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
                )
              )}
            </button>
            {canEdit && (
              <>
                <span className="slideshow-drag-handle" aria-hidden="true" title="Drag to reorder"><GripVertical size={15} /></span>
                <div className="slideshow-slide-move">
                  <button type="button" onClick={() => move(asset.id, -1)} disabled={index === 0} aria-label={`Move ${asset.title} earlier`} title="Move earlier">
                    <ChevronLeft size={15} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => move(asset.id, 1)} disabled={index === ordered.length - 1} aria-label={`Move ${asset.title} later`} title="Move later">
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  className="gallery-tile-remove"
                  onClick={() => onRemove(asset.id)}
                  aria-label={`Remove ${asset.title}`}
                  title="Remove from this slideshow"
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
          This slideshow is empty. Use “Add photos” above to browse your galleries by folder, or select photos in the Timeline and use “Add to slideshow”.
        </p>
      )}

      {remaining > 0 && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : `Load more (${remaining})`}
          </button>
        </div>
      )}
    </>
  );
}
