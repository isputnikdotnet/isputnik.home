import { useEffect, useState } from "react";
import { ImagePlus, Plus, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAlbum } from "./types";

// Add one or many gallery items to an album. Lists only albums the caller can
// edit (creator/admin) — adding is an edit. Clicking an album batch-adds
// everything and reports via onAdded; "New album" creates and adds in one go.
// Reuses the collection-picker styles so the two dialogs feel like siblings.
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

  useEffect(() => {
    api<{ albums: GalleryAlbum[] }>("/api/library/gallery/albums")
      .then((payload) => setAlbums(payload.albums.filter((album) => album.canEdit)))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load albums"));
  }, []);

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
      className="add-to-collection-modal"
      onClose={onClose}
    >
      <div className="modal-tab-content">
        <p className="muted add-to-collection-subtitle">{title}</p>

        {error && <MessageBox tone="error" title="Albums error">{error}</MessageBox>}

        <div className="collection-pick-list">
          {(albums ?? []).map((album) => (
            <button
              className="collection-pick-row"
              key={album.id}
              onClick={() => void addTo(album.id, album.name)}
              disabled={pendingId != null}
            >
              <span className="collection-pick-text">
                <strong>{album.name}</strong>
                <small>{album.itemCount} {album.itemCount === 1 ? "item" : "items"}</small>
              </span>
            </button>
          ))}
          {albums && albums.length === 0 && (
            <p className="management-empty">No albums you can edit yet — create one below.</p>
          )}
          {albums === null && <p className="management-empty">Loading…</p>}
        </div>

        {creating ? (
          <div className="collection-create-row">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createAndAdd(); if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }}
              placeholder="New album name…"
              maxLength={120}
            />
            <button className="primary-button compact-button" onClick={createAndAdd} disabled={!newName.trim()}>Create &amp; add</button>
            <button className="secondary-button compact-button" onClick={() => setCreating(false)}><X size={15} /></button>
          </div>
        ) : (
          <button className="secondary-button add-to-collection-new" onClick={() => setCreating(true)}>
            <Plus size={16} />
            <span>New album</span>
          </button>
        )}
      </div>
    </Modal>
  );
}
