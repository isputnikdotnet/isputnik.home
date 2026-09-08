import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareText } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAlbum } from "./types";

// "Ask someone" from a folder or a selection (docs/for-you-plan.md; the
// mechanism is phase 3 of docs/photo-review-plan.md). The question rides on an
// album share, so the photos become an album first — named here, listed under
// Albums like any other — and are then sent with the question, or opened in
// Review mode for the person asking, without sending anything.

export type AskSomeoneSource =
  | { kind: "items"; itemIds: string[] }
  | { kind: "folder"; libraryId: string; path: string };

export function AskSomeoneModal({
  source,
  defaultName,
  onClose,
  onAsk,
  onMyself
}: {
  source: AskSomeoneSource;
  defaultName: string;
  onClose: () => void;
  /** The album exists; open Send to on it with the question ticked. */
  onAsk: (album: GalleryAlbum) => void;
  /** The album exists; open Review mode over it for the asker. */
  onMyself: (album: GalleryAlbum) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState<"ask" | "myself" | null>(null);
  const [error, setError] = useState("");

  const create = async (then: "ask" | "myself") => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(then);
    setError("");
    try {
      const { album } = await api<{ album: GalleryAlbum }>("/api/library/gallery/albums/from", {
        method: "POST",
        body: JSON.stringify(source.kind === "items"
          ? { name: trimmed, itemIds: source.itemIds }
          : { name: trimmed, folder: { libraryId: source.libraryId, path: source.path } })
      });
      if (then === "ask") onAsk(album); else onMyself(album);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:askSomeone.unableToCreate"));
      setBusy(null);
    }
  };

  const count = source.kind === "items" ? source.itemIds.length : null;

  return (
    <Modal
      title={t("galleryModals:askSomeone.title")}
      icon={<MessageSquareText size={20} />}
      busy={busy !== null}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void create("ask"); }}
    >
      <p className="muted">
        {count != null
          ? t("galleryModals:askSomeone.bodyItems", { count })
          : t("galleryModals:askSomeone.bodyFolder", { folder: source.kind === "folder" ? (source.path || defaultName) : "" })}
      </p>

      {error && <MessageBox tone="error" title={t("galleryModals:askSomeone.unableToCreate")}>{error}</MessageBox>}

      <label className="gallery-bulk-edit-field">
        <span>{t("galleryModals:askSomeone.nameLabel")}</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          disabled={busy !== null}
          autoFocus
        />
      </label>
      <p className="muted gallery-bulk-edit-hint">{t("galleryModals:askSomeone.nameHint")}</p>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>{t("common:common.cancel")}</Button>
        <Button variant="secondary" onClick={() => void create("myself")} disabled={!name.trim() || busy !== null}>
          {busy === "myself" ? t("galleryModals:askSomeone.opening") : t("galleryModals:askSomeone.myself")}
        </Button>
        <Button variant="primary" type="submit" disabled={!name.trim() || busy !== null}>
          {busy === "ask" ? t("galleryModals:askSomeone.creating") : t("galleryModals:askSomeone.ask")}
        </Button>
      </div>
    </Modal>
  );
}
