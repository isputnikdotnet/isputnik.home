import type { StorageRoot, StorageBrowse } from "../types";

// Storage-root container select + folder browser used by the create-library wizards.
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
  const browse = (rootId: string, relativePath = "") => {
    onBrowse(rootId, relativePath).catch((err) =>
      onError(err instanceof Error ? err.message : "Unable to browse storage container"));
  };

  return (
    <>
      <label className="field">
        <span>Container</span>
        <select value={selectedRootId} onChange={(event) => browse(event.target.value)} required>
          {storageRoots.map((root) => (
            <option value={root.id} key={root.id}>{root.name}</option>
          ))}
        </select>
      </label>
      {storageBrowse && (
        <section className="folder-browser" aria-label="Library folder browser">
          <div className="folder-browser-head">
            <div>
              <strong>{storageBrowse.currentPath || storageBrowse.root.name}</strong>
              <span>{storageBrowse.selectedPath}</span>
            </div>
            {storageBrowse.parentPath !== null && (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => browse(storageBrowse.root.id, storageBrowse.parentPath ?? "")}
              >
                Up
              </button>
            )}
          </div>
          <div className="folder-list">
            {storageBrowse.entries.map((entry) => (
              <button
                className="folder-row"
                type="button"
                key={entry.relativePath}
                onClick={() => browse(storageBrowse.root.id, entry.relativePath)}
              >
                {entry.name}
              </button>
            ))}
            {storageBrowse.entries.length === 0 && <p className="management-empty">No child folders found. The current folder can still be used.</p>}
          </div>
        </section>
      )}
    </>
  );
}
