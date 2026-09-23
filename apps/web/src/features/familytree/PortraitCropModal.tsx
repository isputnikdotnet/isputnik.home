import { useEffect, useMemo, useState } from "react";
import { Crop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { CropPreview, ImageCropper, type CropFrame, type CropperFace } from "../../shared/ImageCropper";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset } from "../gallery/types";
import type { FamilyPerson } from "./types";

// Cut a family member's portrait out of a gallery photo — one face out of a group
// shot, framed with a click (docs/people-sharing-plan.md, phase 4). The server
// renders it into the tree's own storage, so everyone who reads the tree sees it,
// and keeps a copy in App files → Family tree → Portraits.
export function PortraitCropModal({
  person,
  itemId,
  onClose,
  onSaved
}: {
  person: FamilyPerson;
  itemId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [asset, setAsset] = useState<GalleryAsset | null>(null);
  // Re-cropping the same photo starts from the frame it was cut to.
  const [frame, setFrame] = useState<CropFrame | null>(
    person.portraitItemId === itemId ? person.portraitCrop : null
  );
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${itemId}`)
      .then((payload) => setAsset(payload.asset))
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("family:portraitCrop.errors.loadPhoto")));
  }, [itemId, t]);

  const faces = useMemo<CropperFace[]>(
    () => (asset?.faces ?? []).map((face) => ({ id: face.id, box: face.box, label: face.personName ?? "" })),
    [asset]
  );
  // The linked face cluster's face on this photo is framed first.
  const linkedFaceId = useMemo(
    () => (asset?.faces ?? []).find((face) => person.galleryPersonId && face.personId === person.galleryPersonId)?.id ?? null,
    [asset, person.galleryPersonId]
  );
  const src = asset?.previewUrl ?? asset?.coverUrl ?? null;

  const save = async () => {
    if (!frame) return;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/api/family-tree/persons/${person.id}/portrait/crop`, {
        method: "POST",
        body: JSON.stringify({ itemId, crop: frame })
      });
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("family:portraitCrop.errors.save"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("family:portraitCrop.title", { name: person.name })}
      icon={<Crop size={18} />}
      className="ft-modal ft-portrait-crop-modal"
      busy={saving}
      onClose={onClose}
    >
      <div className="ft-portrait-crop">
        {loadError && <MessageBox tone="error" title={t("family:portraitCrop.errors.loadPhoto")}>{loadError}</MessageBox>}
        {saveError && <MessageBox tone="error" title={t("family:portraitCrop.errors.save")}>{saveError}</MessageBox>}
        {!loadError && !src && <p className="ft-modal-hint">{t("family:portraitCrop.loading")}</p>}
        {src && (
          <div className="ft-portrait-crop-body">
            <div className="ft-portrait-crop-stage">
              <ImageCropper
                src={src}
                alt={asset?.title ?? ""}
                value={frame}
                onChange={setFrame}
                faces={faces}
                initialFaceId={linkedFaceId}
              />
            </div>
            <aside className="ft-portrait-crop-side">
              <CropPreview src={src} frame={frame} size={160} round />
              <p className="ft-modal-hint">
                {faces.length > 0 ? t("family:portraitCrop.hint") : t("family:portraitCrop.hintNoFaces")}
              </p>
              <p className="ft-modal-hint">{t("family:portraitCrop.keptNote")}</p>
            </aside>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !frame}>
            {saving ? t("family:portraitCrop.saving") : t("family:portraitCrop.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
