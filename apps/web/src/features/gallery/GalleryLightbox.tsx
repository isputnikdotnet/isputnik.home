import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Heart, ImagePlus, Info, ListMusic, Mic, MoreVertical, Pause, Play, Replace, RotateCcw, RotateCw, Send, Trash2, Volume2, VolumeX, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { AddToAlbumModal } from "./AddToAlbumModal";
import { SendToSheet } from "../social/SendToSheet";
import { GalleryReplaceModal } from "./GalleryReplaceModal";
import { GalleryLightboxPanel } from "./GalleryLightboxPanel";
import { useIsMobile } from "../../shared/useIsMobile";
import type { GalleryAsset, SlideshowTransition } from "./types";
import { formatTakenDate } from "./taken-date";
import { CLIP_LENGTH, formatClock } from "../../shared/formatClock";
import { Button } from "../../shared/Button";


// Uppercase file extension (e.g. "MVI_1263.AVI" → "AVI") for the unplayable notice.
function formatLabel(title: string): string {
  const dot = title.lastIndexOf(".");
  return dot > 0 && dot < title.length - 1 ? title.slice(dot + 1).toUpperCase() : "";
}


// Slideshow dwell options (seconds a photo shows before advancing). A video ignores
// these and advances when it finishes playing.
const SLIDESHOW_INTERVALS = [3, 5, 10] as const;
// The styles a "random" slideshow draws from — one is re-rolled on every slide change.
const RANDOM_TRANSITIONS: SlideshowTransition[] = ["crossfade", "fade", "slide", "kenburns"];
// "Random" picks a style per slide, but rendering may not roll dice: the same slide
// re-rendered must keep the style it is mid-way through. So each showing takes one
// seed at mount and the slide's own id decides from there — unpredictable to watch,
// settled for React.
function seededTransition(seed: number, id: string): SlideshowTransition {
  let hash = seed;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return RANDOM_TRANSITIONS[hash % RANDOM_TRANSITIONS.length];
}
// Remembered for the browsing session (module scope survives navigation, resets on
// reload) so the speed choice sticks across slideshows without persisting to disk.
let sessionSlideshowInterval = 5;

