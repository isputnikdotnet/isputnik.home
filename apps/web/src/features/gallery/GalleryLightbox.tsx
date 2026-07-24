import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, Heart, ImagePlus, Info, ListMusic, Pause, Pencil, Play, Plus, RotateCcw, RotateCw, Share2, Trash2, X } from "lucide-react";
import { api } from "../../api";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { AddToAlbumModal } from "./AddToAlbumModal";
import { ShareModal } from "../share/ShareModal";
import type { GalleryAsset, GalleryPerson, GalleryPersonTag, SlideshowTransition } from "./types";

// Leaflet rides in only when the Info panel shows a geotagged photo — keeps it off
// the initial bundle (and reuses the same chunk as the gallery Map view).
const GalleryMiniMap = lazy(() => import("./GalleryMiniMap").then((m) => ({ default: m.GalleryMiniMap })));
const GalleryLocationPicker = lazy(() => import("./GalleryLocationPicker").then((m) => ({ default: m.GalleryLocationPicker })));

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Uppercase file extension (e.g. "MVI_1263.AVI" → "AVI") for the unplayable notice.
function formatLabel(title: string): string {
  const dot = title.lastIndexOf(".");
  return dot > 0 && dot < title.length - 1 ? title.slice(dot + 1).toUpperCase() : "";
}

