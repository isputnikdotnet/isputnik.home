import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { AssetTile } from "../../gallery/AssetTile";
import type { GalleryAsset } from "../../gallery/types";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";

// "Review N" before a person's photos are shared (docs/people-sharing-plan.md,
// D6): the photos where recognition matched them but nobody said so. Every tile
// starts ticked; untick the ones that are not them. Confirming makes the ticked
// ones theirs — and so shared — and says the unticked ones are someone else.
// Opens over the Access dialog and returns to it.
const PAGE = 60;

export function PeopleReviewModal({ person, onClose, onDone }: {
  person: { id: string; name: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [assets, setAssets] = useState<GalleryAsset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [notThem, setNotThem] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ assets: GalleryAsset[]; total: number }>(`/api/library/gallery/people/${person.id}/review?limit=${PAGE}`)
      .then((payload) => { setAssets(payload.assets); setTotal(payload.total); })
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:access.review.errors.load")));
  }, [person.id, t]);

  const toggle = (id: string) => setNotThem((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const confirmCount = (assets?.length ?? 0) - notThem.size;
  const save = async () => {
    if (!assets) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/gallery/people/${person.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          confirm: assets.filter((a) => !notThem.has(a.id)).map((a) => a.id),
          reject: [...notThem]
        })
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:access.review.errors.save"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("controlAdmin:access.review.title", { name: person.name })}
      icon={<ScanFace size={20} />}
      className="access-review-modal"
      busy={saving}
      onClose={onClose}
    >
      <div className="modal-tab-content access-review-content">
        <p className="access-muted">{t("controlAdmin:access.review.hint", { name: person.name })}</p>
        {error && <MessageBox tone="error" title={t("controlAdmin:access.review.errors.title")}>{error}</MessageBox>}
        {!assets && !error && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
        {assets && assets.length === 0 && <p className="access-muted">{t("controlAdmin:access.review.empty", { name: person.name })}</p>}
        {assets && assets.length > 0 && (
          <div className="gallery-grid access-review-grid">
            {assets.map((asset) => (
              <div key={asset.id} className={notThem.has(asset.id) ? "access-review-tile is-not-them" : "access-review-tile"}>
                <AssetTile
                  asset={asset}
                  selectionMode
                  selected={!notThem.has(asset.id)}
                  onToggleSelect={() => toggle(asset.id)}
                  onOpen={() => toggle(asset.id)}
                />
              </div>
            ))}
          </div>
        )}
        {total > PAGE && <p className="access-muted">{t("controlAdmin:access.review.more", { count: total - PAGE })}</p>}
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !assets || assets.length === 0}>
          {saving
            ? t("controlAdmin:access.review.saving")
            : notThem.size > 0
              ? t("controlAdmin:access.review.confirmAndReject", { count: confirmCount, rejected: notThem.size })
              : t("controlAdmin:access.review.confirm", { count: confirmCount })}
        </Button>
      </div>
    </Modal>
  );
}
