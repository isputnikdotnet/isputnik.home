import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, ImageOff, Images, Info, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { LibraryMenu } from "../../../shared/LibraryMenu";
import { Pager } from "../../../shared/Pager";
import { SelectMenu } from "../../../shared/SelectMenu";
import { AudiobookHeaderSort } from "../../audiobooks/AudiobooksPage";
import type { SortKey } from "../../audiobooks/BookFilter";

interface DuplicateMember {
  itemId: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  takenAt: string | null;
  camera: string | null;
  linkCount: number;
  isKeeper: boolean;
}

interface DuplicateGroup {
  id: string;
  kind: "exact" | "near";
  keeperItemId: string | null;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  reclaimableBytes: number;
  members: DuplicateMember[];
}

interface DuplicateLibraryOption {
  id: string;
  name: string;
  candidateCount: number;
  pendingCount: number;
}

interface DuplicatePayload {
  groups: DuplicateGroup[];
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

const EMPTY: DuplicatePayload = {
  groups: [], lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
  scanning: false, reclaimableBytes: 0, libraries: []
};

// What choosing this scope would cost: files a scan has to open and read. Everything
// already hashed by an earlier run is reused, so a re-scan of settled photos reads
// nothing — and a picker full of "up to date" is noise, so say nothing at all then.
function scopeCost(pending: number): string {
  return pending === 0 ? "" : ` — ${pending} to check`;
}

function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function copies(n: number): string {
  return `${n} cop${n === 1 ? "y" : "ies"}`;
}

function dimensions(member: DuplicateMember): string {
  return member.width && member.height ? `${member.width} × ${member.height}` : "Unknown size";
}

type DupSort = "size" | "copies" | "identical" | "name" | "recent";

type DupPerPage = "10" | "25" | "50" | "all";

const PER_PAGE_OPTIONS: { value: DupPerPage; label: string }[] = [
  { value: "10", label: "10 per page" },
  { value: "25", label: "25 per page" },
  { value: "50", label: "50 per page" },
  { value: "all", label: "Show all" }
];

const SORT_OPTIONS: { value: DupSort; label: string }[] = [
  { value: "size", label: "Size to reclaim" },
  { value: "copies", label: "Number of copies" },
  { value: "identical", label: "Identical photos first" },
  { value: "name", label: "Filename" },
  { value: "recent", label: "Recently found" }
];

// The tile shows the file's own name; the folder it sits in is in its details.
function fileName(member: DuplicateMember): string {
  return member.path.split("/").pop() || member.title || "Untitled";
}

// When every copy carries the same filename AND the same byte size, the tiles are
// indistinguishable from one another — same picture, same name, same size — so
// showing all of them side by side adds nothing. Those sets collapse to the copy
// being kept, behind a chevron. Sets whose copies differ in either respect stay
// open, because then the tiles are exactly what you need to compare.
function copiesLookAlike(group: DuplicateGroup): boolean {
  if (group.members.length < 2) return false;
  const [first, ...rest] = group.members;
  return rest.every((member) => fileName(member) === fileName(first) && member.size === first.size);
}

// The set is named after the copy being kept — that's the one that survives. Sort on
// the same name the tile shows, so the ordering matches what the reader can see.
function groupName(group: DuplicateGroup): string {
  const keeper = group.members.find((member) => member.isKeeper) ?? group.members[0];
  return keeper ? fileName(keeper) : "";
}

function matchesSearch(group: DuplicateGroup, needle: string): boolean {
  if (!needle) return true;
  // Any copy matching keeps the whole set: you search for a filename to find the set
  // it belongs to, and the copies rarely all share a name.
  return group.members.some((member) =>
    member.path.toLowerCase().includes(needle)
    || member.title.toLowerCase().includes(needle)
    || member.libraryName.toLowerCase().includes(needle));
}

function sortGroups(groups: DuplicateGroup[], sort: DupSort): DuplicateGroup[] {
  // The server already hands them back newest-first, so "recent" is the order as given.
  if (sort === "recent") return groups;
  const list = [...groups];
  if (sort === "copies") return list.sort((a, b) => b.members.length - a.members.length);
  if (sort === "name") return list.sort((a, b) => groupName(a).localeCompare(groupName(b)));
  // Sets whose copies match on name and size first — the ones safe to clear without
  // comparing anything. Size breaks the tie so the biggest wins are at the top.
  if (sort === "identical") {
    return list.sort((a, b) =>
      Number(copiesLookAlike(b)) - Number(copiesLookAlike(a))
      || b.reclaimableBytes - a.reclaimableBytes);
  }
  return list.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
}

export function DuplicatePhotosSection() {
  const [payload, setPayload] = useState<DuplicatePayload>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [starting, setStarting] = useState(false);
  const [busyGroupId, setBusyGroupId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DuplicateGroup | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<DuplicateGroup | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  // The tile shows only a filename now; everything else about a copy lives here.
  const [infoTarget, setInfoTarget] = useState<DuplicateMember | null>(null);
  // Look-alike sets start collapsed; this holds the ones opened by hand.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deletingAll, setDeletingAll] = useState(false);
  // "" = every gallery library.
  const [scopeId, setScopeId] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DupSort>("size");
  const [perPage, setPerPage] = useState<DupPerPage>("10");
  const [page, setPage] = useState(1);
  const pollRef = useRef<number | null>(null);

  // Normalise before storing. The render walks payload.groups directly, so a response
  // missing a field would throw during render and blank the entire app rather than just
  // this panel — degrade to an empty list instead of taking everything down.
  const applyPayload = (next: Partial<DuplicatePayload>) => {
    setPayload({
      groups: next.groups ?? [],
      lastScanAt: next.lastScanAt ?? null,
      candidateCount: next.candidateCount ?? 0,
      scanning: next.scanning ?? false,
      reclaimableBytes: next.reclaimableBytes ?? 0,
      pendingCount: next.pendingCount ?? 0,
      staleCount: next.staleCount ?? 0,
      libraries: next.libraries ?? []
    });
  };

  const load = async () => {
    applyPayload(await api<DuplicatePayload>("/api/library/gallery/duplicates"));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load duplicate photos"))
      .finally(() => setLoaded(true));
  }, []);

  // A scan runs in the background, so poll while one is in flight and stop as soon as
  // it finishes (the results arrive with the same payload).
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

  // exact/near are the WHOLE sets — "Delete all extras" and the counts in its dialog
  // work on every set, not just what the search happens to be showing. Only the two
  // visible* lists are filtered, and they feed rendering alone.
  const exact = payload.groups.filter((group) => group.kind === "exact");
  const near = payload.groups.filter((group) => group.kind === "near");
  const extraCopies = payload.groups.reduce((sum, group) => sum + group.members.length - 1, 0);
  const busy = starting || deletingAll || busyGroupId !== "";

  // A count appears only where a scan would actually have work to do.
  const scopeOptions = [
    { value: "", label: `All libraries${scopeCost(payload.pendingCount)}` },
    ...payload.libraries.map((library) => ({
      value: library.id,
      label: `${library.name}${scopeCost(library.pendingCount)}`
    }))
  ];
  const scanLabel = payload.scanning ? "Scanning…" : starting ? "Starting…" : "Scan now";

  const needle = search.trim().toLowerCase();
  const filtering = needle !== "";
  const visibleExact = sortGroups(exact.filter((group) => matchesSearch(group, needle)), sort);
  const visibleNear = sortGroups(near.filter((group) => matchesSearch(group, needle)), sort);
  const hiddenBySearch = payload.groups.length - (visibleExact.length + visibleNear.length);

  // One pager spans both tiers: paging each separately would mean two sets of
  // controls. Identical sets come first, so a page can straddle the boundary and
  // show the tail of one tier above the head of the other — each keeps its heading.
  const ordered = [...visibleExact, ...visibleNear];
  const pageSize = perPage === "all" ? Math.max(ordered.length, 1) : Number(perPage);
  const totalPages = Math.max(1, Math.ceil(ordered.length / pageSize));
  // Clamped rather than corrected in state, so a shrinking list (a delete, a new
  // scan) can't strand the view on a page that no longer exists.
  const currentPage = Math.min(page, totalPages);
  const pageGroups = ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageExact = pageGroups.filter((group) => group.kind === "exact");
  const pageNear = pageGroups.filter((group) => group.kind === "near");
  const firstShown = ordered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastShown = Math.min(currentPage * pageSize, ordered.length);

  // Any change to what's listed or how it's ordered puts you back at the top —
  // staying on page 7 of a freshly filtered list shows an arbitrary slice.
  useEffect(() => { setPage(1); }, [needle, sort, perPage]);

  const startScan = async () => {
    setStarting(true);
    setActionError("");
    try {
      applyPayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/scan", {
        method: "POST",
        body: JSON.stringify({ libraryId: scopeId || null })
      }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to start the scan");
    } finally {
      setStarting(false);
    }
  };

