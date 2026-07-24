import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Folder, FolderOpen, Image as ImageIcon, Play } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset, GalleryFolder, GalleryLibrary } from "./types";

// Browse the galleries by folder and add photos/videos straight into an open slideshow —
// no leaving the editor, no re-picking the slideshow. Reuses the folder-listing endpoint
// (GET /folders) the main Folder view uses. Selection persists across folders so you can
// gather from several before adding; already-present items show as "Added" and can't be
// re-selected (the add endpoint would skip them anyway).
export function SlideshowPhotoBrowser({
  slideshowId,
  slideshowName,
  libraries,
  existingIds,
  onClose,
  onAdded
}: {
  slideshowId: string;
  slideshowName: string;
  libraries: GalleryLibrary[];
  // Item ids already in the slideshow (the loaded page) — shown as "Added".
  existingIds: string[];
  onClose: () => void;
  onAdded: (added: number) => void;
}) {
  const [scope, setScope] = useState<string>("all"); // "all" or a gallery library id
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Already in the slideshow, plus anything added during this browse session.
  const [added, setAdded] = useState<Set<string>>(() => new Set(existingIds));
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (nextScope: string, nextParent: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ parent: nextParent, limit: "300" });
      if (nextScope === "all") params.set("scope", "all");
      else { params.set("scope", "library"); params.set("libraryId", nextScope); }
      const payload = await api<{ parent: string; folders: GalleryFolder[]; assets: GalleryAsset[] }>(
        `/api/library/gallery/folders?${params}`
      );
      setFolders(payload.folders);
      setAssets(payload.assets);
      setParent(payload.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(scope, ""); }, [scope, load]);

  const breadcrumbParts = useMemo(() => (parent ? parent.split("/") : []), [parent]);

  const toggle = (id: string) => {
    if (added.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addSelected = async () => {
    const ids = [...selected].filter((id) => !added.has(id));
    if (ids.length === 0) return;
    setAdding(true);
    setError("");
    try {
      const result = await api<{ added: number; skipped: number }>(`/api/library/gallery/slideshows/${slideshowId}/items`, {
        method: "POST",
        body: JSON.stringify({ itemIds: ids })
      });
      setAdded((prev) => new Set([...prev, ...ids]));
      setSelected(new Set());
      onAdded(result.added);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the photos");
    } finally {
      setAdding(false);
    }
  };

  const librarySelect = (
    <label className="slideshow-browse-scope">
      <span className="sr-only">Gallery library</span>
      <select value={scope} onChange={(e) => { setScope(e.target.value); }} disabled={adding}>
        <option value="all">All libraries</option>
        {libraries.map((library) => (
          <option key={library.id} value={library.id}>{library.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal
      variant="panel"
      title={`Add photos to “${slideshowName}”`}
      icon={<FolderOpen size={20} />}
      className="add-to-album-modal slideshow-browse-modal"
      busy={adding}
      headerAction={librarySelect}
      onClose={onClose}
    >
      <div className="add-to-album-head">
        {error && <MessageBox tone="error" title="Couldn’t add photos">{error}</MessageBox>}
        <div className="gallery-breadcrumb slideshow-browse-crumbs">
          <button type="button" onClick={() => void load(scope, "")} disabled={adding}>All folders</button>
          {breadcrumbParts.map((part, i) => {
            const target = breadcrumbParts.slice(0, i + 1).join("/");
            return (
              <span key={target} className="slideshow-browse-crumb">
                <ChevronRight size={14} aria-hidden="true" />
                <button type="button" onClick={() => void load(scope, target)} disabled={adding}>{part}</button>
              </span>
            );
          })}
        </div>
      </div>

      <div className="modal-tab-content add-to-album-body">
        {folders.length > 0 && (
          <>
            <p className="gallery-section-label">Folders</p>
            <div className="gallery-folder-grid">
              {folders.map((folder) => (
                <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void load(scope, folder.path)} disabled={adding}>
                  <span className="gallery-folder-thumb">
                    {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                  </span>
                  <strong>{folder.name}</strong>
                  <small>{folder.assetCount.toLocaleString()} {folder.assetCount === 1 ? "item" : "items"}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {assets.length > 0 && (
          <>
            <p className="gallery-section-label">Photos &amp; videos</p>
            <div className="gallery-grid">
              {assets.map((asset) => {
                const isAdded = added.has(asset.id);
                const isSelected = selected.has(asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`gallery-tile slideshow-browse-tile${isAdded ? " is-added" : isSelected ? " is-selected" : ""}`}
                    onClick={() => toggle(asset.id)}
                    disabled={isAdded || adding}
                    aria-pressed={isSelected}
                    title={isAdded ? "Already in this slideshow" : asset.title}
                  >
                    {asset.coverUrl ? <img src={asset.coverUrl} alt="" loading="lazy" /> : (
                      <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                    )}
                    {asset.kind === "video" && <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>}
                    {isAdded ? (
                      <span className="slideshow-browse-badge added">Added</span>
                    ) : isSelected ? (
                      <span className="slideshow-browse-badge selected"><Check size={16} aria-hidden="true" /></span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {loading && folders.length === 0 && assets.length === 0 && <p className="management-empty">Loading…</p>}
        {!loading && folders.length === 0 && assets.length === 0 && <p className="management-empty">This folder is empty.</p>}
      </div>

      <div className="modal-actions slideshow-browse-actions">
        <span className="muted">{selected.size > 0 ? `${selected.size} selected` : "Select photos to add"}</span>
        <div className="row-actions">
          <button type="button" className="secondary-button compact-button" onClick={onClose} disabled={adding}>Done</button>
          <button type="button" className="primary-button compact-button" onClick={addSelected} disabled={selected.size === 0 || adding}>
            {adding ? "Adding…" : selected.size === 1 ? "Add 1 photo" : `Add ${selected.size} photos`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
