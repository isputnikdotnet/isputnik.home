import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Film, GripVertical, Heart, Image as ImageIcon, Music, Play, RefreshCw, X } from "lucide-react";
import { MusicPicker } from "./MusicPicker";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import type { GalleryAsset, GallerySlideshowDetail, SlideshowTransition } from "./types";

// The presentation transitions offered in the editor, in display order. The live
// preview (GalleryLightbox) honours these; the future MP4 render will too.
const TRANSITIONS: { value: SlideshowTransition; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "fade", label: "Fade" },
  { value: "slide", label: "Slide" },
  { value: "kenburns", label: "Ken Burns" },
  { value: "none", label: "None" }
];

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
  onRender
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
  onPatch: (fields: { transition?: SlideshowTransition; slideSeconds?: number; musicTrackId?: string | null }) => void;
  onRender: () => void;
}) {
  const [musicOpen, setMusicOpen] = useState(false);
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

  // Per-slide seconds: local for a smooth slider, committed on release so a drag
  // isn't a burst of PATCHes.
  const [dwell, setDwell] = useState(slideshow.slideSeconds);
  useEffect(() => { setDwell(slideshow.slideSeconds); }, [slideshow.slideSeconds, slideshow.id]);

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
          <div className="slideshow-setting">
            <span className="slideshow-setting-label">Music</span>
            <button type="button" className="slideshow-music-button" onClick={() => setMusicOpen(true)}>
              <Music size={15} aria-hidden="true" />
              <span>{slideshow.musicTitle ?? "Add music"}</span>
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
                    <button type="button" className="secondary-button compact-button" onClick={onRender}>
                      <RefreshCw size={15} aria-hidden="true" /> Re-render
                    </button>
                  )}
                </div>
              </div>
              <video className="slideshow-movie-video" controls src={slideshow.movieUrl} />
            </>
          ) : slideshow.renderStatus === "queued" || slideshow.renderStatus === "rendering" ? (
            <div className="slideshow-movie-progress" role="status">
              <Film size={16} aria-hidden="true" />
              <span>{slideshow.renderStatus === "queued" ? "Queued to render…" : `Rendering movie… ${slideshow.renderPercent ?? 0}%`}</span>
              <div className="slideshow-progress-track">
                <div className="slideshow-progress-fill" style={{ width: `${slideshow.renderPercent ?? (slideshow.renderStatus === "queued" ? 3 : 6)}%` }} />
              </div>
            </div>
          ) : canEdit ? (
            <div className="slideshow-movie-cta">
              {slideshow.renderStatus === "failed" && (
                <MessageBox tone="error" title="Render failed">{slideshow.renderError || "The movie couldn’t be encoded."}</MessageBox>
              )}
              <div className="slideshow-movie-cta-row">
                <button type="button" className="primary-button compact-button" onClick={onRender}>
                  <Film size={15} aria-hidden="true" /> {slideshow.renderStatus === "failed" ? "Try again" : "Render movie"}
                </button>
                <span className="muted gallery-face-hint">
                  Export a downloadable MP4 of your photos, transitions{slideshow.musicTitle ? ", and music" : ""}. Videos are skipped, and Ken Burns exports as a crossfade.
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
                <img src={asset.coverUrl} alt="" loading="lazy" />
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
          This slideshow is empty. Select photos in the Timeline and use “Add to slideshow”.
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
