// Folders already stored elsewhere — one folder whose every photo also sits in
// another folder, which may hold more besides. This is the shape an equal-contents
// test can NEVER see: a folder copied into itself always holds strictly more than the
// copy inside it, so the two can't match, yet the inner one is pure redundancy.
//
// Its own tab beside Duplicate folders, and the same card: the decision differs, not
// the thing being decided about. One difference is real and deliberate — the keeper
// here is not a choice. Coverage runs one way, and offering the swap would delete the
// photos that exist only in the folder being kept.
import { useState } from "react";
import { Eye, FolderCheck, HardDrive, Images, Trash2 } from "lucide-react";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import {
  type ContainedFolder,
  type FolderSort,
  ExperimentalNotice,
  DuplicateFiltersModal,
  DuplicateFolderToolbar,
  FolderStrip,
  FolderTile,
  folderPathLabel,
  folderPreviewSummary,
  formatWhen,
  pageSlice,
  useDuplicateFolderPage
} from "./duplicate-shared";

// What to call the two sides of a pair. Their names collide constantly — a folder
// copied into itself has exactly the same name as its parent — and "all 6 photos in
// 2017-12-10 are also in 2017-12-10" is nonsense, so fall back to full paths the
// moment the names match.
function labelsOf(row: ContainedFolder): { folder: string; target: string } {
  if (row.folder.name !== row.target.name) return { folder: row.folder.name, target: row.target.name };
  return { folder: folderPathLabel(row.folder), target: folderPathLabel(row.target) };
}

function sortRows(list: ContainedFolder[], sort: FolderSort): ContainedFolder[] {
  const out = [...list];
  if (sort === "photos") return out.sort((a, b) => b.itemCount - a.itemCount);
  if (sort === "size") return out.sort((a, b) => b.bytes - a.bytes);
  if (sort === "name") return out.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
  return out.sort((a, b) => (b.folder.addedAt ?? "").localeCompare(a.folder.addedAt ?? ""));
}

