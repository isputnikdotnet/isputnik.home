import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type {
  GalleryAsset, GallerySlideshow, GallerySlideshowDetail, GallerySlideshowSettings, SlideshowPatch
} from "./types";
import type { GalleryStatus } from "./useGalleryAlbums";

interface SlideshowDeps extends GalleryStatus {
  /** The default-movie-library setting is an admin-only read/write. */
  isAdmin: boolean;
}

/**
 * Everything the Slideshows view is: its list, the open slideshow, the render
 * pipeline for its movie, and the dialogs that act on it.
 *
 * Mirrors useGalleryAlbums — same shape, same contract, destructured back into
 * the page under its original names. Keep the two in step: the views are
 * deliberately each other's reflection, and a reader who has understood one
 * should not have to re-learn the other.
 */
export function useGallerySlideshows({ setLoading, setError, setNotice, isAdmin }: SlideshowDeps) {
  const { t } = useTranslation(["common", "gallery"]);
  const [slideshows, setSlideshows] = useState<GallerySlideshow[]>([]);
  const [selectedSlideshow, setSelectedSlideshow] = useState<GallerySlideshowDetail | null>(null);
  const [slideshowAssets, setSlideshowAssets] = useState<GalleryAsset[]>([]);
  const [slideshowTotal, setSlideshowTotal] = useState(0);
  const [slideshowCreateOpen, setSlideshowCreateOpen] = useState(false);
  const [slideshowNewName, setSlideshowNewName] = useState("");
  const [slideshowRename, setSlideshowRename] = useState<string | null>(null);
  const [slideshowDeleteOpen, setSlideshowDeleteOpen] = useState(false);
  const [slideshowBusy, setSlideshowBusy] = useState(false);
  const [bulkSlideshowOpen, setBulkSlideshowOpen] = useState(false);
  // Folder-browser: add photos to the open slideshow straight from the galleries.
  const [browseOpen, setBrowseOpen] = useState(false);
  // "Pick a cover" popup, where clicking a tile sets it as the slideshow cover.
  const [slideshowCoverPickerOpen, setSlideshowCoverPickerOpen] = useState(false);
  // Confirm + delete the open slideshow's rendered movie.
  const [movieDeleteOpen, setMovieDeleteOpen] = useState(false);
  const [movieDeleteBusy, setMovieDeleteBusy] = useState(false);
  // The libraries a movie could be filed into, each carrying whether it is usable and
  // why not. Every member sees this now — where a movie is saved is a per-slideshow
  // choice made by whoever edits the slideshow, not an install-wide admin setting.
  const [slideshowSettings, setSlideshowSettings] = useState<GallerySlideshowSettings | null>(null);

  const loadSlideshowSettings = useCallback(async () => {
    try {
      setSlideshowSettings(await api<GallerySlideshowSettings>("/api/library/gallery/slideshows/settings"));
    } catch { /* advisory; the picker just offers nothing */ }
  }, []);

  // Slideshows list + one slideshow's items (paged like albums, but in
  // presentation order). A larger page keeps a whole slideshow in one request.
  const loadSlideshows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ slideshows: GallerySlideshow[] }>("/api/library/gallery/slideshows");
      setSlideshows(payload.slideshows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  const openSlideshow = useCallback(async (slideshowId: string, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ slideshow: GallerySlideshowDetail; assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/slideshows/${slideshowId}?limit=200&offset=${offset}`
      );
      setSelectedSlideshow(payload.slideshow);
      setSlideshowAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setSlideshowTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.open"));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  // Presentation settings (transition / seconds per photo). Optimistic: the child
  // renders from selectedSlideshow, so patch it locally, then persist.
  const patchSlideshow = useCallback(async (slideshowId: string, fields: SlideshowPatch) => {
    setSelectedSlideshow((prev) => (prev && prev.id === slideshowId ? { ...prev, ...fields } : prev));
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}`, { method: "PATCH", body: JSON.stringify(fields) });
      if (fields.name !== undefined) { setSlideshowRename(null); void loadSlideshows(); }
      // A music or clip change alters derived fields the server resolves
      // (musicTitle/musicUrl, outroClip), so re-fetch the detail to pick
      // them up (the optimistic patch only set the id).
      if (fields.musicTrackId !== undefined || fields.outroItemId !== undefined) {
        void openSlideshow(slideshowId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.update"));
      void openSlideshow(slideshowId); // resync on failure
    }
  }, [loadSlideshows, openSlideshow, setError]);

  // Set the slideshow cover (chosen in the cover-picker popup). The list card's
  // cover is cached on `slideshows`, not the detail — refresh it too, or the open
  // slideshow's header would keep showing the old one until the next reload.
  const setSlideshowCover = useCallback(async (slideshowId: string, itemId: string) => {
    setSlideshowCoverPickerOpen(false);
    setNotice("");
    await patchSlideshow(slideshowId, { coverItemId: itemId });
    void loadSlideshows();
    setNotice(t("gallery:slideshows.coverUpdated"));
  }, [patchSlideshow, loadSlideshows, setNotice]);

  // Kick off (or re-run) an MP4 render. The poll effect below tracks it to completion.
  const renderSlideshowMovie = useCallback(async (slideshowId: string) => {
    setError("");
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/render`, { method: "POST" });
      setSelectedSlideshow((prev) => (prev && prev.id === slideshowId ? { ...prev, renderStatus: "queued", renderError: null, renderPercent: null } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.startRender"));
    }
  }, [setError]);

  // Delete the rendered movie (MP4 + leftover temp files); the slideshow returns to the
  // "Render movie" state. A copy saved to a gallery library is kept.
  const deleteSlideshowMovie = useCallback(async () => {
    if (!selectedSlideshow) return;
    setMovieDeleteBusy(true);
    setError("");
    try {
      await api(`/api/library/gallery/slideshows/${selectedSlideshow.id}/movie`, { method: "DELETE" });
      setMovieDeleteOpen(false);
      setNotice(t("gallery:slideshows.movieDeleted"));
      void openSlideshow(selectedSlideshow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.deleteMovie"));
    } finally {
      setMovieDeleteBusy(false);
    }
  }, [selectedSlideshow, openSlideshow, setError, setNotice]);

  // While a render is queued/rendering, poll the detail (cheaply — limit=1) and merge
  // the fresh render fields so the editor shows live progress, then the finished movie.
  useEffect(() => {
    const status = selectedSlideshow?.renderStatus;
    if (status !== "queued" && status !== "rendering") return;
    const id = selectedSlideshow!.id;
    let alive = true;
    const timer = window.setInterval(() => {
      api<{ slideshow: GallerySlideshowDetail }>(`/api/library/gallery/slideshows/${id}?limit=1`)
        .then((payload) => { if (alive) setSelectedSlideshow((prev) => (prev && prev.id === id ? { ...prev, ...payload.slideshow } : prev)); })
        .catch(() => { /* keep polling */ });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selectedSlideshow?.renderStatus, selectedSlideshow?.id]);

  // Persist a drag/‹›-reorder. The child already shows the new order optimistically,
  // so mirror it into slideshowAssets (keeps the lightbox preview order in step).
  const reorderSlideshow = useCallback(async (slideshowId: string, orderedIds: string[]) => {
    setSlideshowAssets((prev) => {
      const byId = new Map(prev.map((a) => [a.id, a]));
      const next = orderedIds.map((id) => byId.get(id)).filter((a): a is GalleryAsset => Boolean(a));
      const extra = prev.filter((a) => !orderedIds.includes(a.id));
      return [...next, ...extra];
    });
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/reorder`, {
        method: "POST",
        body: JSON.stringify({ itemIds: orderedIds })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.reorder"));
      void openSlideshow(slideshowId);
    }
  }, [openSlideshow, setError]);

  const removeFromSlideshow = useCallback(async (slideshowId: string, assetId: string) => {
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/items/remove`, {
        method: "POST",
        body: JSON.stringify({ itemIds: [assetId] })
      });
      setSlideshowAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setSlideshowTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.removePhoto"));
    }
  }, [setError]);

  const createSlideshowSubmit = useCallback(async () => {
    const name = slideshowNewName.trim();
    if (!name) return;
    setSlideshowBusy(true);
    try {
      await api("/api/library/gallery/slideshows", { method: "POST", body: JSON.stringify({ name }) });
      setSlideshowCreateOpen(false);
      setSlideshowNewName("");
      void loadSlideshows();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.create"));
    } finally {
      setSlideshowBusy(false);
    }
  }, [slideshowNewName, loadSlideshows, setError]);

  const confirmDeleteSlideshow = useCallback(async () => {
    if (!selectedSlideshow) return;
    setSlideshowBusy(true);
    try {
      await api(`/api/library/gallery/slideshows/${selectedSlideshow.id}`, { method: "DELETE" });
      setSlideshowDeleteOpen(false);
      setSelectedSlideshow(null);
      void loadSlideshows();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:slideshows.errors.delete"));
    } finally {
      setSlideshowBusy(false);
    }
  }, [selectedSlideshow, loadSlideshows, setError]);

  return {
    slideshows, setSlideshows,
    selectedSlideshow, setSelectedSlideshow,
    slideshowAssets, setSlideshowAssets,
    slideshowTotal, setSlideshowTotal,
    slideshowCreateOpen, setSlideshowCreateOpen,
    slideshowNewName, setSlideshowNewName,
    slideshowRename, setSlideshowRename,
    slideshowDeleteOpen, setSlideshowDeleteOpen,
    slideshowBusy, setSlideshowBusy,
    bulkSlideshowOpen, setBulkSlideshowOpen,
    browseOpen, setBrowseOpen,
    slideshowCoverPickerOpen, setSlideshowCoverPickerOpen,
    movieDeleteOpen, setMovieDeleteOpen,
    movieDeleteBusy, setMovieDeleteBusy,
    slideshowSettings, loadSlideshowSettings,
    loadSlideshows, openSlideshow, patchSlideshow, setSlideshowCover,
    renderSlideshowMovie, deleteSlideshowMovie, reorderSlideshow,
    removeFromSlideshow, createSlideshowSubmit, confirmDeleteSlideshow
  };
}
