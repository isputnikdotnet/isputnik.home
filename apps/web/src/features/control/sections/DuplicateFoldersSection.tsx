// Duplicate FOLDERS — the two folder-shaped answers a duplicate scan produces, on
// their own page because they are a different unit of work from the photo sets next
// door: one decision here settles hundreds of those.
//
//   Duplicate folders            two folders holding exactly the same photos.
//   Already stored elsewhere     one folder whose every photo also sits in another,
//                                which may hold more besides — the shape an exact
//                                match can never see, most often a folder copied
//                                into itself.
//
// Both read the same scan as Duplicate photos; neither runs one. The scan lives on
// that page, so there is one place that starts work and one place that reports it.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, FolderHeart, FolderOpen, HardDrive, ImageOff, Images, Info, Search, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { LibraryMenu } from "../../../shared/LibraryMenu";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import {
  type ContainedFolder,
  type DuplicateFolderGroup,
  type DuplicateFolderMember,
  type DuplicatePayload,
  EMPTY_PAYLOAD,
  ExperimentalNotice,
  FolderFilterModal,
  PreferredFoldersModal,
  folderCovers,
  folderKey,
  folderOptionsFrom,
  folderPathLabel,
  normalisePayload
} from "./duplicate-shared";

function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// What to call the two sides of a contained pair. Their names collide constantly — a
// folder copied into itself has exactly the same name as its parent — and "all 6
// photos in 2017-12-10 are also in 2017-12-10" is nonsense, so fall back to full paths
// the moment the names match.
function containedLabels(row: ContainedFolder): { folder: string; target: string } {
  if (row.folder.name !== row.target.name) return { folder: row.folder.name, target: row.target.name };
  return { folder: folderPathLabel(row.folder), target: folderPathLabel(row.target) };
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
  const [payload, setPayload] = useState<DuplicatePayload>(EMPTY_PAYLOAD);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [search, setSearch] = useState("");

  // A folder set keeps exactly ONE folder — keeping two identical folders isn't
  // de-duplicating, and the stakes are a whole folder.
  const [keeperPick, setKeeperPick] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<DuplicateFolderGroup | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<DuplicateFolderGroup | null>(null);
  const [containedDeleteTarget, setContainedDeleteTarget] = useState<ContainedFolder | null>(null);
  const [containedIgnoreTarget, setContainedIgnoreTarget] = useState<ContainedFolder | null>(null);

  const [folderFilter, setFolderFilter] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [preferOpen, setPreferOpen] = useState(false);
  const [preferDraft, setPreferDraft] = useState<string[]>([]);
  const [preferBusy, setPreferBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    setPayload(normalisePayload(await api<DuplicatePayload>("/api/library/gallery/duplicates")));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load duplicate folders"))
      .finally(() => setLoaded(true));
  }, []);

  // A scan started on the Duplicate photos page rebuilds these too, so follow it here
  // rather than showing a stale list until the tab is reopened.
  useEffect(() => {
    if (!payload.scanning) {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => { void load().catch(() => { /* keep polling */ }); }, 3000);
    return () => {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [payload.scanning]);

  const busy = preferBusy || busyId !== "";
  const scopeName = payload.libraries.find((library) => library.id === scopeId)?.name ?? "";
  const needle = search.trim().toLowerCase();

  const folderOptions = folderOptionsFrom(payload);
  const chosenFolders = folderOptions.filter((option) => folderFilter.includes(option.key));
  const inChosenFolders = (libraryId: string, path: string) =>
    chosenFolders.length === 0 || chosenFolders.some((folder) => folderCovers(folder, libraryId, path));

  const groups = payload.folderGroups
    .map((group) => scopeFolderGroup(group, scopeId))
    .filter((group): group is DuplicateFolderGroup => group !== null)
    .filter((group) => group.members.some((member) =>
      (!needle
        || member.folderPath.toLowerCase().includes(needle)
        || member.libraryName.toLowerCase().includes(needle))
      && inChosenFolders(member.libraryId, member.folderPath)));

  // With one library chosen, only rows where BOTH sides live there make sense —
  // removing a folder because its photos are safe in a library you aren't looking at
  // is a different decision.
  const contained = payload.containedFolders.filter((row) =>
    (!scopeId || (row.folder.libraryId === scopeId && row.target.libraryId === scopeId))
    && (!needle
      || row.folder.folderPath.toLowerCase().includes(needle)
      || row.target.folderPath.toLowerCase().includes(needle)
      || row.folder.libraryName.toLowerCase().includes(needle))
    && (inChosenFolders(row.folder.libraryId, row.folder.folderPath)
      || inChosenFolders(row.target.libraryId, row.target.folderPath)));

  const filtering = needle !== "" || scopeId !== "" || chosenFolders.length > 0;
  const anythingFound = payload.folderGroups.length > 0 || payload.containedFolders.length > 0;
  const reclaimable = groups.reduce((sum, group) => sum + group.reclaimableBytes, 0)
    + contained.reduce((sum, row) => sum + row.bytes, 0);

  const scopeOptions = [
    { value: "", label: "All libraries" },
    ...payload.libraries.map((library) => ({ value: library.id, label: library.name }))
  ];

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
    const doomed = group.members.filter((member) => folderKey(member) !== folderKey(keeper));
    if (doomed.length === 0) return;
    setBusyId(group.id);
    setActionError("");
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
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the folders");
    } finally {
      setBusyId("");
    }
  };

  const post = async (path: string, onDone: () => void, whenFailed: string, id: string) => {
    setBusyId(id);
    setActionError("");
    try {
      await api(path, { method: "POST", body: "{}" });
      onDone();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : whenFailed);
    } finally {
      setBusyId("");
    }
  };

  // Saving re-picks every automatic keeper on the server, so the response is the whole
  // page again rather than an acknowledgement.
  const savePreferred = async () => {
    setPreferBusy(true);
    setActionError("");
    try {
      const folders = folderOptions
        .filter((option) => preferDraft.includes(option.key))
        .map((option) => ({ libraryId: option.libraryId, folderPath: option.folderPath }));
      setPayload(normalisePayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/preferred-folders", {
        method: "POST",
        body: JSON.stringify({ folders })
      })));
      setPreferOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to save the preferred folders");
    } finally {
      setPreferBusy(false);
    }
  };

  const renderGroup = (group: DuplicateFolderGroup) => {
    const keeper = keeperOf(group);
    const doomed = group.members.filter((member) => folderKey(member) !== folderKey(keeper));
    return (
      <div className="dup-group" key={group.id}>
        <div className="dup-group-head">
          <div className="dup-group-summary">
            <strong>
              {group.members.length} folders holding the same {group.itemCount} photo{group.itemCount === 1 ? "" : "s"}
            </strong>
            <span className="datagrid-muted">
              {" · "}{formatBytes(group.reclaimableBytes)} to reclaim
              {group.keeperReason ? ` · keeping “${keeper.name}”: ${group.keeperReason}` : ` · keeping “${keeper.name}”`}
            </span>
          </div>
          <div className="dup-group-actions">
            <Button variant="secondary" compact disabled={busy} onClick={() => { setActionError(""); setIgnoreTarget(group); }}>
              Not the same
            </Button>
            <Button
              variant="danger"
              compact
              disabled={busy || doomed.length === 0}
              onClick={() => { setActionError(""); setDeleteTarget(group); }}
            >
              <Trash2 size={14} />
              <span>Delete {doomed.length} folder{doomed.length === 1 ? "" : "s"}</span>
            </Button>
          </div>
        </div>

        <div className="dup-folders">
          {group.members.map((member) => {
            const keep = folderKey(member) === folderKey(keeper);
            return (
              <div className={`dup-folder${keep ? " is-keep" : " is-trash"}`} key={folderKey(member)}>
                <Button
                  variant="text"
                  className="dup-folder-pick"
                  aria-pressed={keep}
                  disabled={busy}
                  title={keep ? "This folder is the one being kept" : "Keep this folder instead"}
                  onClick={() => setKeeperPick((current) => ({ ...current, [group.id]: folderKey(member) }))}
                >
                  {/* A few of the folder's own pictures: the fastest way to recognise
                      which copy of a folder you are looking at. */}
                  <span className="dup-folder-thumbs" aria-hidden="true">
                    {member.coverUrls.length > 0
                      ? member.coverUrls.map((url) => <img key={url} src={url} alt="" loading="lazy" />)
                      : <ImageOff size={16} />}
                  </span>
                  <span className="dup-folder-name">{member.name}</span>
                  <span className="dup-copy-where" title={member.folderPath || "Library root"}>
                    <FolderOpen size={11} aria-hidden="true" />
                    <span>{folderPathLabel(member)}</span>
                  </span>
                  {!scopeName && (
                    <span className="dup-copy-where">
                      <Images size={11} aria-hidden="true" />
                      <span>{member.libraryName}</span>
                    </span>
                  )}
                  <span className="dup-copy-where">
                    <HardDrive size={11} aria-hidden="true" />
                    <span>{member.itemCount} photos · {formatBytes(member.bytes)}</span>
                  </span>
                  {member.linkCount > 0 && (
                    <span className="dup-copy-where">
                      <Info size={11} aria-hidden="true" />
                      <span>{member.linkCount} tag{member.linkCount === 1 ? "" : "s"}/links</span>
                    </span>
                  )}
                </Button>
                <span className="dup-copy-badge" aria-hidden="true">{keep ? "Keep" : "Delete"}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <>
      <ControlSectionHead
        section="duplicateFolders"
        className="dup-section-head"
        icon={<FolderOpen size={30} />}
        description="Whole folders that duplicate another folder, handled in one go."
      >
        {anythingFound && (
          <label className="search-field dup-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search duplicate folders by path or library</span>
            <input
              type="search"
              value={search}
              placeholder="Search folders"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
      </ControlSectionHead>

      <p className="dup-status datagrid-muted">
        Last scan: {formatWhen(payload.lastScanAt)}
        {groups.length + contained.length > 0
          ? ` · ${groups.length + contained.length} folder${groups.length + contained.length === 1 ? "" : "s"} worth of duplicates, ${formatBytes(reclaimable)} to reclaim`
          : ""}
        {" · "}
        <a href={controlHref("duplicatePhotos")}>Scanning and single photos are on Duplicate photos</a>
      </p>

      <ExperimentalNotice />

      {payload.scanning && (
        <MessageBox tone="info" title="Scan running">
          A duplicate scan is in progress. Folders appear here as soon as it finishes.
        </MessageBox>
      )}
      {error && <MessageBox tone="error" title="Unable to load duplicate folders">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

      {anythingFound && (
        <div className="dup-toolbar">
          <LibraryMenu
            value={scopeId}
            options={scopeOptions}
            icon={<Images size={19} aria-hidden="true" />}
            label="Which photo library to compare"
            disabled={busy}
            onChange={setScopeId}
          />
          <div className="dup-toolbar-controls">
            <Button
              variant="icon"
              className={folderFilter.length > 0 ? "is-active" : ""}
              disabled={busy || folderOptions.length === 0}
              onClick={() => { setActionError(""); setFilterOpen(true); }}
              aria-label={folderFilter.length > 0 ? `Working on ${folderFilter.length} folders` : "Choose folders to work on"}
              title={folderFilter.length > 0 ? `Working on ${folderFilter.length} folder${folderFilter.length === 1 ? "" : "s"}` : "Choose folders to work on"}
            >
              <FolderOpen size={18} aria-hidden="true" />
            </Button>
            <Button
              variant="icon"
              className={payload.preferredFolders.length > 0 ? "is-active" : ""}
              disabled={busy || folderOptions.length === 0}
              onClick={() => {
                setActionError("");
                setPreferDraft(folderOptions
                  .filter((option) => payload.preferredFolders.some((folder) =>
                    folder.libraryId === option.libraryId && folder.folderPath === option.folderPath))
                  .map((option) => option.key));
                setPreferOpen(true);
              }}
              aria-label="Choose which folders to keep photos in"
              title={payload.preferredFolders.length > 0
                ? `Keeping photos in ${payload.preferredFolders.length} chosen folder${payload.preferredFolders.length === 1 ? "" : "s"}`
                : "Choose which folders to keep photos in"}
            >
              <FolderHeart size={18} aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {loaded && !anythingFound && !error && (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No folder duplicates another. A folder differing by even one photo isn't listed here — its copies still appear individually under Duplicate photos."
            : "No scan has run yet. Start one on the Duplicate photos tab and the folders it finds appear here."}
        </p>
      )}

      {loaded && anythingFound && groups.length === 0 && contained.length === 0 && (
        <p className="management-empty">
          {filtering
            ? "Nothing matches what you've narrowed the page to."
            : "Nothing to show."}
        </p>
      )}

      {groups.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Folders holding the same photos</h2>
          <p className="datagrid-muted dup-tier-note">
            The same pictures, file for file, whatever the two folders are called. Every photo in them is also a set
            on Duplicate photos — clearing a folder here settles all of them at once.
          </p>
          <div className="dup-groups">{groups.map(renderGroup)}</div>
        </>
      )}

      {contained.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Folders already stored elsewhere</h2>
          <p className="datagrid-muted dup-tier-note">
            Every photo in these folders also sits in another folder, so the folder itself can go and nothing is lost.
            This is what a folder copied into itself looks like — the two can never match exactly, because the outer
            one holds the inner one's photos as well.
          </p>
          <div className="dup-groups">
            {contained.map((row) => {
              const labels = containedLabels(row);
              return (
                <div className="dup-group dup-contained" key={row.id}>
                  <div className="dup-group-head">
                    <div className="dup-group-summary">
                      <strong>
                        All {row.itemCount} photo{row.itemCount === 1 ? "" : "s"} in “{labels.folder}” are also
                        in “{labels.target}”
                      </strong>
                      <span className="datagrid-muted">
                        {" · "}{formatBytes(row.bytes)} to reclaim
                        {row.extraCount > 0
                          ? ` · the kept folder holds ${row.extraCount} more`
                          : " · the two hold the same pictures, arranged differently"}
                        {row.linkCount > 0 ? ` · ${row.linkCount} tags/links move across` : ""}
                      </span>
                    </div>
                    <div className="dup-group-actions">
                      <Button
                        variant="secondary"
                        compact
                        disabled={busy}
                        onClick={() => { setActionError(""); setContainedIgnoreTarget(row); }}
                      >
                        Leave it
                      </Button>
                      <Button
                        variant="danger"
                        compact
                        disabled={busy}
                        onClick={() => { setActionError(""); setContainedDeleteTarget(row); }}
                      >
                        <Trash2 size={14} />
                        <span>Delete “{labels.folder}”</span>
                      </Button>
                    </div>
                  </div>

                  <div className="dup-contained-pair">
                    <div className="dup-folder is-trash">
                      <span className="dup-folder-thumbs" aria-hidden="true">
                        {row.coverUrls.length > 0
                          ? row.coverUrls.map((url) => <img key={url} src={url} alt="" loading="lazy" />)
                          : <ImageOff size={16} />}
                      </span>
                      <span className="dup-folder-name">{row.folder.name}</span>
                      <span className="dup-copy-where" title={row.folder.folderPath || "Library root"}>
                        <FolderOpen size={11} aria-hidden="true" />
                        <span>{folderPathLabel(row.folder)}</span>
                      </span>
                      {!scopeName && (
                        <span className="dup-copy-where">
                          <Images size={11} aria-hidden="true" />
                          <span>{row.folder.libraryName}</span>
                        </span>
                      )}
                      <span className="dup-copy-badge" aria-hidden="true">Delete</span>
                    </div>
                    <ArrowRight size={18} aria-hidden="true" className="dup-contained-arrow" />
                    <div className="dup-contained-target">
                      <span className="dup-copy-badge dup-contained-badge" aria-hidden="true">Keep</span>
                      <strong>{labels.target}</strong>
                      <span className="dup-copy-where" title={row.target.folderPath || "Library root"}>
                        <FolderOpen size={11} aria-hidden="true" />
                        <span>{folderPathLabel(row.target)}</span>
                      </span>
                      {!scopeName && (
                        <span className="dup-copy-where">
                          <Images size={11} aria-hidden="true" />
                          <span>{row.target.libraryName}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {deleteTarget && (() => {
        const keeper = keeperOf(deleteTarget);
        const doomed = deleteTarget.members.filter((member) => folderKey(member) !== folderKey(keeper));
        const photos = doomed.reduce((sum, member) => sum + member.itemCount, 0);
        return (
          <ConfirmDialog
            title={doomed.length === 1 ? `Delete the folder “${doomed[0].name}”?` : `Delete ${doomed.length} folders?`}
            confirmLabel={`Delete ${photos} photo${photos === 1 ? "" : "s"}`}
            busyLabel="Deleting…"
            danger
            busy={busyId === deleteTarget.id}
            error={actionError}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
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
          busy={busyId === ignoreTarget.id}
          error={actionError}
          onConfirm={() => post(
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

      {containedDeleteTarget && (
        <ConfirmDialog
          title={`Delete the folder “${containedLabels(containedDeleteTarget).folder}”?`}
          confirmLabel={`Delete ${containedDeleteTarget.itemCount} photo${containedDeleteTarget.itemCount === 1 ? "" : "s"}`}
          busyLabel="Deleting…"
          danger
          busy={busyId === containedDeleteTarget.id}
          error={actionError}
          onConfirm={() => post(
            `/api/library/gallery/duplicates/folders/contained/${containedDeleteTarget.id}/resolve`,
            () => setContainedDeleteTarget(null),
            "Unable to remove the folder",
            containedDeleteTarget.id
          )}
          onCancel={() => setContainedDeleteTarget(null)}
          rich
        >
          <p>
            Every one of the {containedDeleteTarget.itemCount} photos in
            {" "}<strong>{folderPathLabel(containedDeleteTarget.folder)}</strong> also sits in
            {" "}<strong>{folderPathLabel(containedDeleteTarget.target)}</strong>
            {containedDeleteTarget.folder.libraryId === containedDeleteTarget.target.libraryId
              ? ""
              : ` in ${containedDeleteTarget.target.libraryName}`}, which is not touched. That's checked again the
            moment you confirm — if even one photo here no longer has a copy there, nothing is deleted.
          </p>
          <p>
            Each photo hands its tags, albums, collections and tagged people to its copy in the kept folder first.
            The copies are the same file byte for byte, so tagged faces still line up.
          </p>
          <p>
            All {containedDeleteTarget.itemCount} photo{containedDeleteTarget.itemCount === 1 ? "" : "s"} go to the
            Recycle Bin and can be restored until it's emptied. The folder itself is left behind on disk, empty.
          </p>
        </ConfirmDialog>
      )}

      {containedIgnoreTarget && (
        <ConfirmDialog
          title={`Leave “${containedLabels(containedIgnoreTarget).folder}” alone?`}
          confirmLabel="Leave it"
          busyLabel="Saving…"
          busy={busyId === containedIgnoreTarget.id}
          error={actionError}
          onConfirm={() => post(
            `/api/library/gallery/duplicates/folders/contained/${containedIgnoreTarget.id}/ignore`,
            () => setContainedIgnoreTarget(null),
            "Unable to dismiss the folder",
            containedIgnoreTarget.id
          )}
          onCancel={() => setContainedIgnoreTarget(null)}
          rich
        >
          <p>
            This folder stops being suggested for removal, whichever folder turns out to hold copies of its photos.
            Nothing is deleted and no photo is changed.
          </p>
          <p>Its photos are still compared with the rest individually, under Duplicate photos.</p>
        </ConfirmDialog>
      )}

      {filterOpen && (
        <FolderFilterModal
          options={folderOptions}
          selected={folderFilter}
          onChange={setFolderFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {preferOpen && (
        <PreferredFoldersModal
          options={folderOptions}
          draft={preferDraft}
          busy={preferBusy}
          error={actionError}
          onChange={setPreferDraft}
          onSave={() => void savePreferred()}
          onClose={() => setPreferOpen(false)}
        />
      )}
    </>
  );
}
