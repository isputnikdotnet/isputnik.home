import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import type { GalleryAlbum, GalleryAlbumDetail, GalleryAsset } from "./types";

/** How many album items one page request fetches. Matches the timeline. */
const PAGE_SIZE = 80;

/**
 * The page-level status every gallery view reports into: one loading flag, one
 * error box and one notice line, all owned by GalleryPage and shared by the
 * views so only one of each is ever on screen.
 */
export interface GalleryStatus {
  setLoading: (busy: boolean) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}

/**
 * Everything the Albums view is: its list, the open album, and the dialogs that
 * act on it.
 *
 * Lifted out of GalleryPage, which had grown to seven views in one function and
 * eighty-seven useState calls. The hook returns a flat object so the page can
 * destructure it back into exactly the names it used before — the JSX is
 * unchanged, and the seam is the state itself rather than a rewrite of the
 * markup. useGallerySlideshows is the same shape; the two views mirror each
 * other and should keep doing so.
 */
export function useGalleryAlbums({ setLoading, setError, setNotice }: GalleryStatus) {
  const { t } = useTranslation(["common", "gallery"]);
  const [albums, setAlbums] = useState<GalleryAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<GalleryAlbumDetail | null>(null);
  const [albumAssets, setAlbumAssets] = useState<GalleryAsset[]>([]);
  const [albumTotal, setAlbumTotal] = useState(0);
  const [albumCreateOpen, setAlbumCreateOpen] = useState(false);
  const [albumNewName, setAlbumNewName] = useState("");
  const [albumNewDesc, setAlbumNewDesc] = useState("");
  const [albumRename, setAlbumRename] = useState<string | null>(null);
  const [albumDeleteOpen, setAlbumDeleteOpen] = useState(false);
  const [albumBusy, setAlbumBusy] = useState(false);
  // Live "Share album" dialog (guest link + per-user access), for the open album.
  const [shareAlbumOpen, setShareAlbumOpen] = useState(false);
  const [bulkAlbumOpen, setBulkAlbumOpen] = useState(false);
  // "Pick a cover" mode, where clicking a tile sets it as the album cover
  // instead of opening the lightbox.
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  // Folder-browser: add photos to the open album straight from the galleries.
  const [albumBrowseOpen, setAlbumBrowseOpen] = useState(false);

  // Albums list + one album's items (paged like the timeline). Albums are
  // global, not scope-filtered — the server already trims items per viewer.
  const loadAlbums = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ albums: GalleryAlbum[] }>("/api/library/gallery/albums");
      setAlbums(payload.albums);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  const openAlbum = useCallback(async (albumId: string, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ album: GalleryAlbumDetail; assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/albums/${albumId}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      setSelectedAlbum(payload.album);
      setAlbumAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setAlbumTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.open"));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  // Album edits (rename / sort mode / cover). Reloads the header + list so cards
  // stay fresh (loadAlbums refreshes the list-card cover thumbnail after a change).
  const patchAlbum = useCallback(async (albumId: string, fields: { name?: string; sortMode?: "taken_at" | "manual"; coverItemId?: string | null }) => {
    try {
      await api(`/api/library/gallery/albums/${albumId}`, { method: "PATCH", body: JSON.stringify(fields) });
      setAlbumRename(null);
      void openAlbum(albumId);
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.update"));
    }
  }, [openAlbum, loadAlbums, setError]);

  // Set the album cover (chosen in the cover-picker popup).
  const setAlbumCover = useCallback(async (albumId: string, itemId: string) => {
    setCoverPickerOpen(false);
    setNotice("");
    await patchAlbum(albumId, { coverItemId: itemId });
    setNotice(t("gallery:albums.coverUpdated"));
  }, [patchAlbum, setNotice]);

  const removeFromAlbum = useCallback(async (albumId: string, assetId: string) => {
    try {
      await api(`/api/library/gallery/albums/${albumId}/items/remove`, {
        method: "POST",
        body: JSON.stringify({ itemIds: [assetId] })
      });
      setAlbumAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setAlbumTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.removePhoto"));
    }
  }, [setError]);

  const createAlbumSubmit = useCallback(async () => {
    const name = albumNewName.trim();
    if (!name) return;
    setAlbumBusy(true);
    try {
      await api("/api/library/gallery/albums", {
        method: "POST",
        body: JSON.stringify({ name, description: albumNewDesc.trim() || null })
      });
      setAlbumCreateOpen(false);
      setAlbumNewName("");
      setAlbumNewDesc("");
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.create"));
    } finally {
      setAlbumBusy(false);
    }
  }, [albumNewName, albumNewDesc, loadAlbums, setError]);

  const confirmDeleteAlbum = useCallback(async () => {
    if (!selectedAlbum) return;
    setAlbumBusy(true);
    try {
      await api(`/api/library/gallery/albums/${selectedAlbum.id}`, { method: "DELETE" });
      setAlbumDeleteOpen(false);
      setSelectedAlbum(null);
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:albums.errors.delete"));
    } finally {
      setAlbumBusy(false);
    }
  }, [selectedAlbum, loadAlbums, setError]);

  return {
    albums, setAlbums,
    selectedAlbum, setSelectedAlbum,
    albumAssets, setAlbumAssets,
    albumTotal, setAlbumTotal,
    albumCreateOpen, setAlbumCreateOpen,
    albumNewName, setAlbumNewName,
    albumNewDesc, setAlbumNewDesc,
    albumRename, setAlbumRename,
    albumDeleteOpen, setAlbumDeleteOpen,
    albumBusy, setAlbumBusy,
    shareAlbumOpen, setShareAlbumOpen,
    bulkAlbumOpen, setBulkAlbumOpen,
    coverPickerOpen, setCoverPickerOpen,
    albumBrowseOpen, setAlbumBrowseOpen,
    loadAlbums, openAlbum, patchAlbum, setAlbumCover,
    removeFromAlbum, createAlbumSubmit, confirmDeleteAlbum
  };
}