  const chooseKeeper = async (group: DuplicateGroup, member: DuplicateMember) => {
    if (member.isKeeper) return;
    setBusyGroupId(group.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${group.id}/keeper`, {
        method: "POST",
        body: JSON.stringify({ itemId: member.itemId })
      });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to change which copy is kept");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyGroupId(deleteTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${deleteTarget.id}/resolve`, { method: "POST", body: "{}" });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the extra copies");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmIgnore = async () => {
    if (!ignoreTarget) return;
    setBusyGroupId(ignoreTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${ignoreTarget.id}/ignore`, { method: "POST", body: "{}" });
      setIgnoreTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to dismiss the set");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmDeleteAll = async () => {
    setDeletingAll(true);
    setActionError("");
    try {
      await api("/api/library/gallery/duplicates/resolve-all", { method: "POST", body: "{}" });
      setDeleteAllOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the extra copies");
    } finally {
      setDeletingAll(false);
    }
  };

  const toggleExpanded = (groupId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };

  const renderGroup = (group: DuplicateGroup) => {
    const keeper = group.members.find((member) => member.isKeeper);
    const extras = group.members.length - 1;
    const collapsible = copiesLookAlike(group);
    const expanded = !collapsible || expandedIds.has(group.id);
    // Collapsed still shows the copy being kept — you should always be able to see
    // the photo; what's hidden is the identical repeats of it.
    const shownMembers = expanded ? group.members : group.members.filter((member) => member.isKeeper);
    return (
      <div className="dup-group" key={group.id}>
        <div className="dup-group-head">
          <div className="dup-group-summary">
            <strong>{group.members.length} copies of the same photo</strong>
            <span className="datagrid-muted">
              {" · "}{formatBytes(group.reclaimableBytes)} to reclaim
              {group.keeperSource === "manual"
                ? " · you chose which copy to keep"
                : group.keeperReason ? ` · keeping the one that is ${group.keeperReason}` : ""}
            </span>
          </div>
          <div className="dup-group-actions">
            <Button
              variant="secondary"
              compact
              disabled={busy}
              onClick={() => { setActionError(""); setIgnoreTarget(group); }}
            >
              Not duplicates
            </Button>
            <Button
              variant="danger"
              compact
              disabled={busy || !keeper}
              onClick={() => { setActionError(""); setDeleteTarget(group); }}
            >
              <Trash2 size={14} />
              <span>Delete {copies(extras)}</span>
            </Button>
            {collapsible && (
              <Button
                variant="icon"
                className="dup-group-toggle"
                aria-expanded={expanded}
                aria-controls={`dup-copies-${group.id}`}
                aria-label={expanded ? "Hide the identical copies" : `Show all ${group.members.length} copies`}
                title={expanded ? "Hide the identical copies" : `Show all ${group.members.length} copies`}
                onClick={() => toggleExpanded(group.id)}
              >
                <ChevronDown size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        <div className="dup-copies" id={`dup-copies-${group.id}`}>
          {shownMembers.map((member) => (
            // A wrapper, not a button: the info control sits inside the tile, and a
            // button can't nest inside another button.
            <div className={`dup-copy${member.isKeeper ? " is-keeper" : ""}`} key={member.itemId}>
              <Button
                variant="text"
                className="dup-copy-pick"
                aria-pressed={member.isKeeper}
                disabled={busy}
                title={member.isKeeper ? "This copy is being kept" : "Keep this copy instead"}
                onClick={() => void chooseKeeper(group, member)}
              >
                <span className="dup-copy-thumb" aria-hidden="true">
                  {member.coverUrl ? <img src={member.coverUrl} alt="" loading="lazy" /> : <ImageOff size={16} />}
                </span>
                <span className="dup-copy-name">{fileName(member)}</span>
              </Button>

              {/* The state is already on the pick button as aria-pressed, so the chip
                  is decoration for the eye only. */}
              <span className="dup-copy-badge" aria-hidden="true">
                {member.isKeeper ? "Keep" : "Delete"}
              </span>

              <Button
                variant="icon"
                className="dup-copy-info"
                aria-label={`Details for ${fileName(member)}`}
                title="Details"
                onClick={() => setInfoTarget(member)}
              >
                <Info size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
          {!expanded && (
            <Button
              variant="text"
              className="dup-copies-more"
              aria-controls={`dup-copies-${group.id}`}
              onClick={() => toggleExpanded(group.id)}
            >
              +{extras} identical {extras === 1 ? "copy" : "copies"}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="section-head admin-section-head dup-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <Copy size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">Digital Library</p>
            <h1>Duplicate photos</h1>
            <p className="section-description">Find and manage duplicate photos to free up space.</p>
          </div>
        </div>
        {payload.groups.length > 0 && (
          <label className="search-field dup-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search duplicate photos by filename, path or library</span>
            <input
              type="search"
              value={search}
              placeholder="Search photos or filenames"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
      </div>

      {/* The counts beside each library in the picker are how many files a scan of it
          would have to read, so they aren't repeated here. */}
      <p className="dup-status datagrid-muted">
        Last scan: {formatWhen(payload.lastScanAt)}
        {payload.groups.length > 0
          ? ` · ${payload.groups.length} duplicate set${payload.groups.length === 1 ? "" : "s"}, ${copies(extraCopies)} using ${formatBytes(payload.reclaimableBytes)}`
          : ""}
      </p>

      {payload.scanning && (
        <MessageBox tone="info" title="Scan running">
          Reading the photos that share a file size with another photo. Results appear here as soon as it finishes — you
          can leave this page. Progress is on the Tasks tab.
        </MessageBox>
      )}
      {payload.staleCount > 0 && !payload.scanning && (
        <MessageBox tone="warning" title="Some photos have changed on disk">
          {payload.staleCount} photo{payload.staleCount === 1 ? "" : "s"} no longer match{payload.staleCount === 1 ? "es" : ""} what
          the catalogue records, so {payload.staleCount === 1 ? "it was" : "they were"} left out of this comparison.
          Rescan the library from the Libraries tab, then scan for duplicates again.
        </MessageBox>
      )}
      {error && <MessageBox tone="error" title="Unable to load duplicate photos">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

      {loaded && payload.groups.length === 0 && !error ? (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No duplicate photos found — every catalogued photo is unique."
            : "No scan has run yet. Choose “Scan now” to look for duplicate photos."}
        </p>
      ) : null}

      {payload.groups.length > 0 && (
        <div className="dup-toolbar">
          {/* Scope comes first: it's the thing everything else operates on. The three
              actions that follow are icon-only — this page already shows a lot of
              small decisions, and their labels were the loudest thing on it. */}
          <LibraryMenu
            value={scopeId}
            options={scopeOptions}
            icon={<Images size={19} aria-hidden="true" />}
            label="Which photo library to scan"
            disabled={busy || payload.scanning}
            onChange={setScopeId}
          />

          <div className="dup-toolbar-controls">
            <SelectMenu
              value={perPage}
              options={PER_PAGE_OPTIONS}
              label="Sets per page"
              className="dup-per-page"
              onChange={setPerPage}
            />
            <AudiobookHeaderSort
              value={sort as unknown as SortKey}
              onChange={(next) => setSort(next as unknown as DupSort)}
              options={SORT_OPTIONS as unknown as { value: SortKey; label: string }[]}
              ariaLabel="Sort duplicate sets"
              compact
            />
            <Button
              variant="icon"
              disabled={busy || payload.scanning}
              onClick={startScan}
              aria-label={scanLabel}
              title={scanLabel}
            >
              {payload.scanning || starting
                ? <span className="icon-spin" aria-hidden="true"><RefreshCw size={18} /></span>
                : <RefreshCw size={18} aria-hidden="true" />}
            </Button>
            {exact.length > 0 && (
              <Button
                variant="icon"
                danger
                disabled={busy}
                onClick={() => { setActionError(""); setDeleteAllOpen(true); }}
                aria-label="Delete all extras"
                title="Delete all extras"
              >
                <Trash2 size={18} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      )}

      {filtering && hiddenBySearch > 0 && (
        <p className="dup-filter-note datagrid-muted">
          Showing {visibleExact.length + visibleNear.length} of {payload.groups.length} sets · {hiddenBySearch} hidden by your search.
        </p>
      )}

      {loaded && payload.groups.length > 0 && visibleExact.length === 0 && visibleNear.length === 0 && (
        <p className="management-empty">No duplicate sets match “{search.trim()}”.</p>
      )}

      {pageExact.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Identical files</h2>
          <div className="dup-groups">{pageExact.map(renderGroup)}</div>
        </>
      )}

      {pageNear.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Near-identical</h2>
          <p className="datagrid-muted dup-tier-note">
            Same picture, different file — a resized or re-compressed copy. Check these before removing anything.
          </p>
          <div className="dup-groups">{pageNear.map(renderGroup)}</div>
        </>
      )}

      {ordered.length > 0 && (
        <div className="dup-pager-row">
          <span className="datagrid-muted">
            Showing {firstShown}–{lastShown} of {ordered.length} set{ordered.length === 1 ? "" : "s"}
          </span>
          <Pager
            page={currentPage}
            totalPages={totalPages}
            onChange={setPage}
            label="Duplicate set pages"
          />
        </div>
      )}

      {infoTarget && (
        <Modal title={fileName(infoTarget)} onClose={() => setInfoTarget(null)}>
          <dl className="dup-info-list">
            <dt>Library</dt>
            <dd>{infoTarget.libraryName}</dd>
            <dt>Path</dt>
            <dd className="dup-info-path">{infoTarget.path}</dd>
            <dt>Dimensions</dt>
            <dd>{dimensions(infoTarget)}</dd>
            <dt>File size</dt>
            <dd>{infoTarget.size != null ? formatBytes(infoTarget.size) : "Unknown"}</dd>
            <dt>Taken</dt>
            <dd>{formatWhen(infoTarget.takenAt)}</dd>
            <dt>Camera</dt>
            <dd>{infoTarget.camera || "Unknown"}</dd>
            <dt>Tags & links</dt>
            <dd>
              {infoTarget.linkCount > 0
                ? `${infoTarget.linkCount} tag${infoTarget.linkCount === 1 ? "" : "s"}/links`
                : "None"}
            </dd>
            <dt>Status</dt>
            <dd>{infoTarget.isKeeper ? "Being kept" : "Will be deleted"}</dd>
          </dl>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setInfoTarget(null)}>Close</Button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${copies(deleteTarget.members.length - 1)} of this photo?`}
          confirmLabel="Delete copies"
          busyLabel="Deleting…"
          danger
          busy={busyGroupId === deleteTarget.id}
          error={actionError}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
          rich
        >
          <p>
            The copy at <strong>{deleteTarget.members.find((m) => m.isKeeper)?.path}</strong> is kept. Any tags, albums
            and collections on the other copies move onto it first, so nothing you filed by hand is lost.
          </p>
          {deleteTarget.kind === "exact" ? (
            <p>Tagged people move across too — these copies are the same file, so the faces line up exactly.</p>
          ) : (
            <p>
              People tagged <em>only</em> on the copies being removed are not carried over: these are different files —
              a resized or re-saved version — so a face marked on one doesn't line up on the other. Check the faces
              before removing anything you've spent time tagging.
            </p>
          )}
          <p>
            The extra copies go to the Recycle Bin, where they can be restored until it's emptied. The kept photo is not
            affected.
          </p>
        </ConfirmDialog>
      )}

      {ignoreTarget && (
        <ConfirmDialog
          title="Mark these as different photos?"
          confirmLabel="Not duplicates"
          busyLabel="Saving…"
          busy={busyGroupId === ignoreTarget.id}
          error={actionError}
          onConfirm={confirmIgnore}
          onCancel={() => setIgnoreTarget(null)}
        >
          This set disappears from the list and future scans won't group these photos together again. Nothing is deleted
          and no photo is changed.
        </ConfirmDialog>
      )}

      {deleteAllOpen && (
        <ConfirmDialog
          title={`Delete the extra copies in ${exact.length} set${exact.length === 1 ? "" : "s"}?`}
          confirmLabel={`Delete ${copies(exact.reduce((sum, group) => sum + group.members.length - 1, 0))}`}
          busyLabel="Deleting…"
          danger
          busy={deletingAll}
          error={actionError}
          onConfirm={confirmDeleteAll}
          onCancel={() => setDeleteAllOpen(false)}
          rich
        >
          <p>
            One copy is kept from every set of identical files — the one marked “Keeping”, including any you chose
            yourself. Their tags, albums and tagged people are merged onto it first.
          </p>
          <p>
            This frees about {formatBytes(exact.reduce((sum, group) => sum + group.reclaimableBytes, 0))}. Everything
            removed goes to the Recycle Bin and can be restored until it's emptied. Near-identical sets are never
            touched by this button.
          </p>
          {filtering && (
            <p>
              Your search is only narrowing what's on screen — this covers all {exact.length} identical
              set{exact.length === 1 ? "" : "s"}, including the ones it's hiding.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
