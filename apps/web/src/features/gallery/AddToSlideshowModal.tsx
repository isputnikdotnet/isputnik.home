import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, Plus, Search, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GallerySlideshow } from "./types";

// Date shown on each card — the last time the slideshow changed. "Oct 14, 2024".
function slideshowDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Add one or many gallery items to a slideshow. Lists only slideshows the caller
// can edit (adding is an edit). Mirrors AddToAlbumModal: a card grid with cover
// thumbnails, a name filter, and "Create new slideshow" that makes one and adds
// in the same click.
export function AddToSlideshowModal({
  itemIds,
  title,
  onClose,
  onAdded
}: {
  itemIds: string[];
  title: string;
  onClose: () => void;
  onAdded: (slideshowName: string, added: number) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [slideshows, setSlideshows] = useState<GallerySlideshow[] | null>(null);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<{ slideshows: GallerySlideshow[] }>("/api/library/gallery/slideshows")
      .then((payload) => setSlideshows(payload.slideshows.filter((s) => s.canEdit)))
      .catch((err) => setError(err instanceof Error ? err.message : t("galleryModals:addToSlideshow.unableToLoad")));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return slideshows ?? [];
    return (slideshows ?? []).filter((s) => s.name.toLowerCase().includes(needle));
  }, [slideshows, search]);

  const addTo = async (slideshowId: string, slideshowName: string) => {
    setPendingId(slideshowId);
    setError("");
    try {
      const result = await api<{ added: number; skipped: number }>(`/api/library/gallery/slideshows/${slideshowId}/items`, {
        method: "POST",
        body: JSON.stringify({ itemIds })
      });
      onAdded(slideshowName, result.added);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:addToSlideshow.unableToAdd"));
    } finally {
      setPendingId(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setError("");
    try {
      const { slideshow } = await api<{ slideshow: GallerySlideshow }>("/api/library/gallery/slideshows", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      await addTo(slideshow.id, slideshow.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:addToSlideshow.unableToCreate"));
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("galleryModals:addToSlideshow.title")}
      icon={<Film size={20} />}
      className="add-to-album-modal"
      onClose={onClose}
    >
      <div className="add-to-album-head">
        <p className="sr-only">{title}</p>
        {error && <MessageBox tone="error" title={t("galleryModals:addToSlideshow.errorTitle")}>{error}</MessageBox>}
        <label className="add-to-album-search">
          <span className="sr-only">{t("galleryModals:addToSlideshow.searchSr")}</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("galleryModals:addToSlideshow.searchPlaceholder")}
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
              placeholder={t("galleryModals:addToSlideshow.newNamePlaceholder")}
              maxLength={120}
            />
            <button className="primary-button compact-button" onClick={createAndAdd} disabled={!newName.trim() || pendingId != null}>{t("galleryModals:common.createAndAdd")}</button>
            <button className="secondary-button compact-button" onClick={() => setCreating(false)}><X size={15} /></button>
          </div>
        ) : (
          <button className="secondary-button add-to-album-create" onClick={() => setCreating(true)}>
            <Plus size={18} />
            <span>{t("galleryModals:addToSlideshow.createNew")}</span>
          </button>
        )}

        {filtered.length > 0 && (
          <div className="gallery-folder-grid add-to-album-grid">
            {filtered.map((slideshow) => (
              <button
                className="gallery-folder-tile add-to-album-tile"
                key={slideshow.id}
                onClick={() => void addTo(slideshow.id, slideshow.name)}
                disabled={pendingId != null}
                title={t("galleryModals:addToSlideshow.addToTile", { name: slideshow.name })}
              >
                <span className="gallery-folder-thumb">
                  {slideshow.coverUrl ? <img src={slideshow.coverUrl} alt="" loading="lazy" /> : <Film size={28} aria-hidden="true" />}
                </span>
                <strong>{slideshow.name}</strong>
                <small>{slideshowDate(slideshow.updatedAt)}</small>
              </button>
            ))}
          </div>
        )}

        {slideshows === null && <p className="management-empty">{t("galleryModals:common.loading")}</p>}
        {slideshows && slideshows.length === 0 && (
          <p className="management-empty">{t("galleryModals:addToSlideshow.noneYet")}</p>
        )}
        {slideshows && slideshows.length > 0 && filtered.length === 0 && (
          <p className="management-empty">{t("galleryModals:addToSlideshow.noMatches", { search: search.trim() })}</p>
        )}
      </div>
    </Modal>
  );
}
