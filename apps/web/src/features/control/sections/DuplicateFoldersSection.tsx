// Duplicate FOLDERS — one page for all three strengths of the same relationship:
//
//   Identical         two or more folders holding exactly the same photos.
//   Stored elsewhere  a folder whose every photo also sits in another folder,
//                     which may hold more besides.
//   Overlapping       two folders that merely SHARE some identical photos.
//
// They were three lists on two tabs, and the split made people check two places to
// answer one question about a folder. One paged list now, strongest statement first,
// each kind under its own heading with its own action:
//
//   identical  → keep one folder, delete the others
//   contained  → delete the covered folder outright
//   overlap    → delete only the shared copies from the losing side; both folders stay
//
// All three read the same scan and none runs one; the scan lives on Duplicate photos.
// Which side keeps is decided the same way everywhere: a library whose files can't be
// deleted always keeps, then your saved Keep/Clear folder instructions, then the
// usual scoring — and trashBook refuses a protected library regardless of what any
// page offers.
import { useState } from "react";
import { FolderOpen, HardDrive, Images } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import {
  type ContainedFolder,
  type DuplicateFolderDetail,
  type DuplicateFolderGroup,
  type DuplicateFolderMember,
  type FolderMatch,
  type FolderOverlapPair,
  ExperimentalNotice,
  DuplicateFiltersModal,
  DuplicateFolderToolbar,
  FolderStrip,
  FolderTile,
  folderKey,
  folderPathLabel,
  formatWhen,
  useDuplicateFolderPage
} from "./duplicate-shared";

// What to call the two sides of a pair. Their names collide constantly — a folder
// copied into itself has exactly the same name as its parent, and a partial
// re-import often keeps the name — so fall back to full paths the moment they match.
function pairLabels(one: DuplicateFolderDetail, other: DuplicateFolderDetail): { one: string; other: string } {
  if (one.name !== other.name) return { one: one.name, other: other.name };
  return { one: folderPathLabel(one), other: folderPathLabel(other) };
}

const containedLabels = (row: ContainedFolder) => {
  const labels = pairLabels(row.folder, row.target);
  return { folder: labels.one, target: labels.other };
};

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

