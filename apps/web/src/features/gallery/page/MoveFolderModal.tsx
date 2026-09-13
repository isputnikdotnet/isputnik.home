import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import type { GalleryLibrary } from "../types";
import type { FolderMovePlan } from "./useFolderAdmin";

// Move the open folder into another gallery library: pick the target, see the
// server's dry run (how many items, where they land), then confirm.
export function MoveFolderModal({
  folder,
  targets,
  target,
  plan,
  busy,
  error,
  onPlan,
  onConfirm,
  onClose
}: {
  folder: string;
  targets: GalleryLibrary[];
  target: string;
  plan: FolderMovePlan | null;
  busy: boolean;
  error: string;
  onPlan: (targetLibraryId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <Modal
      variant="card"
      title={t("gallery:folders.moveDialogTitle", { folder })}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); onConfirm(); }}
    >
      <p>{t("gallery:folders.moveIntro")}</p>
      <SelectField
        label={t("gallery:folders.moveTargetLabel")}
        value={target}
        onChange={(value) => onPlan(value)}
        options={[
          { value: "", label: t("gallery:folders.moveTargetNone") },
          ...targets.map((library) => ({ value: library.id, label: library.role === "app-files" ? t("gallery:inbox.appFilesLabel", { name: library.name }) : library.name }))
        ]}
      />
      {plan && (
        <p className="datagrid-muted gallery-move-plan">
          {t("gallery:folders.movePlan", { count: plan.items, path: plan.to })}
        </p>
      )}
      {error && <MessageBox tone="error" title={t("gallery:folders.errors.move")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !plan}>
          {busy ? t("gallery:folders.moving") : t("gallery:folders.moveConfirm")}
        </Button>
      </div>
    </Modal>
  );
}
