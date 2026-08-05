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

// Where the copies actually are, in words. The covering folder is often a whole
// library — the copies are spread across several of its folders, or it was marked
// "keep here" — and naming it then says nothing you can go and open. So name the
// folders themselves, and fall back to the covering folder only when there are none
// to name (every copy loose at the library's top level).
function copiesLiveIn(row: ContainedFolder): string {
  const quoted = row.targetFolders.map((path) => `“${path || "."}”`);
  if (quoted.length === 0) return `“${row.target.name}”`;
  const named = quoted.length === 2 ? quoted.join(" and ") : quoted.join(", ");
  const hidden = row.targetFolderCount - quoted.length;
  return hidden > 0 ? `${named} and ${hidden} more folder${hidden === 1 ? "" : "s"}` : named;
}

function sortRows(list: ContainedFolder[], sort: FolderSort): ContainedFolder[] {
  const out = [...list];
  if (sort === "photos") return out.sort((a, b) => b.itemCount - a.itemCount);
  if (sort === "size") return out.sort((a, b) => b.bytes - a.bytes);
  if (sort === "name") return out.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
  return out.sort((a, b) => (b.folder.addedAt ?? "").localeCompare(a.folder.addedAt ?? ""));
}

export function DuplicateContainedFoldersSection() {
  const page = useDuplicateFolderPage<ContainedFolder>(
    "Unable to load the folders stored elsewhere",
    "/api/library/gallery/duplicates/folders/contained/search"
  );
  const { payload, busy, scopeName, needle } = page;

  const [deleteTarget, setDeleteTarget] = useState<ContainedFolder | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<ContainedFolder | null>(null);

  // One page of rows, already narrowed and ordered by the server — including the rule
  // that with a library chosen, only rows where BOTH sides live there make sense.
  const shown = page.list;
  const reclaimable = page.list.reclaimableBytes;

  // One row as a card, laid out like a set: what the folders hold, a strip of the
  // pictures themselves, then the kept folder and the one that goes side by side.
  const renderRow = (row: ContainedFolder, index: number) => {
    const labels = labelsOf(row);
    // What the keeper is left holding once this lands. Only worth saying when it
    // ENCLOSES the folder — then its own count includes the photos about to go, and
    // would otherwise look like it dropped for no reason.
    const remaining = row.itemCount + row.extraCount;
    const previewInfo = folderPreviewSummary(row.coverUrls, row.itemCount);
    // Says where the copies ARE, not merely which folder covers them — those are the
    // same thing only when the covering folder is a real folder rather than a library.
    const where = copiesLiveIn(row);
    const inLibrary = row.folder.libraryId === row.target.libraryId ? "" : ` in ${row.target.libraryName}`;
    const reason = row.extraCount > 0
      ? `Cleaning out “${labels.folder}” because every photo is also in ${where}${inLibrary}, which holds ${row.extraCount} more.`
      : `Cleaning out “${labels.folder}” because every photo is also in ${where}${inLibrary} — the same pictures, arranged differently.`;

    // What the kept side is CALLED. When the coverer is a real folder that's just its
    // name; when it is the library's top folder it isn't a folder anyone can go and
    // look at, and showing "." there put a root path on a card whose photos are
    // nowhere near the root. Say the library, and let the note below name the folders
    // the copies are really in — the totals on the tile are the library's, and now
    // the label agrees with them.
    const keptAtRoot = row.target.folderPath === "";
    const keptTile = keptAtRoot
      ? { ...row.target, name: row.target.libraryName, folderPath: "" }
      : row.target;

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
              folder={keptTile}
              keep
              showLibrary={!scopeName}
              position={0}
              busy={busy}
              // A library's top folder has no name worth showing, so the tile says
              // where the copies really are instead of leaving you with a dot.
              note={row.target.folderPath === ""
                ? `Copies sit in ${where}`
                : row.encloses
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
        {shown.total > 0
          ? (
            <>
              <span>{shown.total} folder{shown.total === 1 ? "" : "s"}</span>
              <span>{formatBytes(reclaimable)} to reclaim</span>
            </>
          )
          : null}
        <a href={controlHref("duplicatePhotos")}>Scanning and single photos are on the Duplicate photos tab</a>
        {payload.folderSetCount > 0 && (
          <a href={controlHref("duplicateFolders")}>
            {payload.folderSetCount} set{payload.folderSetCount === 1 ? "" : "s"} of identical folders
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

      {shown.allItems > 0 && (
        <DuplicateFolderToolbar page={page} searchHint="Search these folders by path or library" />
      )}

      {page.listLoaded && shown.allItems === 0 && !page.error && (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No folder is fully stored elsewhere. A folder holding even one photo that exists nowhere else isn't listed here."
            : "No scan has run yet. Start one on the Duplicate photos tab and the folders it finds appear here."}
        </p>
      )}

      {page.listLoaded && shown.allItems > 0 && shown.total === 0 && (
        <p className="management-empty">
          {page.filtering
            ? "Nothing matches what you've narrowed the page to."
            : "Nothing to show."}
        </p>
      )}

      {shown.total > 0 && (
        <>
          <div className="dup-sets">{shown.items.map(renderRow)}</div>
          <div className="dup-pager-row">
            <span className="datagrid-muted">
              Showing {shown.total} folder{shown.total === 1 ? "" : "s"}
            </span>
            <Pager page={shown.page} totalPages={Math.max(1, Math.ceil(shown.total / (page.perPage === "all" ? Math.max(shown.total, 1) : Number(page.perPage))))} onChange={page.setPage} label="Pages of folders stored elsewhere" />
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
