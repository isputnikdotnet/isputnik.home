import { useState } from "react";
import { Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";
import { FolderPickerModal } from "./FolderPickerModal";
import type { StorageRoot, StorageBrowse } from "../types";

// Compact source-folder field for the create-library wizard. Browse opens the shared
// picker so the details step stays scannable; the wizard still owns the chosen root and
// relative path, because that is what it creates the library from.
export function SourceFolderPicker({
  storageRoots,
  selectedRootId,
  storageBrowse,
  onBrowse,
  onError
}: {
  storageRoots: StorageRoot[];
  selectedRootId: string;
  storageBrowse: StorageBrowse | null;
  onBrowse: (rootId: string, relativePath?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const folderLabel = storageBrowse?.selectedPath || t("control:libraries.chooseFolderPlaceholder");

  return (
    <>
      <div className="field source-folder-field">
        <span>{t("control:libraries.folderLabel")}</span>
        <div className="source-folder-control">
          <Folder size={19} aria-hidden="true" />
          <span>{folderLabel}</span>
          <Button variant="secondary" compact onClick={() => setPickerOpen(true)}>
            {t("common.browse")}
          </Button>
        </div>
      </div>

      {pickerOpen && (
        <FolderPickerModal
          title={t("control:libraries.selectFolderTitle")}
          intro={t("control:libraries.chooseFolderIntro")}
          storageRoots={storageRoots}
          initialRootId={selectedRootId}
          onPick={async ({ rootId, relativePath }) => {
            try {
              await onBrowse(rootId, relativePath);
              setPickerOpen(false);
            } catch (err) {
              onError(err instanceof Error ? err.message : t("control:libraries.unableToBrowseStorage"));
            }
          }}
          onClose={() => setPickerOpen(false)}
          onError={onError}
        />
      )}
    </>
  );
}