export function DuplicateContainedFoldersSection() {
  const page = useDuplicateFolderPage("Unable to load the folders stored elsewhere");
  const { payload, busy, scopeName, needle } = page;

  const [deleteTarget, setDeleteTarget] = useState<ContainedFolder | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<ContainedFolder | null>(null);

  // With one library chosen, only rows where BOTH sides live there make sense —
  // removing a folder because its photos are safe in a library you aren't looking at
  // is a different decision.
  const rows = payload.containedFolders.filter((row) =>
    (!page.filters.scopeId
      || (row.folder.libraryId === page.filters.scopeId && row.target.libraryId === page.filters.scopeId))
    && (!needle
      || row.folder.folderPath.toLowerCase().includes(needle)
      || row.target.folderPath.toLowerCase().includes(needle)
      || row.folder.libraryName.toLowerCase().includes(needle))
    && (page.inChosenFolders(row.folder.libraryId, row.folder.folderPath)
      || page.inChosenFolders(row.target.libraryId, row.target.folderPath)));

  const ordered = sortRows(rows, page.sort);
  const shown = pageSlice(ordered, page.perPage, page.page);
  const reclaimable = rows.reduce((sum, row) => sum + row.bytes, 0);

  // One row as a card, laid out like a set: what the folders hold, a strip of the
  // pictures themselves, then the kept folder and the one that goes side by side.
  const renderRow = (row: ContainedFolder, index: number) => {
    const labels = labelsOf(row);
    // What the keeper is left holding once this lands. Only worth saying when it
    // ENCLOSES the folder — then its own count includes the photos about to go, and
    // would otherwise look like it dropped for no reason.
    const remaining = row.itemCount + row.extraCount;
    const previewInfo = folderPreviewSummary(row.coverUrls, row.itemCount);
    const reason = row.extraCount > 0
      ? `Cleaning out “${labels.folder}” because every photo is also in “${labels.target}”, which holds ${row.extraCount} more.`
      : `Cleaning out “${labels.folder}” because every photo is also in “${labels.target}” — the same pictures, arranged differently.`;

    const deleteThis = () => { page.setActionError(""); setDeleteTarget(row); };

    return (
      <div className="dup-set" key={row.id}>
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">Folder {index + 1}</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {row.itemCount} photo{row.itemCount === 1 ? "" : "s"}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(row.bytes)}</span>
              <span><Eye size={14} aria-hidden="true" /> {previewInfo}</span>
            </p>
            <p className="dup-set-explain datagrid-muted">{reason}</p>
          </div>
          <div className="dup-group-actions">
            <Button variant="secondary" compact disabled={busy} onClick={() => { page.setActionError(""); setIgnoreTarget(row); }}>
              Leave it
            </Button>
            <Button variant="secondary" danger compact className="dup-delete-action" disabled={busy} onClick={deleteThis}>
              <Trash2 size={14} />
              <span>Delete “{labels.folder}”</span>
            </Button>
          </div>
        </div>

        <div className="dup-set-body">
          <FolderStrip urls={row.coverUrls} />

          <div className="dup-set-folders">
            <FolderTile
              folder={row.target}
              keep
              showLibrary={!scopeName}
              position={0}
              busy={busy}
              note={row.encloses
                ? `Holds “${labels.folder}” inside it — ${remaining} photo${remaining === 1 ? "" : "s"} left after`
                : undefined}
            />
            <FolderTile
              folder={row.folder}
              keep={false}
              showLibrary={!scopeName}
              position={1}
              busy={busy}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <ControlSectionHead
        section="duplicateContainedFolders"
        className="dup-section-head"
        icon={<FolderCheck size={30} />}
        description="Folders whose every photo already sits in another folder, so the folder itself can go."
      >
      </ControlSectionHead>

      <p className="dup-status dup-status-row datagrid-muted">
        <span>Last scan: {formatWhen(payload.lastScanAt)}</span>
        {rows.length > 0
          ? (
            <>
              <span>{rows.length} folder{rows.length === 1 ? "" : "s"}</span>
              <span>{formatBytes(reclaimable)} to reclaim</span>
            </>
          )
          : null}
        <a href={controlHref("duplicatePhotos")}>Scanning and single photos are on the Duplicate photos tab</a>
        {payload.folderGroups.length > 0 && (
          <a href={controlHref("duplicateFolders")}>
            {payload.folderGroups.length} set{payload.folderGroups.length === 1 ? "" : "s"} of identical folders
          </a>
        )}
      </p>

      <ExperimentalNotice />

      {payload.scanning && (
        <MessageBox tone="info" title="Scan running">
          A duplicate scan is in progress. Folders appear here as soon as it finishes.
        </MessageBox>
      )}
      {page.error && <MessageBox tone="error" title="Unable to load the folders stored elsewhere">{page.error}</MessageBox>}
      {/* An open dialog carries the error itself — showing it here as well says the
          same thing twice, once where it can't be read behind the dialog. */}
      {page.actionError && !deleteTarget && !ignoreTarget && (
        <MessageBox tone="error" title="Action failed">{page.actionError}</MessageBox>
      )}

      {payload.containedFolders.length > 0 && (
        <DuplicateFolderToolbar page={page} searchHint="Search these folders by path or library" />
      )}

      {page.loaded && payload.containedFolders.length === 0 && !page.error && (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No folder is fully stored elsewhere. A folder holding even one photo that exists nowhere else isn't listed here."
            : "No scan has run yet. Start one on the Duplicate photos tab and the folders it finds appear here."}
        </p>
      )}

      {page.loaded && payload.containedFolders.length > 0 && rows.length === 0 && (
        <p className="management-empty">
          {page.filtering
            ? "Nothing matches what you've narrowed the page to."
            : "Nothing to show."}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="dup-sets">{shown.items.map(renderRow)}</div>
          <div className="dup-pager-row">
            <span className="datagrid-muted">
              Showing {shown.firstShown}–{shown.lastShown} of {ordered.length} folder{ordered.length === 1 ? "" : "s"}
            </span>
            <Pager page={shown.currentPage} totalPages={shown.totalPages} onChange={page.setPage} label="Pages of folders stored elsewhere" />
          </div>
        </>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete the folder “${labelsOf(deleteTarget).folder}”?`}
          confirmLabel={`Delete ${deleteTarget.itemCount} photo${deleteTarget.itemCount === 1 ? "" : "s"}`}
          busyLabel="Deleting…"
          danger
          busy={page.busyId === deleteTarget.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/contained/${deleteTarget.id}/resolve`,
            () => setDeleteTarget(null),
            "Unable to remove the folder",
            deleteTarget.id
          )}
          onCancel={() => setDeleteTarget(null)}
          rich
        >
          <p>
            Every one of the {deleteTarget.itemCount} photos in
            {" "}<strong>{folderPathLabel(deleteTarget.folder)}</strong> also sits in
            {" "}<strong>{folderPathLabel(deleteTarget.target)}</strong>
            {deleteTarget.folder.libraryId === deleteTarget.target.libraryId
              ? ""
              : ` in ${deleteTarget.target.libraryName}`}, which is not touched. That's checked again the
            moment you confirm — if even one photo here no longer has a copy there, nothing is deleted.
          </p>
          <p>
            Each photo hands its tags, albums, collections and tagged people to its copy in the kept folder first.
            The copies are the same file byte for byte, so tagged faces still line up.
          </p>
          <p>
            All {deleteTarget.itemCount} photo{deleteTarget.itemCount === 1 ? "" : "s"} go to the
            Recycle Bin and can be restored until it's emptied. The folder itself is left behind on disk, empty.
          </p>
        </ConfirmDialog>
      )}

      {ignoreTarget && (
        <ConfirmDialog
          title={`Leave “${labelsOf(ignoreTarget).folder}” alone?`}
          confirmLabel="Leave it"
          busyLabel="Saving…"
          busy={page.busyId === ignoreTarget.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/contained/${ignoreTarget.id}/ignore`,
            () => setIgnoreTarget(null),
            "Unable to dismiss the folder",
            ignoreTarget.id
          )}
          onCancel={() => setIgnoreTarget(null)}
          rich
        >
          <p>
            This folder stops being suggested for removal, whichever folder turns out to hold copies of its photos.
            Nothing is deleted and no photo is changed.
          </p>
          <p>Its photos are still compared with the rest individually, under Duplicate photos.</p>
        </ConfirmDialog>
      )}

      {page.filterOpen && (
        <DuplicateFiltersModal
          state={page.filters}
          options={page.folderOptions}
          libraries={payload.libraries}
          withTier={false}
          preferences={page.preferDraft}
          preferencesBusy={page.preferBusy}
          onPreferencesChange={(next) => void page.savePreferences(next)}
          onChange={page.setFilters}
          onClose={() => page.setFilterOpen(false)}
        />
      )}
    </>
  );
}