// What just happened to the photo on screen. The viewer does not know what its
// host has loaded, so it says what changed and lets the host decide how much to
// redo: a like moves nothing and can be patched where the photo already sits, a
// delete removes one row, and everything else can reorder or redraw the grid.
// Reloading the view for a like used to throw away every "Load more" page the
// visitor had asked for — and closed the viewer under them when the photo they
// were looking at lived on one of those pages.
export type GalleryAssetChange =
  | { kind: "like"; id: string; saved: boolean }
  | { kind: "deleted"; id: string }
  | { kind: "asset"; id: string };

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
  onChanged: (change: GalleryAssetChange) => void;
  // When set, the Info panel's Folder entry becomes a link that closes the
  // lightbox and opens that folder in the gallery's Folders view.
  onOpenFolder?: (folder: string) => void;
  canDelete: boolean;
  canEdit: boolean;
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
  const { t } = useTranslation(["common", "gallery"]);
  const asset = assets[index];
  const isMobile = useIsMobile();
  // The Info panel opens with the photo on desktop — details are part of viewing,
  // not an extra. A slideshow starts immersive, though: no side panel eating the
  // frame. On mobile the panel is a near-full overlay (gallery.css), so it stays
  // closed until the user asks for it, or it would eat the whole screen on open.
  const [showInfo, setShowInfo] = useState(!autoPlay && !isMobile);
  // Slideshow: auto-advances through `assets`, looping past the last item. Videos
  // ignore the dwell timer and advance when they finish (see the <video> onEnded).
  const [playing, setPlaying] = useState(autoPlay);
  const [intervalSec, setIntervalSec] = useState(initialInterval ?? sessionSlideshowInterval);
  // A saved slideshow drives the transition; every other view uses the default.
  const slideTransition: SlideshowTransition = transition ?? "crossfade";
  const transitionSec = transitionSeconds ?? 2;
  // The transition applied to the CURRENT slide: "random" picks a style per slide
  // from this showing's seed; fixed styles pass straight through.
  const [randomSeed] = useState(() => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  const assetId = asset?.id;
  const activeTransition = useMemo<SlideshowTransition>(
    () => slideTransition === "random"
      ? seededTransition(randomSeed, String(assetId ?? ""))
      : slideTransition,
    [slideTransition, assetId, randomSeed]
  );
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const canSlideshow = assets.length > 1;
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [sendToOpen, setSendToOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Mobile/PWA: the bar's overflow menu, holding whichever actions don't fit in
  // one row (see visibleActions/overflowActions below — same "cap the row, fold
  // the rest into a ⋮ menu" pattern as the audiobook/ebook detail page).
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // An optimistic like, remembered against the asset and the saved value it was
  // made over: the moment either moves the flip is spent and the asset's own
  // value wins. `liked` is therefore derived, not a copy of the prop kept in step
  // by an effect — paging to the next photo used to show the previous one's heart
  // for a render, and a like landing on the wrong asset was one race away.
  const [pendingLike, setPendingLike] = useState<{ id: string; over: boolean; value: boolean } | null>(null);
  const assetSaved = asset?.saved ?? false;
  const liked = pendingLike && pendingLike.id === asset?.id && pendingLike.over === assetSaved
    ? pendingLike.value
    : assetSaved;
  const [likeBusy, setLikeBusy] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  // Set when the browser's <video> can't decode this asset (unsupported container/
  // codec — legacy AVI/Motion-JPEG, WMV, etc.). We serve originals untranscoded, so
  // a plain <video> silently stalls; this drives an explanatory fallback instead.
  // Read from the scanner's `playable` flag so a known-bad file skips the doomed
  // load attempt, plus whichever asset the <video> has since failed on — derived
  // per asset rather than reset by an effect, which showed the previous slide's
  // verdict (a fallback over a playable clip, or a doomed load) for one render.
  const [decodeFailedId, setDecodeFailedId] = useState<string | null>(null);
  const videoError = asset?.playable === false || (asset != null && decodeFailedId === asset.id);

  // A rotated video plays the ORIGINAL file (rotation is only baked into the poster
  // thumbnails — the file on disk is never modified), so the <video> element is
  // counter-rotated with a CSS transform. A 90°/270° turn swaps which stage side
  // caps which side of the element, so the stage's content box is measured here and
  // the caps set inline on the element (see videoStyle below).
  const videoRotation = asset?.kind === "video" ? asset.rotation : 0;
  const videoTurned = videoRotation === 90 || videoRotation === 270;
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!videoTurned) return;
    const el = stageRef.current;
    if (!el) return;
    // contentRect is the content box, so the stage padding (including the details
    // pane's padding-right on desktop) is already excluded. Fires once on observe.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setStageBox({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [videoTurned]);

  // Native <video> controls render inside the element, so on a rotated video they
  // would appear sideways — a rotated video hides them and drives playback from the
  // custom bar over the stage instead. This mirrors the element's state for it.
  const videoRef = useRef<HTMLVideoElement>(null);
  const [vidPlaying, setVidPlaying] = useState(false);
  const [vidTime, setVidTime] = useState(0);
  const [vidDuration, setVidDuration] = useState(0);
  // Deliberately NOT reset per asset — a mute choice sticks while browsing.
  const [vidMuted, setVidMuted] = useState(false);
  useEffect(() => { setVidPlaying(false); setVidTime(0); setVidDuration(0); }, [asset?.id]);

  // Fire-and-forget view ping for the activity dashboard. Server-side dedup keeps
  // paging back and forth through a set from spamming activity_logs.
  const viewedAssetId = asset?.id;
  useEffect(() => {
    if (!viewedAssetId) return;
    void api(`/api/library/gallery/assets/${viewedAssetId}/viewed`, { method: "POST" }).catch(() => {});
  }, [viewedAssetId]);

  // Moving to another asset closes the overflow menu.
  useEffect(() => { setMoreMenuOpen(false); }, [asset?.id]);


  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  // Any open sub-dialog freezes the slideshow (a slide must not advance under a
  // confirm/share/collection modal). Also gates the keyboard handler below.
  const dialogOpen = collectionOpen || albumOpen || deleteOpen || replaceOpen || moreMenuOpen;

  // Close the overflow menu on an outside click (Escape is handled in the
  // shared keydown handler below, alongside the lightbox's own Escape-to-close).
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [moreMenuOpen]);

  // Advance to the next slide, wrapping from the last item back to the first so the
  // loop never stalls. Manual arrows/clicks reuse this at the ends too.
  const advance = () => { if (assets.length > 0) onIndexChange((index + 1) % assets.length); };

  // Keep the module-remembered speed in step with the picker.
  useEffect(() => { sessionSlideshowInterval = intervalSec; }, [intervalSec]);

  // Dwell timer. Photos advance after `intervalSec`; a playable video is skipped
  // here and advances from its own onEnded so it plays in full — and so does a
  // recording, for the same reason. An unplayable video (videoError) has no end
  // event, so it falls back to the timer like a photo.
  useEffect(() => {
    if (!playing || !canSlideshow || dialogOpen) return;
    if (asset?.kind === "video" && !videoError) return;
    if (asset?.kind === "audio") return;
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

  // Defined above the keydown effect (and null-guarded) so `F` can reach it — the
  // early `if (!asset) return null` below would otherwise sit between them.
  const toggleLike = useCallback(async () => {
    if (!asset || likeBusy) return;
    const next = !liked;
    setPendingLike({ id: asset.id, over: asset.saved ?? false, value: next });
    setLikeBusy(true);
    try {
      if (next) await api(`/api/library/books/${asset.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${asset.id}/save`, { method: "DELETE" });
      onChanged({ kind: "like", id: asset.id, saved: next });
    } catch {
      setPendingLike(null);
    } finally {
      setLikeBusy(false);
    }
  }, [asset, liked, likeBusy, onChanged]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A dialog over the lightbox (Send to…, a confirm) already answered this key.
      if (event.defaultPrevented) return;
      // The overflow menu gets its own Escape (closes the menu, not the whole
      // lightbox) even though it's also part of dialogOpen below.
      if (moreMenuOpen) {
        if (event.key === "Escape") setMoreMenuOpen(false);
        return;
      }
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
      // F likes the photo. A review pass over a trip is then ←/→ to move and F to
      // keep, without the pointer ever leaving the keyboard. Modified presses stay
      // with the browser (⌘F / Ctrl+F is Find).
      else if ((event.key === "f" || event.key === "F") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void toggleLike();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, assets.length, canSlideshow, onClose, onIndexChange, dialogOpen, moreMenuOpen, toggleLike]);

  if (!asset) return null;

  // Rotate the asset 90° and refetch so the regenerated (cache-busted) thumbnail
  // loads. For a video the poster/tiles come back rotated and the playing <video>
  // picks the new angle up live via videoStyle — no remount, playback continues.
  const rotate = async (direction: "cw" | "ccw") => {
    if (rotateBusy) return;
    setRotateBusy(true);
    try {
      await api(`/api/library/gallery/assets/${asset.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ direction })
      });
      onChanged({ kind: "asset", id: asset.id });
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
      onChanged({ kind: "deleted", id: asset.id });
      // Move to a neighbour, or close when it was the last asset.
      if (assets.length <= 1) onClose();
      else onIndexChange(Math.min(index, assets.length - 2));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("gallery:lightbox.errors.delete"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleVideoPlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => { /* interrupted by unload */ });
    else video.pause();
  };

  // Counter-rotation for a manually-rotated video. The transform doesn't change the
  // element's LAYOUT box, so for a 90°/270° turn the stage caps are applied swapped:
  // the box's height becomes the visible width and vice versa, and object-fit keeps
  // the aspect ratio within them. Until the stage is measured (first frame) the base
  // max-width/height 100% still bound it, so nothing overflows.
  const videoStyle: CSSProperties = { ["--lb-transition" as string]: `${transitionSec}s` };
  if (videoRotation) {
    videoStyle.transform = `rotate(${videoRotation}deg)`;
    if (videoTurned && stageBox) {
      videoStyle.maxWidth = stageBox.h;
      videoStyle.maxHeight = stageBox.w;
    }
  }

  const meta = [
    formatTakenDate(asset, { withTime: true }),
    asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
    asset.kind === "video" || asset.kind === "audio" ? formatClock(asset.durationSeconds, CLIP_LENGTH) : ""
  ].filter(Boolean).join(" · ");

  // The action row in the bar above the photo.
  // and Close are fixed — they never move — everything else is a candidate that
  // mobile/PWA caps to keep the whole row on one line (same "cap it, fold the
  // rest into a ⋮ menu" pattern as the audiobook/ebook detail page's top bar,
  // which was overflowing the same way before that fix).
  type LightboxAction = {
    key: string;
    icon: LucideIcon;
    label: string;
    // Keyboard shortcut, shown in the tooltip so it's findable at all.
    hint?: string;
    onClick?: () => void;
    href?: string;
    download?: boolean;
    disabled?: boolean;
    active?: boolean;
    danger?: boolean;
  };
  // The bar carries the things done to a photo while looking at it; the ⋮ menu
  // holds the rarer ones — and delete, one slip from Download otherwise. On
  // desktop that split is fixed; mobile/PWA caps the row and folds the rest
  // (the same pattern as the audiobook/ebook detail page).
  const primaryActions: LightboxAction[] = [
    {
      key: "like",
      icon: Heart,
      label: liked ? t("gallery:common.unlike") : t("gallery:common.like"),
      hint: "F",
      onClick: () => void toggleLike(),
      disabled: likeBusy,
      active: liked
    },
    { key: "album", icon: ImagePlus, label: t("gallery:lightbox.addToAlbum"), onClick: () => setAlbumOpen(true) },
    {
      key: "download",
      icon: Download,
      label: t("gallery:common.download"),
      href: `${asset.fileUrl}${asset.fileUrl.includes("?") ? "&" : "?"}download=1`,
      download: true
    },
    { key: "send", icon: Send as LucideIcon, label: t("gallery:common.sendTo"), onClick: () => setSendToOpen(true) },
    {
      key: "details",
      icon: Info,
      label: t("gallery:lightbox.detailsHeading"),
      onClick: () => setShowInfo((v) => !v),
      active: showInfo
    }
  ];
  const secondaryActions: LightboxAction[] = [
    { key: "collection", icon: ListMusic, label: t("gallery:lightbox.addToCollection"), onClick: () => setCollectionOpen(true) },
    // No rotate on a recording — there is nothing to turn (the server refuses too).
    ...(canEdit && asset.kind !== "audio"
      ? [
          { key: "rotate-left", icon: RotateCcw as LucideIcon, label: t("gallery:lightbox.rotateLeft"), onClick: () => void rotate("ccw"), disabled: rotateBusy },
          { key: "rotate-right", icon: RotateCw as LucideIcon, label: t("gallery:lightbox.rotateRight"), onClick: () => void rotate("cw"), disabled: rotateBusy }
        ]
      : []),
    // Swap the file, keep the item: the high-resolution scan over the one that
    // has been in the gallery for years, with every story, album, tag and face
    // that points at it carried across. Uploading is what it does, so it needs
    // the same permission as an upload.
    ...(canEdit && asset.kind !== "audio"
      ? [{
          key: "replace",
          icon: Replace as LucideIcon,
          label: t("gallery:replace.action"),
          onClick: () => setReplaceOpen(true)
        }]
      : []),
    ...(canDelete
      ? [{
          key: "delete",
          icon: Trash2 as LucideIcon,
          label: t("gallery:common.deleteWord"),
          onClick: () => { setDeleteError(""); setDeleteOpen(true); },
          danger: true
        }]
      : [])
  ];
  const candidateActions = [...primaryActions, ...secondaryActions];
  // Mobile: 6 icons in the actions group, matching the detail page's cap —
  // play/pause when slideshowable plus up to 5 more, with the overflow trigger
  // swapped in for the last slot once there isn't room for everything. (The bar
  // also carries a back button ahead of the group, like the book detail pages.)
  const fixedSlots = canSlideshow ? 1 : 0 /* play/pause */;
  const rowCap = Math.max(1, 6 - fixedSlots);
  const mobileOverflow = isMobile && candidateActions.length > rowCap;
  const visibleActions = !isMobile
    ? primaryActions
    : mobileOverflow ? candidateActions.slice(0, rowCap - 1) : candidateActions.slice(0, rowCap);
  const overflowActions = !isMobile
    ? secondaryActions
    : mobileOverflow ? candidateActions.slice(visibleActions.length) : [];

  const renderAction = (a: LightboxAction) =>
    a.href ? (
      <a
        key={a.key}
        className="gallery-lightbox-action"
        href={a.href}
        download={a.download}
        aria-label={a.label}
        title={a.label}
      >
        <a.icon size={18} aria-hidden="true" />
      </a>
    ) : (
      <Button
        variant="bare"
        key={a.key}
        className={`gallery-lightbox-action${a.active ? " is-on" : ""}`}
        onClick={a.onClick}
        disabled={a.disabled}
        aria-pressed={a.active}
        aria-label={a.label}
        // The shortcut rides in the tooltip only — an aria-label is read aloud, and
        // "Like F" is not a sentence.
        title={a.hint ? `${a.label} (${a.hint})` : a.label}
      >
        <a.icon size={18} fill={a.key === "like" && a.active ? "currentColor" : "none"} aria-hidden="true" />
      </Button>
    );

  const renderMenuItem = (a: LightboxAction) =>
    a.href ? (
      <a
        key={a.key}
        role="menuitem"
        href={a.href}
        download={a.download}
        onClick={() => setMoreMenuOpen(false)}
        className={a.danger ? "danger" : undefined}
      >
        <a.icon size={16} aria-hidden="true" />
        <span>{a.label}</span>
      </a>
    ) : (
      <Button
        variant="bare"
        key={a.key}
        role="menuitem"
        onClick={() => { setMoreMenuOpen(false); a.onClick?.(); }}
        disabled={a.disabled}
        className={a.danger ? "danger" : undefined}
      >
        <a.icon size={16} aria-hidden="true" />
        <span>{a.label}</span>
      </Button>
    );

  return createPortal(
    <div className={`gallery-lightbox${showInfo ? " has-info" : ""}${playing ? " is-playing" : ""}`} role="dialog" aria-label={asset.title} aria-modal="true">
      {musicUrl && <audio ref={musicRef} src={musicUrl} loop />}
      <div className="gallery-lightbox-bar">
        {/* Mobile/PWA mirrors the audiobook/ebook detail topbar: a back button
            leading the row instead of a trailing ✕, and no title (the photo
            itself is right below, and the name reads as crowding the bar). */}
        {isMobile ? (
          <>
            <Button variant="bare" className="gallery-lightbox-action" onClick={onClose} aria-label={t("gallery:common.back")} title={t("gallery:common.back")}>
              <ArrowLeft size={18} aria-hidden="true" />
            </Button>
            <span className="gallery-lightbox-divider" aria-hidden="true" />
          </>
        ) : (
          <div className="gallery-lightbox-title">
            {assets.length > 1 && <span className="gallery-lightbox-count">{index + 1} / {assets.length}</span>}
            <span className="gallery-lightbox-name">
              {asset.title}
              {meta && <small>{meta}</small>}
            </span>
          </div>
        )}
        <div className="gallery-lightbox-actions">
          {canSlideshow && (
            <>
              <Button
                variant="bare"
                className={`gallery-lightbox-action${playing ? " is-on" : ""}`}
                onClick={() => setPlaying((v) => !v)}
                aria-pressed={playing}
                aria-label={playing ? t("gallery:lightbox.pauseSlideshow") : t("gallery:lightbox.playSlideshow")}
                title={playing ? t("gallery:lightbox.pauseSlideshow") : t("gallery:lightbox.playSlideshow")}
              >
                {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
              </Button>
              {playing && (
                <div className="gallery-lightbox-speed" role="group" aria-label={t("gallery:lightbox.speedGroupAria")}>
                  {SLIDESHOW_INTERVALS.map((sec) => (
                    <Button
                      variant="bare"
                      key={sec}
                      className={intervalSec === sec ? "is-on" : ""}
                      onClick={() => setIntervalSec(sec)}
                      aria-pressed={intervalSec === sec}
                      title={t("gallery:lightbox.secondsPerPhotoTitle", { sec })}
                    >
                      {sec}s
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
          {visibleActions.map(renderAction)}
          {overflowActions.length > 0 && (
            <div className="gallery-lightbox-menu-wrap" ref={moreMenuRef}>
              <Button
                variant="bare"
                className="gallery-lightbox-action"
                onClick={() => setMoreMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                aria-label={t("gallery:lightbox.moreActionsAria")}
                title={t("gallery:lightbox.moreActionsAria")}
              >
                <MoreVertical size={18} aria-hidden="true" />
              </Button>
              {moreMenuOpen && (
                <div className="gallery-lightbox-menu" role="menu" aria-label={t("gallery:lightbox.moreActionsAria")}>
                  {overflowActions.map(renderMenuItem)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <Button variant="bare" className="gallery-lightbox-action" onClick={onClose} aria-label={t("common:common.close")} title={t("common:common.close")}>
              <X size={18} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div className="gallery-lightbox-stage" ref={stageRef}>
        {hasPrev && (
          <Button variant="bare" className="gallery-lightbox-nav prev" onClick={() => onIndexChange(index - 1)} aria-label={t("gallery:lightbox.previousAria")}>
            <ChevronLeft size={26} aria-hidden="true" />
          </Button>
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
              <MessageBox tone="warning" title={t("gallery:lightbox.unplayableVideoTitle")}>
                {formatLabel(asset.title)
                  ? t("gallery:lightbox.unplayableWithExt", { ext: formatLabel(asset.title) })
                  : t("gallery:lightbox.unplayableGeneric")}
              </MessageBox>
              <a className="gallery-lightbox-download-cta" href={`${asset.fileUrl}${asset.fileUrl.includes("?") ? "&" : "?"}download=1`} download>
                <Download size={16} aria-hidden="true" /> {t("gallery:lightbox.downloadVideoLink")}
              </a>
            </div>
          ) : (
            <>
              <video
                key={asset.id}
                ref={videoRef}
                className="gallery-lightbox-media"
                data-transition={activeTransition === "kenburns" || activeTransition === "slide" ? "fade" : activeTransition}
                data-playing={playing ? "true" : undefined}
                style={videoStyle}
                src={asset.playbackUrl}
                // A rotated video hides the native controls (they'd render sideways
                // inside the transformed element) and uses the custom bar below.
                controls={videoRotation === 0}
                autoPlay
                playsInline
                // Mute the clip when a music bed is chosen so the two don't fight.
                muted={(!!musicUrl && playing) || vidMuted}
                // The poster already has the manual rotation baked in, so inside a
                // CSS-rotated element it would show turned twice — omit it there.
                poster={videoRotation === 0 ? asset.previewUrl ?? undefined : undefined}
                onClick={videoRotation !== 0 ? toggleVideoPlay : undefined}
                onPlay={() => setVidPlaying(true)}
                onPause={() => setVidPlaying(false)}
                onTimeUpdate={(event) => setVidTime(event.currentTarget.currentTime)}
                onDurationChange={(event) => {
                  const d = event.currentTarget.duration;
                  setVidDuration(Number.isFinite(d) ? d : 0);
                }}
                onError={() => setDecodeFailedId(asset.id)}
                onEnded={() => { if (playing && canSlideshow) advance(); }}
              />
              {videoRotation !== 0 && (
                <div className="gallery-video-controls">
                  <Button
                    variant="bare"
                    onClick={toggleVideoPlay}
                    aria-label={vidPlaying ? t("gallery:common.pause") : t("gallery:common.play")}
                    title={vidPlaying ? t("gallery:common.pause") : t("gallery:common.play")}
                  >
                    {vidPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                  </Button>
                  <span className="gallery-video-time">{formatClock(vidTime, CLIP_LENGTH)}</span>
                  <input
                    type="range"
                    min={0}
                    max={vidDuration || 0}
                    step={0.1}
                    value={Math.min(vidTime, vidDuration || 0)}
                    onChange={(event) => {
                      const time = Number(event.target.value);
                      if (videoRef.current) videoRef.current.currentTime = time;
                      setVidTime(time);
                    }}
                    aria-label={t("gallery:lightbox.seekAria")}
                  />
                  <span className="gallery-video-time">{formatClock(vidDuration, CLIP_LENGTH)}</span>
                  <Button
                    variant="bare"
                    onClick={() => setVidMuted((m) => !m)}
                    aria-label={vidMuted ? t("gallery:lightbox.unmute") : t("gallery:lightbox.mute")}
                    title={vidMuted ? t("gallery:lightbox.unmute") : t("gallery:lightbox.mute")}
                  >
                    {vidMuted ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                  </Button>
                </div>
              )}
            </>
          )
        ) : asset.kind === "audio" ? (
          // A recording: embedded cover art when the file carries any, the mic
          // glyph otherwise, and the browser's own audio controls underneath.
          <div className="gallery-lightbox-audio">
            {asset.previewUrl ? (
              <img src={asset.previewUrl} alt="" aria-hidden="true" />
            ) : (
              <span className="gallery-lightbox-audio-glyph"><Mic size={64} aria-hidden="true" /></span>
            )}
            <span className="gallery-lightbox-audio-title">{asset.title}</span>
            <audio
              key={asset.id}
              src={asset.playbackUrl}
              controls
              autoPlay
              onEnded={() => { if (playing && canSlideshow) advance(); }}
            />
          </div>
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
          <Button variant="bare" className="gallery-lightbox-nav next" onClick={() => onIndexChange(index + 1)} aria-label={t("gallery:lightbox.nextAria")}>
            <ChevronRight size={26} aria-hidden="true" />
          </Button>
        )}
      </div>

      {showInfo && (
        <GalleryLightboxPanel
          asset={asset}
          canEdit={canEdit}
          onChanged={onChanged}
          onOpenFolder={onOpenFolder}
          onClose={() => setShowInfo(false)}
          onRotate={canEdit && asset.kind !== "audio" ? (direction) => void rotate(direction) : undefined}
          rotateBusy={rotateBusy}
          onReplace={canEdit && asset.kind !== "audio" ? () => setReplaceOpen(true) : undefined}
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

      {albumOpen && (
        <AddToAlbumModal
          itemIds={[asset.id]}
          title={asset.title}
          onClose={() => setAlbumOpen(false)}
          onAdded={() => setAlbumOpen(false)}
        />
      )}

      {sendToOpen && (
        <SendToSheet
          subject={{ entityType: "gallery", entityId: asset.id }}
          onClose={() => setSendToOpen(false)}
        />
      )}

      {replaceOpen && (
        <GalleryReplaceModal
          asset={asset}
          onClose={() => setReplaceOpen(false)}
          onReplaced={() => {
            setReplaceOpen(false);
            // Same refresh the rotate does: the thumbnails are regenerated under
            // their own keys, and the asset's new updated_at busts the ?v= cache.
            onChanged({ kind: "asset", id: asset.id });
          }}
        />
      )}

      {deleteOpen && (
        <ConfirmDialog
          title={t("gallery:lightbox.deleteConfirmTitle", { title: asset.title })}
          confirmLabel={t("gallery:lightbox.deleteConfirmLabel")}
          busyLabel={t("gallery:common.moving")}
          busy={deleteBusy}
          error={deleteError}
          danger
          onConfirm={() => void confirmRemove()}
          onCancel={() => { if (!deleteBusy) setDeleteOpen(false); }}
        >
          {t("gallery:lightbox.deleteConfirmBody")}
        </ConfirmDialog>
      )}
    </div>,
    document.body
  );
}
