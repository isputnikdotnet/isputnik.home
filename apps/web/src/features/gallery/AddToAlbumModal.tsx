import { useEffect, useMemo, useState } from "react";
import { Album, ImagePlus, Plus, Search, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAlbum } from "./types";

// Album date shown on each card — the last time the album changed (a new photo
// added, a rename). Short, locale-aware: "Oct 14, 2024".
function albumDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Add one or many gallery items to an album. Lists only albums the caller can
// edit (creator/admin) — adding is an edit. A card grid with cover thumbnails;
// the search box filters by name and "Create new album" makes one and adds in
// the same click.
export function AddToAlbumModal({
  itemIds,
  title,
  onClose,
  onAdded
}: {
  itemIds: string[];
  title: string;
  onClose: () => void;
  onAdded: (albumName: string, added: number) => void;
}) {
  const [albums, setAlbums] = useState<GalleryAlbum[] | null>(null);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<{ albums: GalleryAlbum[] }>("/api/library/gallery/albums")
      .then((payload) => setAlbums(payload.albums.filter((album) => album.canEdit)))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load albums"));
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return albums ?? [];
    return (albums ?? []).filter((album) => album.name.toLowerCase().includes(needle));
  }, [albums, search]);

  const addTo = async (albumId: string, albumName: string) => {
    setPendingId(albumId);
    setError("");
    try {
      const result = await api<{ added: number; skipped: number }>(`/api/library/gallery/albums/${albumId}/items`, {
        method: "POST",
        body: JSON.stringify({ itemIds })
      });
      onAdded(albumName, result.added);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add to the album");
    } finally {
      setPendingId(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setError("");
    try {
      const { album } = await api<{ album: GalleryAlbum }>("/api/library/gallery/albums", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      await addTo(album.id, album.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the album");
    }
  };

  return (
    <Modal
      variant="panel"
      title="Add to album"
      icon={<ImagePlus size={20} />}
      className="add-to-album-modal"
      onClose={onClose}
    >
      {/* Fixed head (row 2 of the panel grid): names the target set for screen
          readers, then the album search. The card grid below scrolls on its own. */}
      <div className="add-to-album-head">
        <p className="sr-only">{title}</p>
        {error && <MessageBox tone="error" title="Albums error">{error}</MessageBox>}
        <label className="add-to-album-search">
          <span className="sr-only">Search for an album</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search for an album..."
          />
          <span className="add-to-album-search-icon" aria-hidden="true"><Search size={18} /></span>
        </label>
      </div>

      <div className="modal-tab-content add-to-album-body">
        {creating ? (
          <div className="collection-create-row add-to-album-create-row">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createAndAdd(); if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }}
              placeholder="New album name…"
              maxLength={120}
            />
            <button className="primary-button compact-button" onClick={createAndAdd} disabled={!newName.trim() || pendingId != null}>Create &amp; add</button>
            <button className="secondary-button compact-button" onClick={() => setCreating(false)}><X size={15} /></button>
          </div>
        ) : (
          <button className="secondary-button add-to-album-create" onClick={() => setCreating(true)}>
            <Plus size={18} />
            <span>Create new album</span>
          </button>
        )}

        {filtered.length > 0 && (
          <div className="gallery-folder-grid add-to-album-grid">
            {filtered.map((album) => (
              <button
                className="gallery-folder-tile add-to-album-tile"
                key={album.id}
                onClick={() => void addTo(album.id, album.name)}
                disabled={pendingId != null}
                title={`Add to "${album.name}"`}
              >
                <span className="gallery-folder-thumb">
                  {album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <Album size={28} aria-hidden="true" />}
                </span>
                <strong>{album.name}</strong>
                <small>{albumDate(album.updatedAt)}</small>
              </button>
            ))}
          </div>
        )}

        {albums === null && <p className="management-empty">Loading…</p>}
        {albums && albums.length === 0 && (
          <p className="management-empty">No albums you can edit yet — create one above.</p>
        )}
        {albums && albums.length > 0 && filtered.length === 0 && (
          <p className="management-empty">No albums match “{search.trim()}”.</p>
        )}
      </div>
    </Modal>
  );
}