export function DuplicateFoldersSection() {
  const page = useDuplicateFolderPage<FolderMatch>(
    "Unable to load duplicate folders",
    "/api/library/gallery/duplicates/folders/search"
  );
  const { payload, busy, scopeName } = page;

  // A folder set keeps exactly ONE folder — keeping two identical folders isn't
  // de-duplicating, and the stakes are a whole folder.
  const [keeperPick, setKeeperPick] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<DuplicateFolderGroup | null>(null);
  // Which of the set's folders the open confirm covers: one (a card's Delete this),
  // or every non-keeper (the header button, or the keeper card's Keep this).
  const [deleteFolders, setDeleteFolders] = useState<DuplicateFolderMember[] | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<DuplicateFolderGroup | null>(null);
  const [containedDelete, setContainedDelete] = useState<ContainedFolder | null>(null);
  const [containedIgnore, setContainedIgnore] = useState<ContainedFolder | null>(null);
  const [overlapDelete, setOverlapDelete] = useState<FolderOverlapPair | null>(null);
  const [overlapIgnore, setOverlapIgnore] = useState<FolderOverlapPair | null>(null);

  const dialogOpen = deleteTarget !== null || ignoreTarget !== null
    || containedDelete !== null || containedIgnore !== null
    || overlapDelete !== null || overlapIgnore !== null;

  // One page of matches, already scoped, narrowed and ordered by the server —
  // identical sets first, then stored-elsewhere, then overlaps, so a page can
  // straddle the boundaries with each kind under its own heading.
  const shown = page.list;
  const reclaimable = page.list.reclaimableBytes;
  // The pager's own arithmetic. The server clamps the page too and its answer wins,
  // so a list that shrank under you can't strand the view past the end.
  const perPage = page.perPage === "all" ? Math.max(shown.total, 1) : Number(page.perPage);
  const totalPages = Math.max(1, Math.ceil(shown.total / perPage));
  const firstShown = shown.total === 0 ? 0 : (shown.page - 1) * perPage + 1;
  const lastShown = Math.min(shown.page * perPage, shown.total);
  const pageIdentical = shown.items.filter((match): match is { kind: "identical" } & DuplicateFolderGroup => match.kind === "identical");
  const pageContained = shown.items.filter((match): match is { kind: "contained" } & ContainedFolder => match.kind === "contained");
  const pageOverlap = shown.items.filter((match): match is FolderOverlapPair => match.kind === "overlap");

  const keeperOf = (group: DuplicateFolderGroup): DuplicateFolderMember => {
    const picked = keeperPick[group.id];
    return group.members.find((member) => folderKey(member) === picked)
      ?? group.members.find((member) => member.isKeeper)
      ?? group.members[0];
  };

  // The keeper has to be settled on the server first when it isn't the one the scan
  // chose — otherwise it would refuse to delete the folder it still believes is kept.
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const group = deleteTarget;
    const keeper = keeperOf(group);
    const doomed = (deleteFolders ?? group.members)
      .filter((member) => folderKey(member) !== folderKey(keeper));
    if (doomed.length === 0) return;
    page.setBusyId(group.id);
    page.setActionError("");
    try {
      if (!keeper.isKeeper) {
        await api(`/api/library/gallery/duplicates/folders/${group.id}/keeper`, {
          method: "POST",
          body: JSON.stringify({ libraryId: keeper.libraryId, folderPath: keeper.folderPath })
        });
      }
      await api(`/api/library/gallery/duplicates/folders/${group.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          deleteFolders: doomed.map((member) => ({ libraryId: member.libraryId, folderPath: member.folderPath }))
        })
      });
      setKeeperPick((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      setDeleteTarget(null);
      setDeleteFolders(null);
      await page.reload();
    } catch (err) {
      page.setActionError(err instanceof Error ? err.message : "Unable to remove the folders");
    } finally {
      page.setBusyId("");
    }
  };

  // One set as a card: what the folders hold, a strip of the pictures themselves, then
  // the folders side by side — the one being kept first, each of the others after it.
  // Two is the common case but never assumed; a set can hold three copies of a folder.
  const renderGroup = (group: DuplicateFolderGroup, index: number) => {
    const keeper = keeperOf(group);
    const doomed = group.members.filter((member) => folderKey(member) !== folderKey(keeper));

    return (
      <div className="dup-set dup-folder-card" key={group.id}>
        <div className="dup-folder-card-main">
          <div className="dup-set-head">
            <div className="dup-set-summary">
              <h3 className="dup-set-title">Set {index + 1}</h3>
              <p className="dup-set-meta datagrid-muted">
                <span><Images size={14} aria-hidden="true" /> {group.itemCount} photo{group.itemCount === 1 ? "" : "s"}</span>
                <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(group.copyBytes)}</span>
              </p>
              {group.keeperReason && (
                <p className="dup-set-explain datagrid-muted">Kept because: {group.keeperReason}</p>
              )}
            </div>
          </div>
          <FolderStrip urls={keeper.coverUrls} total={group.itemCount} />
          <Button
            variant="text"
            compact
            className="dup-folder-dismiss-action"
            disabled={busy}
            onClick={() => { page.setActionError(""); setIgnoreTarget(group); }}
          >
            Not the same
          </Button>
        </div>

        <div className="dup-set-folders">
          {[keeper, ...doomed].map((member, position) => {
            const keep = folderKey(member) === folderKey(keeper);
            return (
              <FolderTile
                key={folderKey(member)}
                folder={member}
                keep={keep}
                position={position}
                busy={busy}
                onKeepInstead={keep
                  ? undefined
                  : () => setKeeperPick((current) => ({ ...current, [group.id]: folderKey(member) }))}
                action={keep ? (
                  <Button
                    variant="secondary"
                    compact
                    className="dup-set-action dup-set-keep-action"
                    disabled
                  >
                    Keep this
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    danger
                    compact
                    className="dup-set-action dup-set-delete-action"
                    disabled={busy}
                    onClick={() => { page.setActionError(""); setDeleteFolders([member]); setDeleteTarget(group); }}
                  >
                    Delete this
                  </Button>
                )}
              />
            );
          })}
        </div>
      </div>
    );
  };

  // One contained row as a card: the kept folder and the one that goes, side by side.
  const renderContained = (row: ContainedFolder, index: number) => {
    const labels = containedLabels(row);
    // What the keeper is left holding once this lands. Only worth saying when it
    // ENCLOSES the folder — then its own count includes the photos about to go, and
    // would otherwise look like it dropped for no reason.
    const remaining = row.itemCount + row.extraCount;
    const where = copiesLiveIn(row);
    const inLibrary = row.folder.libraryId === row.target.libraryId ? "" : ` in ${row.target.libraryName}`;
    const reason = row.extraCount > 0
      ? `Cleaning out “${labels.folder}” because every photo is also in ${where}${inLibrary}, which holds ${row.extraCount} more.`
      : `Cleaning out “${labels.folder}” because every photo is also in ${where}${inLibrary} — the same pictures, arranged differently.`;

    // A library's top folder isn't a folder anyone can go and look at; say the
    // library, and let the note name the folders the copies are really in.
    const keptAtRoot = row.target.folderPath === "";
    const keptTile = keptAtRoot ? { ...row.target, name: row.target.libraryName } : row.target;

    const deleteThis = () => { page.setActionError(""); setContainedDelete(row); };

    return (
      <div className="dup-set dup-folder-card" key={row.id}>
        <div className="dup-folder-card-main">
          <div className="dup-set-head">
            <div className="dup-set-summary">
              <h3 className="dup-set-title">Folder {index + 1}</h3>
              <p className="dup-set-meta datagrid-muted">
                <span><Images size={14} aria-hidden="true" /> {row.itemCount} photo{row.itemCount === 1 ? "" : "s"}</span>
                <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(row.bytes)}</span>
              </p>
              <p className="dup-set-explain datagrid-muted">{reason}</p>
            </div>
          </div>
          <FolderStrip urls={row.coverUrls} total={row.itemCount} />
          <Button variant="text" compact className="dup-folder-dismiss-action" disabled={busy} onClick={() => { page.setActionError(""); setContainedIgnore(row); }}>
            Leave it
          </Button>
        </div>

        <div className="dup-set-folders">
          <FolderTile
            folder={keptTile}
            keep
            position={0}
            busy={busy}
            note={row.target.folderPath === ""
              ? `Copies sit in ${where}`
              : row.encloses
                ? `Holds “${labels.folder}” inside it — ${remaining} photo${remaining === 1 ? "" : "s"} left after`
                : undefined}
            action={(
              <Button variant="secondary" compact className="dup-set-action dup-set-keep-action" disabled>
                Keep this
              </Button>
            )}
          />
          <FolderTile
            folder={row.folder}
            keep={false}
            position={1}
            busy={busy}
            action={(
              <Button variant="secondary" danger compact className="dup-set-action dup-set-delete-action" disabled={busy} onClick={deleteThis}>
                Delete this
              </Button>
            )}
          />
        </div>
      </div>
    );
  };

  // One overlap pair as a card. The narrowest action on the page: only the shared
  // copies on the losing side go, both folders stay — and the card says what each
  // side keeps, because "delete" next to a folder name otherwise reads as the whole
  // folder going.
  const renderOverlap = (pair: FolderOverlapPair, index: number) => {
    const labels = pairLabels(pair.lose, pair.keep);
    const reason = `${pair.sharedCount} photo${pair.sharedCount === 1 ? "" : "s"} in “${labels.one}” ${pair.sharedCount === 1 ? "is" : "are"} also
      in “${labels.other}”. The rest of each folder is not duplicated between them.`;

    const deleteThis = () => { page.setActionError(""); setOverlapDelete(pair); };

    return (
      <div className="dup-set dup-folder-card" key={pair.id}>
        <div className="dup-folder-card-main">
          <div className="dup-set-head">
            <div className="dup-set-summary">
              <h3 className="dup-set-title">Pair {index + 1}</h3>
              <p className="dup-set-meta datagrid-muted">
                <span><Images size={14} aria-hidden="true" /> {pair.sharedCount} shared photo{pair.sharedCount === 1 ? "" : "s"}</span>
                <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(pair.sharedBytes)}</span>
              </p>
              <p className="dup-set-explain datagrid-muted">
                {reason}
                {pair.keeperReason ? ` Keeping “${labels.other}”'s copies because: ${pair.keeperReason}.` : ""}
              </p>
            </div>
          </div>
          <FolderStrip urls={pair.coverUrls} total={pair.sharedCount} />
          <Button variant="text" compact className="dup-folder-dismiss-action" disabled={busy} onClick={() => { page.setActionError(""); setOverlapIgnore(pair); }}>
            Not the same
          </Button>
        </div>

        <div className="dup-set-folders">
          <FolderTile
            folder={pair.keep}
            keep
            position={0}
            busy={busy}
            note="All its photos stay, shared ones included"
            action={(
              <Button variant="secondary" compact className="dup-set-action dup-set-keep-action" disabled>
                Keep this
              </Button>
            )}
          />
          <FolderTile
            folder={pair.lose}
            keep={false}
            position={1}
            busy={busy}
            note={pair.loseExtraCount > 0
              ? `Only the ${pair.sharedCount} shared cop${pair.sharedCount === 1 ? "y" : "ies"} go — its ${pair.loseExtraCount} own photo${pair.loseExtraCount === 1 ? "" : "s"} stay`
              : `The ${pair.sharedCount} shared cop${pair.sharedCount === 1 ? "y" : "ies"} go; the folder itself stays`}
            action={(
              <Button
                variant="secondary"
                danger
                compact
                className="dup-set-action dup-set-delete-action"
                disabled={busy || !pair.canDelete}
                title={pair.canDelete
                  ? undefined
                  : "Both folders are in libraries that don't allow deleting, so neither side's copies can be removed"}
                onClick={deleteThis}
              >
                Delete copies
              </Button>
            )}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      <ControlSectionHead
        section="duplicateFolders"
        className="dup-section-head"
        iconClassName="duplicates"
        icon={<FolderOpen size={30} />}
        description="Folders that duplicate, contain or overlap another folder, handled in one go."
      >
      </ControlSectionHead>

      <p className="dup-status dup-status-row datagrid-muted">
        <span>Last scan: {formatWhen(payload.lastScanAt)}</span>
        {shown.total > 0
          ? (
            <>
              <span>{shown.allItems} duplicate set{shown.allItems === 1 ? "" : "s"}</span>
              <span>{formatBytes(reclaimable)} to reclaim</span>
            </>
          )
          : null}
        <a href={controlHref("duplicatePhotos")}>Scanning and single photos are on the Duplicate photos tab</a>
      </p>

      <ExperimentalNotice />

      {payload.scanning && (
        <MessageBox tone="info" title="Scan running">
          A duplicate scan is in progress. Folders appear here as soon as it finishes.
        </MessageBox>
      )}
      {page.error && <MessageBox tone="error" title="Unable to load duplicate folders">{page.error}</MessageBox>}
      {/* An open dialog carries the error itself — showing it here as well says the
          same thing twice, once where it can't be read behind the dialog. */}
      {page.actionError && !dialogOpen && (
        <MessageBox tone="error" title="Action failed">{page.actionError}</MessageBox>
      )}

      {shown.allItems > 0 && (
        <DuplicateFolderToolbar page={page} searchHint="Search folder matches by path or library" />
      )}

      {page.listLoaded && shown.allItems === 0 && !page.error && (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No folder duplicates, contains or overlaps another. Single duplicated photos still appear under Duplicate photos."
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

      {/* The heading stands whether or not the kind has results on THIS page — but a
          kind with none anywhere is not announced, because "no folder overlaps" is
          already said by the empty state above. */}
      {pageIdentical.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Identical folders</h2>
          <p className="datagrid-muted dup-tier-note">
            The same pictures, file for file, whatever the folders are called. One is kept; the others can go whole.
          </p>
          <div className="dup-sets">{pageIdentical.map(renderGroup)}</div>
        </>
      )}

      {pageContained.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Folders already stored elsewhere</h2>
          <p className="datagrid-muted dup-tier-note">
            Every photo in these folders also sits in another folder, so the folder itself can go and nothing is lost.
          </p>
          <div className="dup-sets">{pageContained.map(renderContained)}</div>
        </>
      )}

      {pageOverlap.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Folders sharing some photos</h2>
          <p className="datagrid-muted dup-tier-note">
            Two folders holding SOME identical photos — a partial copy, a “best of”, half a card re-imported. Only the
            shared copies on one side are offered for deletion; both folders stay.
          </p>
          <div className="dup-sets">{pageOverlap.map(renderOverlap)}</div>
        </>
      )}

      {shown.total > 0 && (
        <div className="dup-pager-row">
          <span className="datagrid-muted">
            Showing {firstShown}–{lastShown} of {shown.total} set{shown.total === 1 ? "" : "s"}
          </span>
          <Pager page={shown.page} totalPages={totalPages} onChange={page.setPage} label="Folder match pages" />
        </div>
      )}

      {deleteTarget && (() => {
        const keeper = keeperOf(deleteTarget);
        const doomed = (deleteFolders ?? deleteTarget.members)
          .filter((member) => folderKey(member) !== folderKey(keeper));
        const photos = doomed.reduce((sum, member) => sum + member.itemCount, 0);
        return (
          <ConfirmDialog
            title={doomed.length === 1 ? `Delete the folder “${doomed[0].name}”?` : `Delete ${doomed.length} folders?`}
            confirmLabel={`Delete ${photos} photo${photos === 1 ? "" : "s"}`}
            busyLabel="Deleting…"
            danger
            busy={page.busyId === deleteTarget.id}
            error={page.actionError}
            onConfirm={confirmDelete}
            onCancel={() => { setDeleteTarget(null); setDeleteFolders(null); }}
            rich
          >
            <p>
              <strong>{folderPathLabel(keeper)}</strong>{scopeName ? "" : ` in ${keeper.libraryName}`} is kept, with all
              {" "}{keeper.itemCount} of its photos. {doomed.length === 1 ? "The other folder" : `The other ${doomed.length} folders`}
              {" "}hold the same pictures file for file, which is checked again the moment you confirm — if anything in
              them has changed since the scan, nothing is deleted.
            </p>
            <p>
              Each photo hands its tags, albums, collections and tagged people to the photo at the same place inside the
              kept folder first, so nothing you filed by hand is lost. The faces line up exactly — these are the same
              files, byte for byte.
            </p>
            <p>
              All {photos} photo{photos === 1 ? "" : "s"} go to the Recycle Bin and can be restored until it's emptied.
              The folders themselves are left behind on disk, empty.
            </p>
          </ConfirmDialog>
        );
      })()}

      {ignoreTarget && (
        <ConfirmDialog
          title="Mark these as different folders?"
          confirmLabel="Not the same"
          busyLabel="Saving…"
          busy={page.busyId === ignoreTarget.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/${ignoreTarget.id}/ignore`,
            () => setIgnoreTarget(null),
            "Unable to dismiss the folder set",
            ignoreTarget.id
          )}
          onCancel={() => setIgnoreTarget(null)}
          rich
        >
          <p>
            This set disappears and future scans won't pair these folders again. Nothing is deleted and no photo is
            changed.
          </p>
          <p>The photos inside them are still compared with each other individually, under Duplicate photos.</p>
        </ConfirmDialog>
      )}

      {containedDelete && (
        <ConfirmDialog
          title={`Delete the folder “${containedLabels(containedDelete).folder}”?`}
          confirmLabel={`Delete ${containedDelete.itemCount} photo${containedDelete.itemCount === 1 ? "" : "s"}`}
          busyLabel="Deleting…"
          danger
          busy={page.busyId === containedDelete.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/contained/${containedDelete.id}/resolve`,
            () => setContainedDelete(null),
            "Unable to remove the folder",
            containedDelete.id
          )}
          onCancel={() => setContainedDelete(null)}
          rich
        >
          <p>
            Every one of the {containedDelete.itemCount} photos in
            {" "}<strong>{folderPathLabel(containedDelete.folder)}</strong> also sits in
            {" "}<strong>{folderPathLabel(containedDelete.target)}</strong>
            {containedDelete.folder.libraryId === containedDelete.target.libraryId
              ? ""
              : ` in ${containedDelete.target.libraryName}`}, which is not touched. That's checked again the
            moment you confirm — if even one photo here no longer has a copy there, nothing is deleted.
          </p>
          <p>
            Each photo hands its tags, albums, collections and tagged people to its copy in the kept folder first.
            The copies are the same file byte for byte, so tagged faces still line up.
          </p>
          <p>
            All {containedDelete.itemCount} photo{containedDelete.itemCount === 1 ? "" : "s"} go to the
            Recycle Bin and can be restored until it's emptied. The folder itself is left behind on disk, empty.
          </p>
        </ConfirmDialog>
      )}

      {containedIgnore && (
        <ConfirmDialog
          title={`Leave “${containedLabels(containedIgnore).folder}” alone?`}
          confirmLabel="Leave it"
          busyLabel="Saving…"
          busy={page.busyId === containedIgnore.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/contained/${containedIgnore.id}/ignore`,
            () => setContainedIgnore(null),
            "Unable to dismiss the folder",
            containedIgnore.id
          )}
          onCancel={() => setContainedIgnore(null)}
          rich
        >
          <p>
            This folder stops being suggested for removal, whichever folder turns out to hold copies of its photos.
            Nothing is deleted and no photo is changed.
          </p>
          <p>Its photos are still compared with the rest individually, under Duplicate photos.</p>
        </ConfirmDialog>
      )}

      {overlapDelete && (() => {
        const labels = pairLabels(overlapDelete.lose, overlapDelete.keep);
        return (
          <ConfirmDialog
            title={`Delete ${overlapDelete.sharedCount} duplicated photo${overlapDelete.sharedCount === 1 ? "" : "s"} from “${labels.one}”?`}
            confirmLabel={`Delete ${overlapDelete.sharedCount} cop${overlapDelete.sharedCount === 1 ? "y" : "ies"}`}
            busyLabel="Deleting…"
            danger
            busy={page.busyId === overlapDelete.id}
            error={page.actionError}
            onConfirm={() => page.post(
              `/api/library/gallery/duplicates/folders/overlaps/${overlapDelete.id}/resolve`,
              () => setOverlapDelete(null),
              "Unable to remove the copies",
              overlapDelete.id
            )}
            onCancel={() => setOverlapDelete(null)}
            rich
          >
            <p>
              Only the photos these two folders hold in common are deleted, and only from
              {" "}<strong>{folderPathLabel(overlapDelete.lose)}</strong>
              {overlapDelete.lose.libraryId === overlapDelete.keep.libraryId ? "" : ` in ${overlapDelete.lose.libraryName}`}.
              {" "}What's shared is worked out again the moment you confirm, and which side keeps is re-decided under the
              current library policies and folder instructions — so a choice changed since this page loaded is honoured.
            </p>
            <p>
              Each deleted copy hands its tags, albums, collections and tagged people to its byte-identical counterpart
              in <strong>{folderPathLabel(overlapDelete.keep)}</strong>, which keeps every one of its photos.
              {overlapDelete.loseExtraCount > 0
                ? ` The ${overlapDelete.loseExtraCount} photo${overlapDelete.loseExtraCount === 1 ? "" : "s"} “${labels.one}” holds that aren't duplicated stay where they are.`
                : ""}
            </p>
            <p>
              Everything removed goes to the Recycle Bin and can be restored until it's emptied. Both folders remain.
            </p>
          </ConfirmDialog>
        );
      })()}

      {overlapIgnore && (
        <ConfirmDialog
          title="Stop pairing these folders?"
          confirmLabel="Not the same"
          busyLabel="Saving…"
          busy={page.busyId === overlapIgnore.id}
          error={page.actionError}
          onConfirm={() => page.post(
            `/api/library/gallery/duplicates/folders/overlaps/${overlapIgnore.id}/ignore`,
            () => setOverlapIgnore(null),
            "Unable to dismiss the pair",
            overlapIgnore.id
          )}
          onCancel={() => setOverlapIgnore(null)}
          rich
        >
          <p>
            This pair disappears and future scans won't put these two folders side by side again. Nothing is deleted
            and no photo is changed.
          </p>
          <p>The shared photos are still compared individually, under Duplicate photos.</p>
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