function formatTaken(takenAt: string | null): string {
  if (!takenAt) return "";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ISO → value for <input type="datetime-local"> (local wall-clock, minute precision).
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Fields editable inline in the Info panel ("gps" opens the map picker). The name
// and technical fields (dimensions, size, camera) stay read-only.
type EditableField = "description" | "takenAt" | "tags" | "gps";

// Slideshow dwell options (seconds a photo shows before advancing). A video ignores
// these and advances when it finishes playing.
const SLIDESHOW_INTERVALS = [3, 5, 10] as const;
// The styles a "random" slideshow draws from — one is re-rolled on every slide change.
const RANDOM_TRANSITIONS: SlideshowTransition[] = ["crossfade", "fade", "slide", "kenburns"];
// Remembered for the browsing session (module scope survives navigation, resets on
// reload) so the speed choice sticks across slideshows without persisting to disk.
let sessionSlideshowInterval = 5;

// Full-screen photo/video viewer with keyboard navigation. Renders into a portal
// over the whole app (not a shared/Modal — a media lightbox is full-bleed and owns
// its own chrome). Per-asset actions act on the current item.
export function GalleryLightbox({
  assets,
  index,
  onClose,
  onIndexChange,
  onChanged,
  onOpenFolder,
  canDelete,
  canEdit,
  canShare,
  autoPlay = false,
  transition,
  transitionSeconds,
  initialInterval,
  musicUrl
}: {
  assets: GalleryAsset[];
  index: number;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  onChanged: () => void;
  // When set, the Info panel's Folder entry becomes a link that closes the
  // lightbox and opens that folder in the gallery's Folders view.
  onOpenFolder?: (folder: string) => void;
  canDelete: boolean;
  canEdit: boolean;
  canShare: boolean;
  // Start a slideshow immediately (opened via the gallery's Slideshow button).
  autoPlay?: boolean;
  // Presentation settings when previewing a saved slideshow: the transition style
  // to animate each slide with, and the initial per-photo dwell (seconds). Absent
  // for the ad-hoc slideshow of a plain view (timeline/album/…), which uses the
  // default crossfade and the session-remembered speed.
  transition?: SlideshowTransition;
  // Cross-fade length in seconds for playback animations (a saved slideshow's
  // transitionSeconds); absent → the 2s default, matching the movie render.
  transitionSeconds?: number;
  initialInterval?: number;
  // A saved slideshow's music track (streaming URL). Plays looped while the
  // slideshow runs; absent for ad-hoc slideshows and single-photo viewing.
  musicUrl?: string;
}) {
  const asset = assets[index];
  // The Info panel opens with the photo — details are part of viewing, not an extra.
  // A slideshow starts immersive, though: no side panel eating the frame.
  const [showInfo, setShowInfo] = useState(!autoPlay);
  // Slideshow: auto-advances through `assets`, looping past the last item. Videos
  // ignore the dwell timer and advance when they finish (see the <video> onEnded).
  const [playing, setPlaying] = useState(autoPlay);
  const [intervalSec, setIntervalSec] = useState(initialInterval ?? sessionSlideshowInterval);
  // A saved slideshow drives the transition; every other view uses the default.
  const slideTransition: SlideshowTransition = transition ?? "crossfade";
  const transitionSec = transitionSeconds ?? 2;
  // The transition applied to the CURRENT slide: "random" re-rolls a style on every
  // slide change (keyed on asset.id); fixed styles pass straight through.
  const activeTransition = useMemo<SlideshowTransition>(
    () => slideTransition === "random"
      ? RANDOM_TRANSITIONS[Math.floor(Math.random() * RANDOM_TRANSITIONS.length)]
      : slideTransition,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slideTransition, asset?.id]
  );
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const canSlideshow = assets.length > 1;
  // Inline field editing in the Info panel (one field at a time).
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [editValue, setEditValue] = useState("");
  // The point picked on the location editor's map (separate from the text fields).
  const [editGps, setEditGps] = useState<{ lat: number; lng: number } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [fav, setFav] = useState(asset?.saved ?? false);
  const [favBusy, setFavBusy] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  // Set when the browser's <video> can't decode this asset (unsupported container/
  // codec — legacy AVI/Motion-JPEG, WMV, etc.). We serve originals untranscoded, so
  // a plain <video> silently stalls; this drives an explanatory fallback instead.
  // Seeded from the scanner's `playable` flag so a known-bad file skips the doomed
  // load attempt; the <video> onError still catches anything the scan couldn't probe.
  const [videoError, setVideoError] = useState(asset?.playable === false);

  // People tagged in this asset. The list/timeline rows don't carry `people`, so when
  // it's absent we fetch the asset detail. `allPeople` feeds the add-box suggestions.
  const [people, setPeople] = useState<GalleryPersonTag[]>(asset?.people ?? []);
  const [allPeople, setAllPeople] = useState<GalleryPerson[]>([]);
  const [addingPerson, setAddingPerson] = useState(false);
  const [personName, setPersonName] = useState("");
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState("");

  useEffect(() => { setFav(asset?.saved ?? false); }, [asset?.id, asset?.saved]);
  // Each asset gets a fresh playback attempt — but a known-unplayable one goes
  // straight to the fallback instead of stalling on a load that will fail.
  useEffect(() => { setVideoError(asset?.playable === false); }, [asset?.id, asset?.playable]);

  // Moving to another asset abandons any in-progress field edit.
  useEffect(() => { setEditingField(null); setEditError(""); }, [asset?.id]);

  // Load the current asset's people (from the detail endpoint when the row lacks them).
  useEffect(() => {
    if (!asset) return;
    setAddingPerson(false);
    setPersonName("");
    setPersonError("");
    if (asset.people) { setPeople(asset.people); return; }
    let alive = true;
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${asset.id}`)
      .then((p) => { if (alive) setPeople(p.asset.people ?? []); })
      .catch(() => { /* keep whatever we have */ });
    return () => { alive = false; };
  }, [asset?.id, asset?.people, asset]);

  // Suggestions for the add-box: the existing people, refreshed after each change so a
  // freshly-created person becomes selectable.
  useEffect(() => {
    if (!showInfo || !canEdit) return;
    let alive = true;
    api<{ people: GalleryPerson[] }>("/api/library/gallery/people")
      .then((p) => { if (alive) setAllPeople(p.people); })
      .catch(() => { /* suggestions are advisory */ });
    return () => { alive = false; };
  }, [showInfo, canEdit, people]);

  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  // Any open sub-dialog freezes the slideshow (a slide must not advance under a
  // confirm/share/collection modal). Also gates the keyboard handler below.
  const dialogOpen = collectionOpen || albumOpen || deleteOpen || shareOpen;

  // Advance to the next slide, wrapping from the last item back to the first so the
  // loop never stalls. Manual arrows/clicks reuse this at the ends too.
  const advance = () => { if (assets.length > 0) onIndexChange((index + 1) % assets.length); };

  // Keep the module-remembered speed in step with the picker.
  useEffect(() => { sessionSlideshowInterval = intervalSec; }, [intervalSec]);

  // Dwell timer. Photos advance after `intervalSec`; a playable video is skipped
  // here and advances from its own onEnded so it plays in full. An unplayable video
  // (videoError) has no end event, so it falls back to the timer like a photo.
  useEffect(() => {
    if (!playing || !canSlideshow || dialogOpen) return;
    if (asset?.kind === "video" && !videoError) return;
    const timer = window.setTimeout(advance, intervalSec * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, canSlideshow, dialogOpen, asset?.id, asset?.kind, videoError, intervalSec, index, assets.length]);

  // During playback, the outgoing photo stays rendered beneath the incoming slide so
  // the transition reads as a true cross-fade/wipe over the previous image — not a
  // fade from the dark stage. Photos only (a departing video just cuts); cleared once
  // the longest playback animation has finished. Layout effect, not a plain effect:
  // the underlay must be in the DOM before the browser paints the new (transparent)
  // slide, or every transition opens with a one-frame black flash.
  // `zoomed` carries the outgoing slide's held Ken Burns end-frame onto the underlay —
  // without it the photo snaps from scale(1.12) back to scale(1) the instant the
  // transition starts (the zoomed <img> is swapped for this un-zoomed copy). `dip`
  // marks a dip-to-black entrance: the underlay fades OUT to black (first half) while
  // the incoming slide waits, then fades in (second half) — not a crossfade.
  const [underlay, setUnderlay] = useState<{ id: string; src: string; zoomed: boolean; dip: boolean } | null>(null);
  const prevSlideRef = useRef<{ asset: GalleryAsset; transition: SlideshowTransition } | null>(null);
  useLayoutEffect(() => {
    const prev = prevSlideRef.current;
    const changed = prev?.asset.id !== asset?.id;
    prevSlideRef.current = asset ? { asset, transition: activeTransition } : null;
    if (!playing) { setUnderlay(null); return; }
    // Only a real slide change swaps the underlay — a re-run with the same asset
    // (StrictMode's dev double-invoke, a `playing` dep change) must leave it alone,
    // otherwise the second run clears the underlay the first one just set.
    if (changed) {
      const src = prev?.asset.kind === "photo" ? prev.asset.previewUrl ?? prev.asset.fileUrl : null;
      setUnderlay(prev && asset && src
        ? { id: prev.asset.id, src, zoomed: prev.transition === "kenburns", dip: activeTransition === "dipblack" }
        : null);
    }
    // (Re)arm the clear timer on every run: a double-invoke's cleanup cancels the
    // first run's timer, so the surviving run must always leave a live one. Lives a
    // beat past the transition so the animation always finishes over the old photo.
    const timer = window.setTimeout(() => setUnderlay(null), transitionSec * 1000 + 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, playing]);

  // Preload the next slide's image during the current dwell so the incoming <img>
  // decodes instantly at the cut — without this the fade can start over a photo the
  // browser is still fetching, which reads as a flash/pop mid-transition.
  useEffect(() => {
    if (!playing || !canSlideshow) return;
    const next = assets[(index + 1) % assets.length];
    if (!next || next.kind !== "photo") return;
    const src = next.previewUrl ?? next.fileUrl;
    if (!src) return;
    const img = new Image();
    img.src = src;
  }, [playing, canSlideshow, assets, index]);

  // Slideshow music: play the looped bed while the slideshow runs, pause when it
  // pauses or a sub-dialog opens. The initial play() rides the Play-button gesture,
  // so autoplay is allowed; a rejected promise (rare) is harmless.
  useEffect(() => {
    const audio = musicRef.current;
    if (!audio || !musicUrl) return;
    if (playing && !dialogOpen) void audio.play().catch(() => { /* autoplay blocked */ });
    else audio.pause();
  }, [playing, dialogOpen, musicUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen) return;
      // Typing in an inline form (field edit, person tag) must not steer the
      // lightbox: arrows move the caret there, and Escape cancels the form.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (event.key === "ArrowRight" && index < assets.length - 1) onIndexChange(index + 1);
      // Space toggles the slideshow (and doesn't scroll the page behind the portal).
      else if ((event.key === " " || event.key === "Spacebar") && canSlideshow) {
        event.preventDefault();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, assets.length, canSlideshow, onClose, onIndexChange, dialogOpen]);

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

  // Rotate the photo 90° and refetch so the regenerated (cache-busted) thumbnail
  // loads. Photos only; the button isn't shown for videos.
  const rotate = async (direction: "cw" | "ccw") => {
    if (rotateBusy) return;
    setRotateBusy(true);
    try {
      await api(`/api/library/gallery/assets/${asset.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ direction })
      });
      onChanged();
    } catch {
      /* leave the image as-is; the user can retry */
    } finally {
      setRotateBusy(false);
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

  // Inline field editing. The PATCH endpoint wants the full editable payload
  // (title is required, tags default to []), so each save sends the asset's
  // current values with just the edited field swapped in.
  const startEdit = (field: EditableField) => {
    setEditError("");
    setEditingField(field);
    if (field === "gps") { setEditGps(asset.gps); return; }
    setEditValue(
      field === "description" ? (asset.description ?? "")
        : field === "takenAt" ? toLocalInput(asset.takenAt)
          : asset.tags.join(", ")
    );
  };

  const cancelEdit = () => { setEditingField(null); setEditError(""); };

  // Save the picked location (or null to remove one). Sent alongside the other
  // editable fields unchanged — the PATCH endpoint wants the full payload, and an
  // omitted `gps` means "leave it alone", so only this save touches the location.
  const saveLocation = async (next: { lat: number; lng: number } | null) => {
    if (editBusy) return;
    setEditBusy(true);
    setEditError("");
    try {
      await api(`/api/library/gallery/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: asset.title,
          description: asset.description,
          takenAt: asset.takenAt,
          tags: asset.tags,
          gps: next
        })
      });
      setEditingField(null);
      onChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save the location");
    } finally {
      setEditBusy(false);
    }
  };

  const saveEdit = async () => {
    if (editBusy || !editingField) return;
    const body: { title: string; description: string | null; takenAt: string | null; tags: string[] } = {
      title: asset.title,
      description: asset.description,
      takenAt: asset.takenAt,
      tags: asset.tags
    };
    if (editingField === "description") {
      body.description = editValue.trim() || null;
    } else if (editingField === "takenAt") {
      body.takenAt = editValue ? new Date(editValue).toISOString() : null;
    } else {
      body.tags = Array.from(new Set(editValue.split(",").map((tag) => tag.trim()).filter(Boolean)));
    }
    setEditBusy(true);
    setEditError("");
    try {
      await api(`/api/library/gallery/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditingField(null);
      onChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setEditBusy(false);
    }
  };

  // Tag a person: link an existing one when the typed name matches (case-insensitive),
  // otherwise create a new person. The API returns the updated asset with its people.
  const addPerson = async () => {
    const name = personName.trim();
    if (!name || personBusy) return;
    setPersonBusy(true);
    setPersonError("");
    try {
      const match = allPeople.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const body = match ? { personId: match.id } : { name };
      const res = await api<{ asset: GalleryAsset }>(
        `/api/library/gallery/assets/${asset.id}/people`,
        { method: "POST", body: JSON.stringify(body) }
      );
      setPeople(res.asset.people ?? []);
      setPersonName("");
      setAddingPerson(false);
      onChanged();
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "Unable to tag this person");
    } finally {
      setPersonBusy(false);
    }
  };

  const removePerson = async (personId: string) => {
    try {
      const res = await api<{ asset: GalleryAsset }>(
        `/api/library/gallery/assets/${asset.id}/people/${personId}`,
        { method: "DELETE" }
      );
      setPeople(res.asset.people ?? []);
      onChanged();
    } catch { /* leave the chip; the user can retry */ }
  };

  const meta = [
    formatTaken(asset.takenAt),
    asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
    asset.kind === "video" ? formatDuration(asset.durationSeconds) : ""
  ].filter(Boolean).join(" · ");

  // The pencil beside an editable field's label (hidden while that field is open).
  const editPencil = (field: EditableField, label: string) =>
    canEdit && editingField !== field ? (
      <button
        type="button"
        className="gallery-info-edit"
        onClick={() => startEdit(field)}
        aria-label={`Edit ${label}`}
        title={`Edit ${label}`}
      >
        <Pencil size={12} aria-hidden="true" />
      </button>
    ) : null;

  // The inline form replacing a field's value while it's being edited.
  const editForm = (field: EditableField) => (
    <form
      className="gallery-info-form"
      onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelEdit(); } }}
    >
      {field === "description" ? (
        <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={3} maxLength={5000} autoFocus />
      ) : field === "takenAt" ? (
        <input type="datetime-local" value={editValue} onChange={(event) => setEditValue(event.target.value)} autoFocus />
      ) : (
        <input
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          placeholder="e.g. vacation, family"
          autoFocus
        />
      )}
      <div className="gallery-info-form-actions">
        <button type="submit" className="primary-button compact-button" disabled={editBusy}>
          {editBusy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="secondary-button compact-button" onClick={cancelEdit} disabled={editBusy}>Cancel</button>
      </div>
      {editError && <span className="gallery-info-error">{editError}</span>}
    </form>
  );

  return createPortal(
    <div className={`gallery-lightbox${showInfo ? " has-info" : ""}${playing ? " is-playing" : ""}`} role="dialog" aria-label={asset.title} aria-modal="true">
      {musicUrl && <audio ref={musicRef} src={musicUrl} loop />}
      <div className="gallery-lightbox-bar">
        <div className="gallery-lightbox-title">
          {asset.title}
          {meta && <small>{meta}</small>}
        </div>
        <div className="gallery-lightbox-actions">
          {canSlideshow && (
            <>
              <button
                className={`gallery-lightbox-action${playing ? " is-on" : ""}`}
                type="button"
                onClick={() => setPlaying((v) => !v)}
                aria-pressed={playing}
                aria-label={playing ? "Pause slideshow" : "Play slideshow"}
                title={playing ? "Pause slideshow" : "Play slideshow"}
              >
                {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
              </button>
              {playing && (
                <div className="gallery-lightbox-speed" role="group" aria-label="Slideshow speed">
                  {SLIDESHOW_INTERVALS.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={intervalSec === sec ? "is-on" : ""}
                      onClick={() => setIntervalSec(sec)}
                      aria-pressed={intervalSec === sec}
                      title={`${sec} seconds per photo`}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
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
            onClick={() => setAlbumOpen(true)}
            aria-label="Add to album"
            title="Add to album"
          >
            <ImagePlus size={18} aria-hidden="true" />
          </button>
          <button
            className="gallery-lightbox-action"
            type="button"
            onClick={() => setCollectionOpen(true)}
            aria-label="Add to collection"
            title="Add to collection"
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
          {canEdit && asset.kind === "photo" && (
            <>
              <button
                className="gallery-lightbox-action"
                type="button"
                onClick={() => void rotate("ccw")}
                disabled={rotateBusy}
                aria-label="Rotate left"
                title="Rotate left"
              >
                <RotateCcw size={18} aria-hidden="true" />
              </button>
              <button
                className="gallery-lightbox-action"
                type="button"
                onClick={() => void rotate("cw")}
                disabled={rotateBusy}
                aria-label="Rotate right"
                title="Rotate right"
              >
                <RotateCw size={18} aria-hidden="true" />
              </button>
            </>
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
        {underlay && underlay.id !== asset.id && (
          <img
            className={`gallery-lightbox-media gallery-lightbox-under${underlay.zoomed ? " is-zoomed" : ""}${underlay.dip ? " is-dipping" : ""}`}
            src={underlay.src}
            style={{ ["--lb-transition" as string]: `${transitionSec}s` } as CSSProperties}
            alt=""
            aria-hidden="true"
          />
        )}
        {asset.kind === "video" ? (
          videoError ? (
            <div className="gallery-lightbox-unplayable" role="alert">
              {asset.previewUrl && <img src={asset.previewUrl} alt={asset.title} />}
              <MessageBox tone="warning" title="Can’t play this video here">
                {formatLabel(asset.title) ? `${formatLabel(asset.title)} files use a format` : "This video uses a format"}{" "}
                your browser can’t decode. Download it to watch in a desktop player like VLC.
              </MessageBox>
              <a className="gallery-lightbox-download-cta" href={asset.fileUrl} download>
                <Download size={16} aria-hidden="true" /> Download video
              </a>
            </div>
          ) : (
            <video
              key={asset.id}
              className="gallery-lightbox-media"
              data-transition={activeTransition === "kenburns" || activeTransition === "slide" ? "fade" : activeTransition}
              data-playing={playing ? "true" : undefined}
              style={{ ["--lb-transition" as string]: `${transitionSec}s` } as CSSProperties}
              src={asset.fileUrl}
              controls
              autoPlay
              playsInline
              // Mute the clip when a music bed is chosen so the two don't fight.
              muted={!!musicUrl && playing}
              poster={asset.previewUrl ?? undefined}
              onError={() => setVideoError(true)}
              onEnded={() => { if (playing && canSlideshow) advance(); }}
            />
          )
        ) : (
          <img
            key={asset.id}
            className="gallery-lightbox-media"
            data-transition={activeTransition}
            data-playing={playing ? "true" : undefined}
            style={{ ["--lb-dwell" as string]: `${intervalSec}s`, ["--lb-transition" as string]: `${transitionSec}s` } as CSSProperties}
            src={asset.previewUrl ?? asset.fileUrl}
            alt={asset.title}
          />
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
            {(asset.description || canEdit) && (
              <div>
                <dt>Description{editPencil("description", "description")}</dt>
                <dd>{editingField === "description" ? editForm("description") : (asset.description || <span className="muted">—</span>)}</dd>
              </div>
            )}
            {(asset.takenAt || canEdit) && (
              <div>
                <dt>Date{editPencil("takenAt", "date")}</dt>
                <dd>{editingField === "takenAt" ? editForm("takenAt") : (formatTaken(asset.takenAt) || <span className="muted">—</span>)}</dd>
              </div>
            )}
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
            {(asset.gps || canEdit) && (
              <div>
                <dt>Location{editPencil("gps", "location")}</dt>
                <dd>
                  {editingField === "gps" ? (
                    <div className="gallery-info-form">
                      <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
                        <GalleryLocationPicker value={editGps} onChange={setEditGps} />
                      </Suspense>
                      <span className="gallery-info-hint">
                        {editGps
                          ? `${editGps.lat.toFixed(5)}, ${editGps.lng.toFixed(5)}`
                          : "Click the map to mark where this was taken."}
                      </span>
                      <div className="gallery-info-form-actions">
                        <button type="button" className="primary-button compact-button" onClick={() => { if (editGps) void saveLocation(editGps); }} disabled={editBusy || !editGps}>
                          {editBusy ? "Saving…" : "Save"}
                        </button>
                        <button type="button" className="secondary-button compact-button" onClick={cancelEdit} disabled={editBusy}>Cancel</button>
                        {asset.gps && (
                          <button type="button" className="danger-button compact-button" onClick={() => void saveLocation(null)} disabled={editBusy}>
                            Remove
                          </button>
                        )}
                      </div>
                      {editError && <span className="gallery-info-error">{editError}</span>}
                    </div>
                  ) : asset.gps ? (
                    <>
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
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
            )}
            {(people.length > 0 || canEdit) && (
              <div>
                <dt>People</dt>
                <dd>
                  <div className="gallery-people-tags">
                    {people.length === 0 && !canEdit && <span className="muted">—</span>}
                    {people.map((person) => (
                      <span key={person.id} className={`gallery-person-chip${person.name ? "" : " gallery-person-chip-unnamed"}`}>
                        {person.name || "Unnamed"}
                        {canEdit && (
                          <button
                            type="button"
                            className="gallery-person-chip-remove"
                            onClick={() => void removePerson(person.id)}
                            aria-label={`Remove ${person.name || "this person"}`}
                            title={`Remove ${person.name || "this person"}`}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    ))}
                    {canEdit && !addingPerson && (
                      <button type="button" className="gallery-person-add" onClick={() => setAddingPerson(true)}>
                        <Plus size={13} aria-hidden="true" /> Add person
                      </button>
                    )}
                  </div>
                  {canEdit && addingPerson && (
                    <form className="gallery-person-form" onSubmit={(event) => { event.preventDefault(); void addPerson(); }}>
                      <input
                        list="gallery-people-suggestions"
                        value={personName}
                        onChange={(event) => setPersonName(event.target.value)}
                        placeholder="Name"
                        maxLength={120}
                        autoFocus
                      />
                      <datalist id="gallery-people-suggestions">
                        {allPeople.map((person) => <option key={person.id} value={person.name} />)}
                      </datalist>
                      <button type="submit" className="secondary-button compact-button" disabled={personBusy || !personName.trim()}>
                        {personBusy ? "Adding…" : "Add"}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => { setAddingPerson(false); setPersonName(""); setPersonError(""); }}
                        aria-label="Cancel"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </form>
                  )}
                  {personError && <span className="gallery-person-error">{personError}</span>}
                </dd>
              </div>
            )}
            <div>
              <dt>Folder</dt>
              <dd>
                {onOpenFolder ? (
                  <button
                    type="button"
                    className="gallery-info-link"
                    onClick={() => onOpenFolder(asset.folder)}
                    title="Open this folder"
                  >
                    {asset.folder || "/"}
                  </button>
                ) : (asset.folder || "/")}
              </dd>
            </div>
            {(asset.tags.length > 0 || canEdit) && (
              <div>
                <dt>Tags{editPencil("tags", "tags")}</dt>
                <dd>{editingField === "tags" ? editForm("tags") : (asset.tags.length > 0 ? asset.tags.join(", ") : <span className="muted">—</span>)}</dd>
              </div>
            )}
          </dl>
        </aside>
      )}

      {collectionOpen && (
        <AddToCollectionModal
          entityType="gallery"
          entityId={asset.id}
          title={asset.title}
          onClose={() => setCollectionOpen(false)}
        />
      )}

      {albumOpen && (
        <AddToAlbumModal
          itemIds={[asset.id]}
          title={asset.title}
          onClose={() => setAlbumOpen(false)}
          onAdded={() => setAlbumOpen(false)}
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
