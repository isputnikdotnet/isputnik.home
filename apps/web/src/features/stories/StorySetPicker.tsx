import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Images, Play, Search } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

// Choose an album or a slideshow to embed. One component for both — they are
// the same choice over two endpoints, and PhotoPicker already covers the
// photo/video case. Patterned on AddToCollectionModal: a searchable list,
// tapping a row makes the block.
interface SetRow {
  id: string;
  name: string;
  itemCount: number;
  coverUrl: string | null;
}

export function StorySetPicker({
  kind,
  onPick,
  onClose
}: {
  kind: "album" | "slideshow";
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [rows, setRows] = useState<SetRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const endpoint = kind === "album"
      ? "/api/library/gallery/albums"
      : "/api/library/gallery/slideshows";
    api<{ albums?: SetRow[]; slideshows?: SetRow[] }>(endpoint)
      .then((payload) => setRows(payload.albums ?? payload.slideshows ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  }, [kind]);

  const term = search.trim().toLowerCase();
  const visible = (rows ?? []).filter((row) => !term || row.name.toLowerCase().includes(term));

  return (
    <Modal
      variant="panel"
      title={kind === "album" ? t("stories:picker.albumTitle") : t("stories:picker.slideshowTitle")}
      icon={kind === "album" ? <Images size={20} /> : <Play size={20} />}
      onClose={onClose}
    >
      <div className="modal-tab-content story-set-picker">
        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}

        <label className="field story-picker-search">
          <span className="sr-only">{t("stories:picker.search")}</span>
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("stories:picker.search")}
          />
        </label>

        {rows === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {rows && visible.length === 0 && (
          <p className="management-empty">
            {rows.length === 0
              ? t(kind === "album" ? "stories:picker.noAlbums" : "stories:picker.noSlideshows")
              : t("stories:picker.noMatches")}
          </p>
        )}

        <div className="story-picker-list">
          {visible.map((row) => (
            <button type="button" className="story-picker-row" key={row.id} onClick={() => onPick(row.id)}>
              <span className="story-picker-cover" aria-hidden="true">
                {row.coverUrl ? <img src={row.coverUrl} alt="" /> : (kind === "album" ? <Images size={18} /> : <Play size={18} />)}
              </span>
              <span className="story-picker-text">
                <strong>{row.name}</strong>
                <small>{t("stories:count.photos", { count: row.itemCount })}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
