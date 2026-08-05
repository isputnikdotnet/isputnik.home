// Duplicate FOLDERS — two or more folders holding exactly the same photos, file for
// file, whatever they are called. One decision here settles hundreds of the photo sets
// on Duplicate photos.
//
// The other folder-shaped answer — a folder whose photos all sit in some LARGER folder
// — is its own tab, DuplicateContainedFoldersSection. Both read the same scan and
// neither runs one; the scan lives on Duplicate photos, so there is one place that
// starts work and one place per answer that reports it.
import { useState } from "react";
import { Eye, FolderOpen, HardDrive, Images, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import {
  type DuplicateFolderGroup,
  type DuplicateFolderMember,
  type FolderSort,
  ExperimentalNotice,
  DuplicateFiltersModal,
  DuplicateFolderToolbar,
  FolderStrip,
  FolderTile,
  folderKey,
  folderPathLabel,
  folderPreviewSummary,
  formatWhen,
  pageSlice,
  useDuplicateFolderPage
} from "./duplicate-shared";

// A set is dated by the newest folder in it — the copy you most recently acquired is
// what makes a pair feel recent, not the original it duplicates.
const setDate = (group: DuplicateFolderGroup): string =>
  group.members.reduce((latest, member) => (member.addedAt && member.addedAt > latest ? member.addedAt : latest), "");

function sortSets(list: DuplicateFolderGroup[], sort: FolderSort): DuplicateFolderGroup[] {
  const out = [...list];
  if (sort === "photos") return out.sort((a, b) => b.itemCount - a.itemCount);
  if (sort === "size") return out.sort((a, b) => b.copyBytes - a.copyBytes);
  if (sort === "name") return out.sort((a, b) => (a.members[0]?.name ?? "").localeCompare(b.members[0]?.name ?? ""));
  return out.sort((a, b) => setDate(b).localeCompare(setDate(a)));
}

// The same rule the photo sets follow under a chosen library: only folders inside it
// are compared, and a set left with fewer than two of them isn't a duplicate there.
function scopeFolderGroup(group: DuplicateFolderGroup, libraryId: string): DuplicateFolderGroup | null {
  if (!libraryId) return group;
  const mine = group.members.filter((member) => member.libraryId === libraryId);
  if (mine.length < 2) return null;
  const keeper = mine.find((member) => member.isKeeper) ?? mine[0];
  return {
    ...group,
    members: mine.map((member) => ({ ...member, isKeeper: folderKey(member) === folderKey(keeper) })),
    reclaimableBytes: mine.filter((member) => folderKey(member) !== folderKey(keeper))
      .reduce((sum, member) => sum + member.bytes, 0)
  };
}

export function DuplicateFoldersSection() {
  const page = useDuplicateFolderPage<DuplicateFolderGroup>(
    "Unable to load duplicate folders",
    "/api/library/gallery/duplicates/folders/search"
  );
  const { payload, busy, scopeName, needle } = page;

  // A folder set keeps exactly ONE folder — keeping two identical folders isn't
  // de-duplicating, and the stakes are a whole folder.
  const [keeperPick, setKeeperPick] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<DuplicateFolderGroup | null>(null);
  // Which of the set's folders the open confirm covers: one (a card's Delete this),
  // or every non-keeper (the header button, or the keeper card's Keep this).
  const [deleteFolders, setDeleteFolders] = useState<DuplicateFolderMember[] | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<DuplicateFolderGroup | null>(null);

  // One page of sets, already scoped to the chosen library, narrowed and ordered by
  // the server — including the rule that a set left with fewer than two folders in
  // that library is not a duplicate there.
  const shown = page.list;
  const reclaimable = page.list.reclaimableBytes;

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
      await page.load();
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
    const previewInfo = folderPreviewSummary(keeper.coverUrls, group.itemCount);

    return (
      <div className="dup-set" key={group.id}>
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">Set {index + 1}</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {group.itemCount} photo{group.itemCount === 1 ? "" : "s"}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(group.copyBytes)}</span>
              <span><Eye size={14} aria-hidden="true" /> {previewInfo}</span>
            </p>
            {group.keeperReason && (
              <p className="dup-set-explain datagrid-muted">Kept because: {group.keeperReason}</p>
            )}
          </div>
          <div className="dup-group-actions">
            <Button variant="secondary" compact disabled={busy} onClick={() => { page.setActionError(""); setIgnoreTarget(group); }}>
              Not the same
            </Button>
            <Button
              variant="secondary"
              danger
              compact
              className="dup-delete-action"
              disabled={busy || doomed.length === 0}
              onClick={() => { page.setActionError(""); setDeleteFolders(null); setDeleteTarget(group); }}
            >
              <Trash2 size={14} />
              <span>Delete {doomed.length} folder{doomed.length === 1 ? "" : "s"}</span>
            </Button>
          </div>
        </div>

        <div className="dup-set-body">
          <FolderStrip urls={keeper.coverUrls} />

          <div className="dup-set-folders">
            {[keeper, ...doomed].map((member, position) => {
              const keep = folderKey(member) === folderKey(keeper);
              return (
                <FolderTile
                  key={folderKey(member)}
                  folder={member}
                  keep={keep}
                  showLibrary={!scopeName}
                  position={position}
                  busy={busy}
                  onKeepInstead={keep
                    ? undefined
                    : () => setKeeperPick((current) => ({ ...current, [group.id]: folderKey(member) }))}
                />
              );
            })}
          </div>
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
        description="Review duplicate folder pairs and remove extras."
      >
      </ControlSectionHead>

      <p className="dup-status dup-status-row datagrid-muted">
        <span>Last scan: {formatWhen(payload.lastScanAt)}</span>
        {shown.total > 0
          ? (
            <>
              <span>{shown.total} duplicate set{shown.total === 1 ? "" : "s"}</span>
              <span>{formatBytes(reclaimable)} to reclaim</span>
            </>
          )
          : null}
        <a href={controlHref("duplicatePhotos")}>Scanning and single photos are on the Duplicate photos tab</a>
        {payload.containedCount > 0 && (
          <a href={controlHref("duplicateContainedFolders")}>
            {payload.containedCount} folder{payload.containedCount === 1 ? " is" : "s are"} already
            {" "}stored elsewhere
          </a>
        )}
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
      {page.actionError && !deleteTarget && !ignoreTarget && (
        <MessageBox tone="error" title="Action failed">{page.actionError}</MessageBox>
      )}

      {shown.allItems > 0 && (
        <DuplicateFolderToolbar page={page} searchHint="Search duplicate folders by path or library" />
      )}

      {page.listLoaded && shown.allItems === 0 && !page.error && (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No folder holds exactly the same photos as another. A folder differing by even one photo isn't listed here — its copies still appear individually under Duplicate photos."
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
          <div className="dup-sets">{shown.items.map(renderGroup)}</div>
          <div className="dup-pager-row">
            <span className="datagrid-muted">
              Showing {shown.total} set{shown.total === 1 ? "" : "s"}
            </span>
            <Pager page={shown.page} totalPages={Math.max(1, Math.ceil(shown.total / (page.perPage === "all" ? Math.max(shown.total, 1) : Number(page.perPage))))} onChange={page.setPage} label="Duplicate folder pages" />
          </div>
        </>
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
