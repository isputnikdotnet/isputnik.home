import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Copy, ExternalLink, Folder, FolderHeart, FolderOpen, HardDrive, ImageOff, Images, Info, Maximize2, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { LibraryMenu } from "../../../shared/LibraryMenu";
import { Pager } from "../../../shared/Pager";
import { DuplicateViewer } from "./DuplicateViewer";
import { SelectMenu } from "../../../shared/SelectMenu";
import { AudiobookHeaderSort } from "../../audiobooks/AudiobooksPage";
import type { SortKey } from "../../audiobooks/BookFilter";
import { ControlSectionHead } from "../ControlSectionHead";

interface DuplicateMember {
  itemId: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string;
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

// A set as this page shows it: identical to the server's when every library is in
// view, cut down to one library's copies when the picker names one.
interface ScopedGroup extends DuplicateGroup {
  /** Copies of the same photo sitting outside the chosen library — never touched here. */
  elsewhereCount: number;
}

// A folder has no id of its own — it exists as (library, path), and that pair is what
// every action names.
interface DuplicateFolderMember {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  name: string;
  itemCount: number;
  bytes: number;
  linkCount: number;
  coverUrls: string[];
  isKeeper: boolean;
}

interface DuplicateFolderGroup {
  id: string;
  itemCount: number;
  copyBytes: number;
  reclaimableBytes: number;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  members: DuplicateFolderMember[];
}

interface ContainedFolderRef {
  libraryId: string;
  folderPath: string;
  libraryName: string;
  name: string;
}

// One folder whose every photo also sits in `target` — the shape the equal-contents
// test can't see, most often a folder copied into itself.
interface ContainedFolder {
  id: string;
  folder: ContainedFolderRef;
  target: ContainedFolderRef;
  itemCount: number;
  bytes: number;
  extraCount: number;
  coverUrls: string[];
  linkCount: number;
}

interface PreferredFolder {
  libraryId: string;
  folderPath: string;
}

const folderKey = (member: { libraryId: string; folderPath: string }): string =>
  `${member.libraryId} ${member.folderPath}`;

const folderPathLabel = (member: { folderPath: string }): string =>
  member.folderPath || "Library root";

// What to call the two sides of a contained pair. Their names collide constantly —
// a folder copied into itself has exactly the same name as its parent — and
// "all 6 photos in 2017-12-10 are also in 2017-12-10" is nonsense, so fall back to
// full paths the moment the names match.
function containedLabels(row: ContainedFolder): { folder: string; target: string } {
  if (row.folder.name !== row.target.name) return { folder: row.folder.name, target: row.target.name };
  return { folder: folderPathLabel(row.folder), target: folderPathLabel(row.target) };
}

// A folder covers a path when it is that path or an ancestor of it — the rule both
// the filter and the keeper preference use, so "2017-12-10" means the folder and
// everything under it in either place.
function folderCovers(folder: { libraryId: string; folderPath: string }, libraryId: string, path: string): boolean {
  if (folder.libraryId !== libraryId) return false;
  return folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`);
}

interface DuplicateLibraryOption {
  id: string;
  name: string;
  candidateCount: number;
  pendingCount: number;
}

interface DuplicatePayload {
  groups: DuplicateGroup[];
  folderGroups: DuplicateFolderGroup[];
  containedFolders: ContainedFolder[];
  preferredFolders: PreferredFolder[];
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

const EMPTY: DuplicatePayload = {
  groups: [], folderGroups: [], containedFolders: [], preferredFolders: [],
  lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
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

// The folder holding the copy, relative to its library. "" is the library root.
function folderOf(member: DuplicateMember): string {
  const cut = member.path.lastIndexOf("/");
  return cut === -1 ? "" : member.path.slice(0, cut);
}

// Just the folder the copy sits in, without its ancestors — that's what tells two
// copies apart at a glance. The full path stays in the tooltip and the details.
function folderName(member: DuplicateMember): string {
  const folder = folderOf(member);
  return folder ? folder.split("/").pop() || folder : "Library root";
}

// Deep link into the gallery's Folders view, scoped to the library this copy lives
// in — the same relative folder can exist in more than one gallery library.
function folderHref(member: DuplicateMember): string {
  const folder = folderOf(member).split("/").map(encodeURIComponent).join("/");
  return `/gallery/folders/${folder}?library=${encodeURIComponent(member.libraryId)}`;
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

// Sets are BUILT across every library (a photo landing in two libraries is the
// commonest duplicate of all), but choosing a library here means "compare that
// library's photos with each other" — so the set is cut down to the copies living
// there and copies elsewhere drop out of the comparison entirely. A set left with
// fewer than two copies inside the library isn't a duplicate there at all and
// disappears from the list.
//
// `elsewhereCount` is what was cut: the page never deletes those, but it has to say
// they exist, or "delete every copy" would read as removing the picture outright
// when another library still holds it.
function scopeToLibrary(group: DuplicateGroup, libraryId: string): ScopedGroup | null {
  if (!libraryId) return { ...group, elsewhereCount: 0 };
  const mine = group.members.filter((member) => member.libraryId === libraryId);
  if (mine.length < 2) return null;

  // The scan's keeper may be one of the copies that just dropped out; then the best
  // in-library copy takes its place — the server picks the same one when the sweep
  // runs, and every deletion names its copies explicitly regardless.
  const keeper = mine.find((member) => member.isKeeper) ?? mine[0];
  const inherited = keeper.isKeeper;
  const members = mine
    .map((member) => ({ ...member, isKeeper: member.itemId === keeper.itemId }))
    .sort((a, b) => Number(b.isKeeper) - Number(a.isKeeper) || a.path.localeCompare(b.path));
  return {
    ...group,
    keeperItemId: keeper.itemId,
    keeperSource: inherited ? group.keeperSource : "auto",
    keeperReason: inherited ? group.keeperReason : null,
    members,
    reclaimableBytes: members.filter((member) => !member.isKeeper).reduce((sum, member) => sum + (member.size ?? 0), 0),
    elsewhereCount: group.members.length - mine.length
  };
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

function matchesFolderSearch(group: DuplicateFolderGroup, needle: string): boolean {
  if (!needle) return true;
  return group.members.some((member) =>
    member.folderPath.toLowerCase().includes(needle)
    || member.libraryName.toLowerCase().includes(needle));
}

// Every folder a duplicate was actually found in, with how many sets touch it. This
// is the whole vocabulary both the filter and the keeper preference work in: offering
// a full folder tree would list thousands of folders with nothing duplicated in them.
interface FolderOption {
  key: string;
  libraryId: string;
  libraryName: string;
  folderPath: string;
  setCount: number;
}

function folderOptionsFrom(payload: DuplicatePayload): FolderOption[] {
  const options = new Map<string, FolderOption>();
  const note = (libraryId: string, libraryName: string, folderPath: string) => {
    const key = folderKey({ libraryId, folderPath });
    const existing = options.get(key);
    if (existing) existing.setCount += 1;
    else options.set(key, { key, libraryId, libraryName, folderPath, setCount: 1 });
  };

  for (const group of payload.groups) {
    // Count a folder once per set, however many copies of the set live in it.
    const seen = new Set<string>();
    for (const member of group.members) {
      const key = folderKey({ libraryId: member.libraryId, folderPath: folderOf(member) });
      if (seen.has(key)) continue;
      seen.add(key);
      note(member.libraryId, member.libraryName, folderOf(member));
    }
  }
  for (const group of payload.folderGroups) {
    for (const member of group.members) note(member.libraryId, member.libraryName, member.folderPath);
  }
  for (const row of payload.containedFolders) {
    note(row.folder.libraryId, row.folder.libraryName, row.folder.folderPath);
    note(row.target.libraryId, row.target.libraryName, row.target.folderPath);
  }

  return [...options.values()].sort((a, b) =>
    a.libraryName.localeCompare(b.libraryName) || a.folderPath.localeCompare(b.folderPath));
}

function sortGroups(groups: ScopedGroup[], sort: DupSort): ScopedGroup[] {
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
  const [deleteTarget, setDeleteTarget] = useState<ScopedGroup | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<ScopedGroup | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  // Folder sets: which folder this sitting has chosen to keep (groupId → folder key),
  // and the two confirmations. A folder set keeps exactly ONE folder — keeping two
  // identical folders isn't de-duplicating, and the stakes are a whole folder.
  const [folderKeeperPick, setFolderKeeperPick] = useState<Record<string, string>>({});
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<DuplicateFolderGroup | null>(null);
  const [folderIgnoreTarget, setFolderIgnoreTarget] = useState<DuplicateFolderGroup | null>(null);
  const [containedDeleteTarget, setContainedDeleteTarget] = useState<ContainedFolder | null>(null);
  const [containedIgnoreTarget, setContainedIgnoreTarget] = useState<ContainedFolder | null>(null);
  // Work-on-these-folders filter. Client-side and unsaved: it narrows what the page
  // shows, exactly as the search box does, and never changes what a scan finds.
  const [folderFilter, setFolderFilter] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  // "Keep the copy in here." Saved on the server, because it changes which copy every
  // set proposes to keep — a decision, not a view.
  const [preferOpen, setPreferOpen] = useState(false);
  const [preferDraft, setPreferDraft] = useState<string[]>([]);
  const [preferBusy, setPreferBusy] = useState(false);
  // The tile shows only a filename now; everything else about a copy lives here.
  const [infoTarget, setInfoTarget] = useState<{ member: DuplicateMember; mark: "keep" | "trash" } | null>(null);
  // The set open in the full-size viewer. Held by id, not by value, so the marks it
  // shows follow the same state the tiles use.
  const [viewGroupId, setViewGroupId] = useState<string | null>(null);
  // Look-alike sets start collapsed; this holds the ones opened by hand.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // groupId → itemId → keep/trash, holding only the copies clicked in this sitting.
  const [marks, setMarks] = useState<Record<string, Record<string, "keep" | "trash">>>({});
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
      libraries: next.libraries ?? [],
      folderGroups: next.folderGroups ?? [],
      containedFolders: next.containedFolders ?? [],
      preferredFolders: next.preferredFolders ?? []
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

  // Every set as the chosen library sees it — sets it holds no duplicate of are gone,
  // and the ones left show only its own copies. With no library chosen this is the
  // payload unchanged. Everything below counts, sorts and deletes against THIS list,
  // so the page and its buttons can't disagree about what a set is.
  const scoped = payload.groups
    .map((group) => scopeToLibrary(group, scopeId))
    .filter((group): group is ScopedGroup => group !== null);

  // exact/near are the whole scoped sets — "Delete all extras" and the counts in its
  // dialog work on every one of them, not just what the search happens to be showing.
  // Only the two visible* lists are filtered further, and they feed rendering alone.
  const exact = scoped.filter((group) => group.kind === "exact");
  const near = scoped.filter((group) => group.kind === "near");

  // Folder sets are a rollup of the identical-file sets, so they are listed first and
  // their bytes are NOT added to the page's totals — they are the same bytes.
  const folderGroups = payload.folderGroups
    .map((group) => scopeFolderGroup(group, scopeId))
    .filter((group): group is DuplicateFolderGroup => group !== null);
  const extraCopies = scoped.reduce((sum, group) => sum + group.members.length - 1, 0);
  const reclaimableBytes = scoped.reduce((sum, group) => sum + group.reclaimableBytes, 0);
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

  const folderOptions = folderOptionsFrom(payload);
  const chosenFolders = folderOptions.filter((option) => folderFilter.includes(option.key));
  // A set is in scope when any copy of it sits in one of the chosen folders, or below
  // one — picking a folder means "and everything in it".
  const inChosenFolders = (libraryId: string, path: string) =>
    chosenFolders.length === 0 || chosenFolders.some((folder) => folderCovers(folder, libraryId, path));

  const needle = search.trim().toLowerCase();
  const shown = (group: ScopedGroup) =>
    matchesSearch(group, needle)
    && group.members.some((member) => inChosenFolders(member.libraryId, member.path));
  const filtering = needle !== "" || scopeId !== "" || chosenFolders.length > 0;
  // Folder sets are few and each one is large, so they are never paged — they sit
  // above the photo sets, which is also the order to work in: clearing a folder
  // settles every photo set inside it at once.
  const visibleFolders = folderGroups.filter((group) =>
    matchesFolderSearch(group, needle)
    && group.members.some((member) => inChosenFolders(member.libraryId, member.folderPath)));

  // Contained folders follow the library picker too: with one library chosen, only
  // rows where BOTH sides live there make sense — removing a folder because its
  // photos are safe in a library you aren't looking at is a different decision.
  const visibleContained = payload.containedFolders.filter((row) =>
    (!scopeId || (row.folder.libraryId === scopeId && row.target.libraryId === scopeId))
    && (!needle
      || row.folder.folderPath.toLowerCase().includes(needle)
      || row.target.folderPath.toLowerCase().includes(needle)
      || row.folder.libraryName.toLowerCase().includes(needle))
    && (inChosenFolders(row.folder.libraryId, row.folder.folderPath)
      || inChosenFolders(row.target.libraryId, row.target.folderPath)));
  const visibleExact = sortGroups(exact.filter(shown), sort);
  const visibleNear = sortGroups(near.filter(shown), sort);
  const hidden = payload.groups.length - (visibleExact.length + visibleNear.length);
  const scopeName = payload.libraries.find((library) => library.id === scopeId)?.name ?? "";
  // Sets with copies in another library too. "Delete all extras" leaves those alone,
  // which is worth saying before it runs.
  const spanning = exact.filter((group) => group.elsewhereCount > 0).length;

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
  useEffect(() => { setPage(1); }, [needle, scopeId, sort, perPage]);

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

  // Marks live in the page, not the database: a review is a sitting, and nothing is
  // committed until Delete is pressed. Untouched copies fall back to the scan's own
  // choice — its keeper stays, the rest are up for deletion — so a set you don't
  // touch behaves exactly as it did before.
  const markOf = (group: DuplicateGroup, member: DuplicateMember): "keep" | "trash" =>
    marks[group.id]?.[member.itemId] ?? (member.isKeeper ? "keep" : "trash");

  const trashedIds = (group: DuplicateGroup) =>
    group.members.filter((member) => markOf(group, member) === "trash").map((member) => member.itemId);

  const toggleMark = (group: DuplicateGroup, member: DuplicateMember) => {
    const next = markOf(group, member) === "trash" ? "keep" : "trash";
    setMarks((current) => ({
      ...current,
      [group.id]: { ...current[group.id], [member.itemId]: next }
    }));
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const deleteItemIds = trashedIds(deleteTarget);
    if (deleteItemIds.length === 0) return;
    setBusyGroupId(deleteTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${deleteTarget.id}/resolve-selection`, {
        method: "POST",
        body: JSON.stringify({ deleteItemIds })
      });
      // Whatever survived is a fresh decision next time round.
      setMarks((current) => {
        const next = { ...current };
        delete next[deleteTarget.id];
        return next;
      });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the selected copies");
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
      await api("/api/library/gallery/duplicates/resolve-all", {
        method: "POST",
        body: JSON.stringify({ libraryId: scopeId || null })
      });
      setDeleteAllOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the extra copies");
    } finally {
      setDeletingAll(false);
    }
  };

  // The folder this sitting keeps: the one clicked, or the scan's own choice.
  const folderKeeperOf = (group: DuplicateFolderGroup): DuplicateFolderMember => {
    const picked = folderKeeperPick[group.id];
    return group.members.find((member) => folderKey(member) === picked)
      ?? group.members.find((member) => member.isKeeper)
      ?? group.members[0];
  };

  // Removing folders keeps exactly one, so the keeper has to be settled on the server
  // first when it isn't the one the scan chose — otherwise it would refuse to delete
  // the folder it still believes is being kept.
  const confirmFolderDelete = async () => {
    if (!folderDeleteTarget) return;
    const group = folderDeleteTarget;
    const keeper = folderKeeperOf(group);
    const doomed = group.members.filter((member) => folderKey(member) !== folderKey(keeper));
    if (doomed.length === 0) return;
    setBusyGroupId(group.id);
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
      setFolderKeeperPick((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      setFolderDeleteTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the folders");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmFolderIgnore = async () => {
    if (!folderIgnoreTarget) return;
    setBusyGroupId(folderIgnoreTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/folders/${folderIgnoreTarget.id}/ignore`, { method: "POST", body: "{}" });
      setFolderIgnoreTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to dismiss the folder set");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmContainedDelete = async () => {
    if (!containedDeleteTarget) return;
    setBusyGroupId(containedDeleteTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/folders/contained/${containedDeleteTarget.id}/resolve`, {
        method: "POST",
        body: "{}"
      });
      setContainedDeleteTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the folder");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmContainedIgnore = async () => {
    if (!containedIgnoreTarget) return;
    setBusyGroupId(containedIgnoreTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/folders/contained/${containedIgnoreTarget.id}/ignore`, {
        method: "POST",
        body: "{}"
      });
      setContainedIgnoreTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to dismiss the folder");
    } finally {
      setBusyGroupId("");
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
      applyPayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/preferred-folders", {
        method: "POST",
        body: JSON.stringify({ folders })
      }));
      setPreferOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to save the preferred folders");
    } finally {
      setPreferBusy(false);
    }
  };

  const toggleExpanded = (groupId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };

  const renderFolderGroup = (group: DuplicateFolderGroup) => {
    const keeper = folderKeeperOf(group);
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
            <Button
              variant="secondary"
              compact
              disabled={busy}
              onClick={() => { setActionError(""); setFolderIgnoreTarget(group); }}
            >
              Not the same
            </Button>
            <Button
              variant="danger"
              compact
              disabled={busy || doomed.length === 0}
              onClick={() => { setActionError(""); setFolderDeleteTarget(group); }}
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
                  onClick={() => setFolderKeeperPick((current) => ({ ...current, [group.id]: folderKey(member) }))}
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
                  {/* Hand-filed work is what the keeper choice weighs first, so say
                      where it is rather than leaving the reason abstract. */}
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

  const renderGroup = (group: ScopedGroup) => {
    const marked = trashedIds(group);
    const keepCount = group.members.length - marked.length;
    const clearingSet = marked.length === group.members.length;
    const extras = group.members.length - 1;
    const collapsible = copiesLookAlike(group);
    const expanded = !collapsible || expandedIds.has(group.id);
    // Collapsed still shows a copy you're keeping — you should always be able to see
    // the photo; what's hidden is the identical repeats of it. If every copy is marked
    // for deletion there is no kept one to show, so fall back to the first.
    const shownMembers = expanded
      ? group.members
      : [group.members.find((member) => markOf(group, member) === "keep") ?? group.members[0]];
    return (
      <div className="dup-group" key={group.id}>
        <div className="dup-group-head">
          <div className="dup-group-summary">
            <strong>
              {group.members.length} copies of the same photo{scopeName ? ` in ${scopeName}` : ""}
            </strong>
            <span className="datagrid-muted">
              {" · "}{formatBytes(group.reclaimableBytes)} to reclaim
              {group.elsewhereCount > 0
                ? ` · ${group.elsewhereCount} more in ${group.elsewhereCount === 1 ? "another library" : "other libraries"}, left alone`
                : ""}
              {" · "}
              {marked.length === 0
                ? "nothing selected — click a copy to mark it"
                : clearingSet
                  ? "every copy selected for deletion"
                  : `keeping ${keepCount}, deleting ${marked.length}`}
            </span>
          </div>
          <div className="dup-group-actions">
            <Button
              variant="icon"
              className="dup-group-view"
              aria-label={`View all ${group.members.length} copies full size`}
              title="View full size and compare"
              onClick={() => setViewGroupId(group.id)}
            >
              <Maximize2 size={16} aria-hidden="true" />
            </Button>
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
              disabled={busy || marked.length === 0}
              title={marked.length === 0 ? "Click a copy to mark it for deletion" : undefined}
              onClick={() => { setActionError(""); setDeleteTarget(group); }}
            >
              <Trash2 size={14} />
              <span>{marked.length === 0 ? "Delete" : `Delete ${copies(marked.length)}`}</span>
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
          {shownMembers.map((member) => {
            const mark = markOf(group, member);
            return (
            // A wrapper, not a button: the info control sits inside the tile, and a
            // button can't nest inside another button.
            <div className={`dup-copy${mark === "keep" ? " is-keep" : " is-trash"}`} key={member.itemId}>
              <Button
                variant="text"
                className="dup-copy-pick"
                aria-pressed={mark === "trash"}
                disabled={busy}
                title={mark === "keep" ? "Marked to keep — click to delete it instead" : "Marked for deletion — click to keep it"}
                onClick={() => toggleMark(group, member)}
              >
                <span className="dup-copy-thumb" aria-hidden="true">
                  {member.coverUrl ? <img src={member.coverUrl} alt="" loading="lazy" /> : <ImageOff size={16} />}
                </span>
                <span className="dup-copy-name">{fileName(member)}</span>
                {/* Copies of one photo routinely sit in different libraries or in
                    different folders of the same one; the filename alone doesn't say
                    which is which. Under a chosen library every copy is in it by
                    definition, and the heading says so, so the chip goes. */}
                {!scopeName && (
                  <span className="dup-copy-where">
                    <Images size={11} aria-hidden="true" />
                    <span>{member.libraryName}</span>
                  </span>
                )}
                <span className="dup-copy-where" title={folderOf(member) || "Library root"}>
                  <Folder size={11} aria-hidden="true" />
                  <span>{folderName(member)}</span>
                </span>
                {/* Byte size on the tile, not just behind the info button: in a
                    near-identical set it's the quickest read on which copy is the
                    original and which is the re-saved one. */}
                <span className="dup-copy-where">
                  <HardDrive size={11} aria-hidden="true" />
                  <span>{member.size != null ? formatBytes(member.size) : "Unknown size"}</span>
                </span>
              </Button>

              {/* The state is already on the pick button as aria-pressed, so the chip
                  is decoration for the eye only. */}
              <span className="dup-copy-badge" aria-hidden="true">
                {mark === "keep" ? "Keep" : "Delete"}
              </span>

              <Button
                variant="icon"
                className="dup-copy-info"
                aria-label={`Details for ${fileName(member)}`}
                title="Details"
                onClick={() => setInfoTarget({ member, mark })}
              >
                <Info size={14} aria-hidden="true" />
              </Button>
            </div>
            );
          })}
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
      <ControlSectionHead
        section="duplicatePhotos"
        className="dup-section-head"
        icon={<Copy size={30} />}
        description="Find and manage duplicate photos to free up space."
      >
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
      </ControlSectionHead>

      {/* Totals for what's actually being compared: with a library chosen that's its
          own duplicates, not the install's. The counts beside each library in the
          picker are how many files a scan of it would have to read, so they aren't
          repeated here. */}
      <p className="dup-status datagrid-muted">
        Last scan: {formatWhen(payload.lastScanAt)}
        {scoped.length > 0
          ? ` · ${scoped.length} duplicate set${scoped.length === 1 ? "" : "s"}${scopeName ? ` in ${scopeName}` : ""}, ${copies(extraCopies)} using ${formatBytes(reclaimableBytes)}`
          : ""}
      </p>

      {/* Above everything, including the scan notice: this page proposes deleting
          photographs, and the folder tiers are new. Say so before anything else. */}
      <MessageBox tone="warning" title="Experimental — check before you delete">
        Duplicate detection is new and still being proven. Look at what a set actually contains before removing
        anything, and start with a few sets rather than the bulk actions. Everything removed here goes to the Recycle
        Bin and can be restored until you empty it — but the safest order is check, test, and check again.
      </MessageBox>

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
          {/* Scope comes first: it's the thing everything else operates on — it picks
              whose photos are compared with each other, and narrows what the next scan
              reads. The three actions that follow are icon-only — this page already
              shows a lot of small decisions, and their labels were the loudest thing
              on it. */}
          <LibraryMenu
            value={scopeId}
            options={scopeOptions}
            icon={<Images size={19} aria-hidden="true" />}
            label="Which photo library to compare and scan"
            disabled={busy || payload.scanning}
            onChange={setScopeId}
          />

          <div className="dup-toolbar-controls">
            {/* Which folders to work on, and which folder wins when copies are in
                several — one narrows the page, the other changes what every set
                proposes to keep, so they stay separate controls. */}
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
                title={scopeName ? `Delete all extras in “${scopeName}”` : "Delete all extras"}
              >
                <Trash2 size={18} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      )}

      {filtering && hidden > 0 && (
        <p className="dup-filter-note datagrid-muted">
          Showing {visibleExact.length + visibleNear.length} of {payload.groups.length} sets · {hidden} hidden
          by {scopeName && needle
            ? `“${scopeName}” and your search`
            : scopeName
              ? `“${scopeName}” — their copies are in other libraries`
              : "your search"}.
        </p>
      )}

      {loaded && payload.groups.length > 0 && visibleFolders.length === 0 && visibleExact.length === 0 && visibleNear.length === 0 && (
        <p className="management-empty">
          {scopeName && needle
            ? `No duplicate sets inside “${scopeName}” match “${search.trim()}”.`
            : scopeName
              ? `No photo in “${scopeName}” is duplicated inside that library. Any copies it shares with another library are compared under “All libraries”.`
              : `No duplicate sets match “${search.trim()}”.`}
        </p>
      )}

      {/* The heading stands whether or not anything matched. A tier that appears only
          when it has results is a tier nobody knows to look for — and "no folder is
          duplicated" is itself worth reading, since the alternative is wondering
          whether the check ran at all. */}
      {loaded && visibleFolders.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Duplicate folders</h2>
          <p className="datagrid-muted dup-tier-note">
            Whole folders holding exactly the same photos, whatever they're called. Every photo in them is also in
            the identical-file sets below — clearing a folder here settles all of them at once.
          </p>
          <div className="dup-groups">{visibleFolders.map(renderFolderGroup)}</div>
        </>
      )}

      {/* Nothing matched. The heading still stands: a tier that only appears once it
          has results is one nobody knows to look for, and "no folder is duplicated" is
          itself the answer someone came here for. Left out while a search or a library
          is narrowing the page, where the note below already explains the emptiness. */}
      {loaded && visibleFolders.length === 0 && !filtering && payload.lastScanAt && (
        <>
          <h2 className="dup-tier-heading">Duplicate folders</h2>
          <p className="management-empty">
            No folder holds exactly the same photos as another. A folder differing by even one photo isn't listed
            here — its copies still appear individually below.
          </p>
        </>
      )}

      {visibleContained.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Folders already stored elsewhere</h2>
          <p className="datagrid-muted dup-tier-note">
            Every photo in these folders also sits in another folder, so the folder itself can go and nothing is lost.
            This is what a folder copied into itself looks like — the two can never match exactly, because the outer
            one holds the inner one's photos as well.
          </p>
          <div className="dup-groups">
            {visibleContained.map((row) => {
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

      {viewGroupId && (() => {
        // Read the set back out of the scoped list each render, so marks toggled inside
        // the viewer show immediately, a reload can't leave it on a stale copy, and it
        // holds the same copies the tiles do rather than the whole install's.
        const group = scoped.find((candidate) => candidate.id === viewGroupId);
        if (!group) return null;
        return (
          <DuplicateViewer
            title={`${group.members.length} copies of the same photo${scopeName ? ` in ${scopeName}` : ""}`}
            members={group.members}
            busy={busy}
            markOf={(member) => markOf(group, member as DuplicateMember)}
            onToggleMark={(member) => toggleMark(group, member as DuplicateMember)}
            onClose={() => setViewGroupId(null)}
          />
        );
      })()}

      {infoTarget && (
        <Modal title={fileName(infoTarget.member)} onClose={() => setInfoTarget(null)}>
          <dl className="dup-info-list">
            <dt>Library</dt>
            <dd>{infoTarget.member.libraryName}</dd>
            <dt>Folder</dt>
            <dd className="dup-info-path">
              <a
                href={folderHref(infoTarget.member)}
                target="_blank"
                rel="noreferrer"
                className="dup-info-folder"
                title="Open this folder in the gallery, in a new tab"
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span>{folderOf(infoTarget.member) || "Library root"}</span>
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </dd>
            <dt>Path</dt>
            <dd className="dup-info-path">{infoTarget.member.path}</dd>
            <dt>Dimensions</dt>
            <dd>{dimensions(infoTarget.member)}</dd>
            <dt>File size</dt>
            <dd>{infoTarget.member.size != null ? formatBytes(infoTarget.member.size) : "Unknown"}</dd>
            <dt>Taken</dt>
            <dd>{formatWhen(infoTarget.member.takenAt)}</dd>
            <dt>Camera</dt>
            <dd>{infoTarget.member.camera || "Unknown"}</dd>
            <dt>Tags & links</dt>
            <dd>
              {infoTarget.member.linkCount > 0
                ? `${infoTarget.member.linkCount} tag${infoTarget.member.linkCount === 1 ? "" : "s"}/links`
                : "None"}
            </dd>
            <dt>Marked</dt>
            <dd>{infoTarget.mark === "keep" ? "To keep" : "For deletion"}</dd>
          </dl>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setInfoTarget(null)}>Close</Button>
          </div>
        </Modal>
      )}

      {deleteTarget && (() => {
        const doomed = trashedIds(deleteTarget);
        const survivors = deleteTarget.members.filter((member) => markOf(deleteTarget, member) === "keep");
        // Nothing survives here: this isn't de-duplicating any more, it's removing the
        // picture from this library. Say that plainly rather than reusing the
        // reassuring "the kept copy is not affected" wording — unless copies in other
        // libraries carry it on, which changes the answer entirely.
        const clearingSet = survivors.length === 0;
        const elsewhere = deleteTarget.elsewhereCount;
        return (
          <ConfirmDialog
            title={clearingSet
              ? scopeName
                ? `Delete every copy of this photo in “${scopeName}”?`
                : `Delete every copy of this photo?`
              : `Delete ${copies(doomed.length)} of this photo?`}
            confirmLabel={clearingSet ? `Delete all ${copies(doomed.length)}` : "Delete copies"}
            busyLabel="Deleting…"
            danger
            busy={busyGroupId === deleteTarget.id}
            error={actionError}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
            rich
          >
            {clearingSet ? (
              <>
                <p>
                  You've marked <strong>all {deleteTarget.members.length}</strong> copies
                  {scopeName ? <> in <strong>{scopeName}</strong></> : null} for deletion
                  {elsewhere > 0
                    ? `, so nothing is left of it there — but ${elsewhere} cop${elsewhere === 1 ? "y" : "ies"} in other libraries stay where they are.`
                    : ", so no copy of this picture is left behind — it disappears from the gallery entirely."}
                </p>
                <p>
                  {elsewhere > 0
                    ? "Its tags, albums, collections and tagged people move onto one of those remaining copies."
                    : "There is nothing to move its tags, albums, collections and tagged people onto, so those go with it."}
                </p>
                <p>
                  All {deleteTarget.members.length} files go to the Recycle Bin and can be restored until it's emptied.
                  If you meant to keep one, cancel and click a copy to mark it Keep.
                </p>
              </>
            ) : (
              <>
                <p>
                  {survivors.length === 1 ? "The copy at " : "These copies are kept: "}
                  <strong>{survivors.map((member) => member.path).join(", ")}</strong>
                  {survivors.length === 1 ? " is kept." : "."} Any tags, albums and collections on the copies being
                  removed move onto {survivors.length === 1 ? "it" : "the first of them"} first, so nothing you filed by
                  hand is lost.
                </p>
                {deleteTarget.kind === "exact" ? (
                  <p>Tagged people move across too — these copies are the same file, so the faces line up exactly.</p>
                ) : (
                  <p>
                    People tagged <em>only</em> on the copies being removed are not carried over: these are different
                    files — a resized or re-saved version — so a face marked on one doesn't line up on the other. Check
                    the faces before removing anything you've spent time tagging.
                  </p>
                )}
                <p>
                  The selected copies go to the Recycle Bin, where they can be restored until it's emptied. The kept
                  {survivors.length === 1 ? " photo is" : " photos are"} not affected
                  {elsewhere > 0
                    ? `, and neither ${elsewhere === 1 ? "is the copy" : `are the ${elsewhere} copies`} of this photo in other libraries`
                    : ""}.
                </p>
              </>
            )}
          </ConfirmDialog>
        );
      })()}

      {ignoreTarget && (
        <ConfirmDialog
          title="Mark these as different photos?"
          confirmLabel="Not duplicates"
          busyLabel="Saving…"
          busy={busyGroupId === ignoreTarget.id}
          error={actionError}
          onConfirm={confirmIgnore}
          onCancel={() => setIgnoreTarget(null)}
          rich
        >
          <p>
            This set disappears from the list and future scans won't group these photos together again. Nothing is
            deleted and no photo is changed.
          </p>
          {/* Dismissal is recorded for the whole set, not just the copies on screen —
              it has to be, or the next scan would rebuild the set through the copies
              you can't see from here. */}
          {ignoreTarget.elsewhereCount > 0 && (
            <p>
              This photo also has {ignoreTarget.elsewhereCount} cop{ignoreTarget.elsewhereCount === 1 ? "y" : "ies"} in
              other libraries. They're covered too: none of these copies will be grouped with each other again,
              whichever library you're looking at.
            </p>
          )}
        </ConfirmDialog>
      )}

      {folderDeleteTarget && (() => {
        const keeper = folderKeeperOf(folderDeleteTarget);
        const doomed = folderDeleteTarget.members.filter((member) => folderKey(member) !== folderKey(keeper));
        const photos = doomed.reduce((sum, member) => sum + member.itemCount, 0);
        return (
          <ConfirmDialog
            title={doomed.length === 1
              ? `Delete the folder “${doomed[0].name}”?`
              : `Delete ${doomed.length} folders?`}
            confirmLabel={`Delete ${photos} photo${photos === 1 ? "" : "s"}`}
            busyLabel="Deleting…"
            danger
            busy={busyGroupId === folderDeleteTarget.id}
            error={actionError}
            onConfirm={confirmFolderDelete}
            onCancel={() => setFolderDeleteTarget(null)}
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

      {folderIgnoreTarget && (
        <ConfirmDialog
          title="Mark these as different folders?"
          confirmLabel="Not the same"
          busyLabel="Saving…"
          busy={busyGroupId === folderIgnoreTarget.id}
          error={actionError}
          onConfirm={confirmFolderIgnore}
          onCancel={() => setFolderIgnoreTarget(null)}
          rich
        >
          <p>
            This set disappears and future scans won't pair these folders again. Nothing is deleted and no photo is
            changed.
          </p>
          <p>
            The photos inside them are still compared with each other individually, under “Identical files”.
          </p>
        </ConfirmDialog>
      )}

      {containedDeleteTarget && (
        <ConfirmDialog
          title={`Delete the folder “${containedLabels(containedDeleteTarget).folder}”?`}
          confirmLabel={`Delete ${containedDeleteTarget.itemCount} photo${containedDeleteTarget.itemCount === 1 ? "" : "s"}`}
          busyLabel="Deleting…"
          danger
          busy={busyGroupId === containedDeleteTarget.id}
          error={actionError}
          onConfirm={confirmContainedDelete}
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
          busy={busyGroupId === containedIgnoreTarget.id}
          error={actionError}
          onConfirm={confirmContainedIgnore}
          onCancel={() => setContainedIgnoreTarget(null)}
          rich
        >
          <p>
            This folder stops being suggested for removal, whichever folder turns out to hold copies of its photos.
            Nothing is deleted and no photo is changed.
          </p>
          <p>Its photos are still compared with the rest individually, under “Identical files”.</p>
        </ConfirmDialog>
      )}

      {filterOpen && (
        <Modal title="Which folders to work on" onClose={() => setFilterOpen(false)}>
          <p className="datagrid-muted dup-picker-note">
            Only folders something duplicated was actually found in are listed. Choosing some narrows the page to sets
            with a copy in them — a folder covers everything below it. Nothing is deleted or changed by this.
          </p>
          <div className="dup-folder-picker">
            {folderOptions.map((option) => (
              <label className="dup-folder-choice" key={option.key}>
                <input
                  type="checkbox"
                  checked={folderFilter.includes(option.key)}
                  onChange={(event) => setFolderFilter((current) => (event.target.checked
                    ? [...current, option.key]
                    : current.filter((key) => key !== option.key)))}
                />
                <span className="dup-folder-choice-body">
                  <strong>{option.folderPath || "Library root"}</strong>
                  <span className="datagrid-muted">
                    {option.libraryName} · {option.setCount} set{option.setCount === 1 ? "" : "s"}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <Button variant="text" disabled={folderFilter.length === 0} onClick={() => setFolderFilter([])}>
              Clear
            </Button>
            <Button variant="secondary" onClick={() => setFilterOpen(false)}>Close</Button>
          </div>
        </Modal>
      )}

      {preferOpen && (
        <Modal title="Where to keep photos" onClose={() => setPreferOpen(false)}>
          <p className="datagrid-muted dup-picker-note">
            When copies of a photo sit in more than one place, keep the one in these folders. This decides which copy
            every set proposes to keep, so it takes effect the moment you save — copies you've picked by hand are left
            as they are, and nothing is deleted either way. A folder covers everything below it.
          </p>
          <div className="dup-folder-picker">
            {folderOptions.map((option) => (
              <label className="dup-folder-choice" key={option.key}>
                <input
                  type="checkbox"
                  checked={preferDraft.includes(option.key)}
                  disabled={preferBusy}
                  onChange={(event) => setPreferDraft((current) => (event.target.checked
                    ? [...current, option.key]
                    : current.filter((key) => key !== option.key)))}
                />
                <span className="dup-folder-choice-body">
                  <strong>{option.folderPath || "Library root"}</strong>
                  <span className="datagrid-muted">{option.libraryName}</span>
                </span>
              </label>
            ))}
          </div>
          {actionError && <MessageBox tone="error" title="Unable to save">{actionError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" disabled={preferBusy} onClick={() => setPreferOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={preferBusy} onClick={() => void savePreferred()}>
              {preferBusy ? "Saving…" : "Save"}
            </Button>
          </div>
        </Modal>
      )}

      {deleteAllOpen && (
        <ConfirmDialog
          title={
            scopeName
              ? `Delete the extra copies in ${exact.length} set${exact.length === 1 ? "" : "s"} in “${scopeName}”?`
              : `Delete the extra copies in ${exact.length} set${exact.length === 1 ? "" : "s"}?`
          }
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
            One copy is kept from every set of identical files{scopeName ? ` in “${scopeName}”` : ""} — the one marked
            “Keeping”, including any you chose yourself. Their tags, albums and tagged people are merged onto it first.
          </p>
          <p>
            This frees about {formatBytes(exact.reduce((sum, group) => sum + group.reclaimableBytes, 0))}. Everything
            removed goes to the Recycle Bin and can be restored until it's emptied. Near-identical sets are never
            touched by this button.
          </p>
          {/* The sweep stays inside the chosen library, so the copies a set has
              elsewhere survive it — which means a photo can still be duplicated
              across libraries afterwards. Better said than discovered. */}
          {scopeName && spanning > 0 && (
            <p>
              {spanning} of these sets also {spanning === 1 ? "has copies" : "have copies"} in other libraries. Those
              are left exactly where they are — this only thins out “{scopeName}”. To compare across libraries, switch
              the picker to “All libraries”.
            </p>
          )}
          {needle && (
            <p>
              Your search is only narrowing what's on screen — this covers all {exact.length} identical
              set{exact.length === 1 ? "" : "s"} {scopeName ? `in “${scopeName}”` : ""}, including the ones it's hiding.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
