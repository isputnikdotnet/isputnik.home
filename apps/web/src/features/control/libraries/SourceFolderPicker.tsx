import { useState } from "react";
import { Folder } from "lucide-react";
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const folderLabel = storageBrowse?.selectedPath || "Choose a folder...";

  return (
    <>
      <div className="field source-folder-field">
        <span>Folder</span>
        <div className="source-folder-control">
          <Folder size={19} aria-hidden="true" />
          <span>{folderLabel}</span>
          <Button variant="secondary" compact onClick={() => setPickerOpen(true)}>
            Browse
          </Button>
        </div>
      </div>

      {pickerOpen && (
        <FolderPickerModal
          title="Select library folder"
          intro="Choose a folder inside an approved container."
          storageRoots={storageRoots}
          initialRootId={selectedRootId}
          onPick={async ({ rootId, relativePath }) => {
            try {
              await onBrowse(rootId, relativePath);
              setPickerOpen(false);
            } catch (err) {
              onError(err instanceof Error ? err.message : "Unable to browse storage container");
            }
          }}
          onClose={() => setPickerOpen(false)}
          onError={onError}
        />
      )}
    </>
  );
}
