// What the Duplicate photos and Duplicate folders pages have in common: the payload
// they both load, the folder vocabulary they both work in, and the two pickers that
// vocabulary drives — "which folders to work on" and "where to keep photos".
//
// Both pages read the SAME endpoint. It answers in one round trip and the two views
// are different cuts of one scan, so splitting it would mean two requests describing
// the same state — and a page that could disagree with its neighbour about what the
// last scan found.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownAZ, ArrowDownWideNarrow, ArrowRight, ExternalLink, FolderOpen, ImageOff,
  RefreshCw, Search, SlidersHorizontal
} from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";
import { SelectMenu } from "../../../shared/SelectMenu";

export interface DuplicateMember {
  itemId: string;
  kind: "photo" | "video";
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

export interface DuplicateGroup {
  id: string;
  kind: "exact" | "near";
  keeperItemId: string | null;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  reclaimableBytes: number;
  members: DuplicateMember[];
}

// A folder has no id of its own — it exists as (library, path), and that pair is what
// every action names. Everything a folder CARD shows is here, and both folder pages
// render the same card: they differ in what you may do with a folder, not in what is
// known about it.
export interface DuplicateFolderDetail {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  name: string;
  itemCount: number;
  bytes: number;
  linkCount: number;
  coverUrls: string[];
  addedAt: string | null;
}

export interface DuplicateFolderMember extends DuplicateFolderDetail {
  isKeeper: boolean;
}

export interface DuplicateFolderGroup {
  id: string;
  itemCount: number;
  copyBytes: number;
  reclaimableBytes: number;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  members: DuplicateFolderMember[];
}

/** One folder whose every photo also sits in `target` — most often a folder copied
 *  into itself, which no equal-contents test can ever see. */
export interface ContainedFolder {
  id: string;
  /** The folder that can go. */
  folder: DuplicateFolderDetail;
  /** Where the copies actually sit inside `target`, at most three — what to name
   *  when `target` is a whole library and so has no useful name of its own. */
  targetFolders: string[];
  targetFolderCount: number;
  /** The folder that keeps its photos. Never swappable: coverage runs one way, and
   *  offering the other direction would delete photos that exist only here. */
  target: DuplicateFolderDetail;
  itemCount: number;
  bytes: number;
  extraCount: number;
  /** The kept folder is an ancestor of the one that goes, so its own counts include
   *  the photos about to leave. Worth saying on the card — otherwise its photo count
   *  looks wrong the moment the delete lands. */
  encloses: boolean;
  coverUrls: string[];
  linkCount: number;
}

export type FolderPreferenceMode = "keep" | "clear";

/** A standing instruction attached to a folder: keep copies here, or let them go. */
export interface FolderPreference {
  libraryId: string;
  folderPath: string;
  mode: FolderPreferenceMode;
}

export interface DuplicateLibraryOption {
  id: string;
  name: string;
  candidateCount: number;
  pendingCount: number;
}

export interface DuplicatePayload {
  groups: DuplicateGroup[];
  folderGroups: DuplicateFolderGroup[];
  containedFolders: ContainedFolder[];
  folderPreferences: FolderPreference[];
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

export const EMPTY_PAYLOAD: DuplicatePayload = {
  groups: [], folderGroups: [], containedFolders: [], folderPreferences: [],
  lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
  scanning: false, reclaimableBytes: 0, libraries: []
};

// A response missing a field would throw during render and blank the whole app rather
// than just a panel, so every list degrades to empty instead.
export function normalisePayload(next: Partial<DuplicatePayload>): DuplicatePayload {
  return {
    groups: next.groups ?? [],
    folderGroups: next.folderGroups ?? [],
    containedFolders: next.containedFolders ?? [],
    folderPreferences: next.folderPreferences ?? [],
    lastScanAt: next.lastScanAt ?? null,
    candidateCount: next.candidateCount ?? 0,
    scanning: next.scanning ?? false,
    reclaimableBytes: next.reclaimableBytes ?? 0,
    pendingCount: next.pendingCount ?? 0,
    staleCount: next.staleCount ?? 0,
    libraries: next.libraries ?? []
  };
}

export const folderKey = (member: { libraryId: string; folderPath: string }): string =>
  `${member.libraryId} ${member.folderPath}`;

// The library's top folder is the root of every relative path, not a folder anyone
// named — so it shows as ".", the shell's name for exactly that. It used to read
// "Library root", which on a card beside a real folder name looked like one, and
// sent people off to open a folder that holds nothing of what the card was about.
export const ROOT_LABEL = ".";
export const ROOT_HINT = "The library's own top folder — the root of every path in it";

export const folderPathLabel = (member: { folderPath: string }): string =>
  member.folderPath || ROOT_LABEL;

// A photo can sit in no folder at all — directly in the library's own folder. That
// used to read "Library root", which is the name of a PLACE, so people went looking
// for it; open a library that files everything into dated subfolders and its top
// folder holds no photos whatsoever, and the label looks like a lie. It is the
// absence of a folder, and these say so.
//
// Not to be confused with folderPathLabel's "Library root" above, which is used
// where a FOLDER is the subject and the library's top folder really is the answer.
export const TOP_LEVEL = "Top level";
export const TOP_LEVEL_HINT = "Top level — directly in the library's own folder, not in any subfolder";

// The folder holding a copy, relative to its library. "" is the library root.
export function folderOf(member: DuplicateMember): string {
  const cut = member.path.lastIndexOf("/");
  return cut === -1 ? "" : member.path.slice(0, cut);
}

// A folder covers a path when it is that path or an ancestor of it — the rule both the
// filter and the keeper preference use, so picking "2017-12-10" means the folder and
// everything under it.
export function folderCovers(
  folder: { libraryId: string; folderPath: string },
  libraryId: string,
  path: string
): boolean {
  if (folder.libraryId !== libraryId) return false;
  return folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`);
}

// Every folder a duplicate was actually found in, with how many sets touch it. This is
// the whole vocabulary both pickers work in: offering a full folder tree would list
// thousands of folders with nothing duplicated in them.
export interface FolderOption {
  key: string;
  libraryId: string;
  libraryName: string;
  folderPath: string;
  setCount: number;
}

export function folderOptionsFrom(payload: DuplicatePayload): FolderOption[] {
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

// ── The shell the two folder pages share ────────────────────────────────────
//
// "Duplicate folders" and "Stored elsewhere" are two tabs over ONE scan: same
// payload, same toolbar, same filter box, same rebuild button, same card. Only the
// list in the middle differs — so everything around it lives here rather than being
// kept in step by hand across two files.

export type FolderSort = "newest" | "photos" | "size" | "name";

export const FOLDER_SORT_OPTIONS: { value: FolderSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "size", label: "Largest" },
  { value: "photos", label: "Most photos" },
  { value: "name", label: "Name A–Z" }
];

export const FOLDER_PER_PAGE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "25", label: "25" },
  { value: "50", label: "50" },
  { value: "all", label: "Show all" }
];

export function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** One page of a list, clamped rather than corrected in state — a list that shrinks
 *  under you (because you just deleted something) must not strand the view. */
export function pageSlice<T>(list: T[], perPage: string, page: number) {
  const pageSize = perPage === "all" ? Math.max(list.length, 1) : Number(perPage);
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  return {
    totalPages,
    currentPage,
    items: list.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    firstShown: list.length === 0 ? 0 : (currentPage - 1) * pageSize + 1,
    lastShown: Math.min(currentPage * pageSize, list.length)
  };
}

export function useDuplicateFolderPage(loadErrorMessage: string) {
  const [payload, setPayload] = useState<DuplicatePayload>(EMPTY_PAYLOAD);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  // Everything that narrows the page, in one box — see DuplicateFiltersModal.
  const [filters, setFilters] = useState<DuplicateFilterState>({
    scopeId: "", search: "", folders: [], tier: "all", mediaKind: "all"
  });
  const [sort, setSort] = useState<FolderSort>("newest");
  const [perPage, setPerPage] = useState("10");
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [preferDraft, setPreferDraft] = useState<PreferenceDraft>({});
  const [preferBusy, setPreferBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    setPayload(normalisePayload(await api<DuplicatePayload>("/api/library/gallery/duplicates")));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : loadErrorMessage))
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

  // Recompute every list from the digests already stored — no file is read. The lists
  // are caches, so this is the answer to anything that looks stale.
  const rebuild = async () => {
    setRebuilding(true);
    setActionError("");
    try {
      setPayload(normalisePayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/rebuild", {
        method: "POST",
        body: "{}"
      })));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to rebuild the results");
    } finally {
      setRebuilding(false);
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
      // A refusal can still have changed the server: an offer it recognised as dead
      // gets taken off the list as it declines. Re-read either way, so the page can't
      // go on showing the card the message just said was gone.
      await load().catch(() => { /* the error already on screen is the useful one */ });
    } finally {
      setBusyId("");
    }
  };

  const folderOptions = folderOptionsFrom(payload);
  // The saved keep/clear instructions, as edited in the Folders tab of the filter box.
  const savedPreferences = Object.fromEntries(payload.folderPreferences
    .map((folder) => [folderKey(folder), folder.mode] as const));

  // The server re-picks every automatic keeper as part of the same call and answers
  // with the whole page, so the list behind the dialog is already right when it shuts.
  const savePreferences = async (next: PreferenceDraft) => {
    setPreferDraft(next);
    setPreferBusy(true);
    setActionError("");
    try {
      const folders = folderOptions
        .filter((option) => next[option.key])
        .map((option) => ({ libraryId: option.libraryId, folderPath: option.folderPath, mode: next[option.key] }));
      setPayload(normalisePayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/preferred-folders", {
        method: "POST",
        body: JSON.stringify({ folders })
      })));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to save the folder choices");
      // Put the dialog back to what the server still holds, so it never shows a
      // choice that isn't stored.
      setPreferDraft(savedPreferences);
    } finally {
      setPreferBusy(false);
    }
  };

  // Anything that changes the list or its order returns to the first page.
  const { scopeId, search } = filters;
  const folderFilter = filters.folders;
  useEffect(() => { setPage(1); }, [search, scopeId, sort, perPage, folderFilter]);

  const chosenFolders = folderOptions.filter((option) => folderFilter.includes(option.key));

  return {
    payload, loaded, error, actionError, setActionError, busyId, setBusyId,
    rebuilding, load, rebuild, post,
    filters, setFilters, sort, setSort, perPage, setPerPage, page, setPage,
    filterOpen, setFilterOpen, preferDraft, setPreferDraft, preferBusy, savePreferences,
    savedPreferences, folderOptions, chosenFolders,
    busy: preferBusy || rebuilding || busyId !== "",
    scopeName: payload.libraries.find((library) => library.id === scopeId)?.name ?? "",
    needle: search.trim().toLowerCase(),
    filtering: search.trim() !== "" || scopeId !== "" || chosenFolders.length > 0,
    /** No folders ticked means "all of them" — a filter nobody set narrows nothing. */
    inChosenFolders: (libraryId: string, path: string) =>
      chosenFolders.length === 0 || chosenFolders.some((folder) => folderCovers(folder, libraryId, path))
  };
}

export type DuplicateFolderPage = ReturnType<typeof useDuplicateFolderPage>;

/** Filters, search, order and rebuild — identical on both folder tabs. */
export function DuplicateFolderToolbar({ page, searchHint }: { page: DuplicateFolderPage; searchHint: string }) {
  const active = activeFilterCount(page.filters, false);
  return (
    <div className="dup-toolbar dup-folder-toolbar">
      {/* The filter box holds library and folders; search and ordering sit out here
          because they are the two you reach for on every visit. */}
      <Button
        variant="secondary"
        compact
        className={active > 0 ? "is-active" : ""}
        disabled={page.busy}
        onClick={() => {
          page.setActionError("");
          page.setPreferDraft(page.savedPreferences);
          page.setFilterOpen(true);
        }}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        <span>{active > 0 ? `Filters (${active})` : "Filters"}</span>
      </Button>

      <label className="search-field dup-folder-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">{searchHint}</span>
        <input
          type="search"
          value={page.filters.search}
          placeholder="Search folders..."
          onChange={(event) => page.setFilters((current) => ({ ...current, search: event.target.value }))}
        />
      </label>

      <div className="dup-toolbar-controls">
        <SelectMenu
          value={page.sort}
          options={FOLDER_SORT_OPTIONS}
          label="Sort folders"
          className="dup-folder-sort-menu"
          onChange={page.setSort}
        />
        <SelectMenu
          value={page.perPage}
          options={FOLDER_PER_PAGE_OPTIONS}
          label="Cards per page"
          className="dup-per-page dup-folder-page-menu"
          onChange={page.setPerPage}
        />
        <Button
          variant="icon"
          disabled={page.busy}
          onClick={() => void page.rebuild()}
          aria-label={page.rebuilding ? "Rebuilding results…" : "Rebuild results from the last scan"}
          title={page.rebuilding ? "Rebuilding…" : "Rebuild results from the last scan (reads no files)"}
        >
          {page.rebuilding
            ? <span className="icon-spin" aria-hidden="true"><RefreshCw size={18} /></span>
            : <RefreshCw size={18} aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

const FOLDER_PREVIEW_LIMIT = 4;

export function folderPreviewSummary(urls: string[], total: number): string {
  const visible = Math.min(urls.length, FOLDER_PREVIEW_LIMIT, Math.max(total, 0));
  const hidden = Math.max(total - visible, 0);
  return hidden > 0
    ? `${visible} shown · ${hidden} hidden`
    : `${visible} shown`;
}

/** The pictures themselves — the fastest way to recognise which holiday this is. */
export function FolderStrip({ urls }: { urls: string[] }) {
  const strip = urls.slice(0, FOLDER_PREVIEW_LIMIT);
  return (
    <div className="dup-set-strip" aria-hidden="true">
      {strip.length > 0
        ? strip.map((url) => <img key={url} src={url} alt="" loading="lazy" />)
        : <span className="dup-set-strip-empty"><ImageOff size={18} /></span>}
    </div>
  );
}

/** One folder on a card: green for the one being kept, red for the one that goes,
 *  with its path, when it arrived, its size, and exactly one action. */
export function FolderTile({
  folder, keep, showLibrary, position, busy, onKeepInstead, note, action
}: {
  folder: DuplicateFolderDetail;
  keep: boolean;
  /** Off when the page is scoped to one library — the name would be on every tile. */
  showLibrary: boolean;
  /** Anything but the first tile is preceded by the arrow that separates them. */
  position: number;
  busy: boolean;
  /** Given when clicking the name promotes this folder to keeper. Left out where
   *  the keeper isn't a choice — coverage runs one way and swapping it deletes
   *  photos that exist nowhere else. */
  onKeepInstead?: () => void;
  /** A line of page-specific detail under the counts. */
  note?: ReactNode;
  action?: ReactNode;
}) {
  const name = (
    <>
      <FolderOpen size={17} aria-hidden="true" />
      <strong className="dup-set-folder-name">{folder.name}</strong>
    </>
  );

  return (
    <div className="dup-set-folder-wrap">
      {position > 0 && <ArrowRight className="dup-set-arrow" size={18} aria-hidden="true" />}
      <div className={`dup-set-folder${keep ? " is-keep" : " is-trash"}`}>
        <div className="dup-set-folder-top">
          <span className="dup-copy-badge dup-set-badge" aria-hidden="true">{keep ? "Keep" : "Delete"}</span>
          <a
            className="dup-set-open"
            href={`/gallery/folders/${folder.folderPath.split("/").map(encodeURIComponent).join("/")}?library=${encodeURIComponent(folder.libraryId)}`}
            target="_blank"
            rel="noreferrer"
            title="Open this folder in the gallery, in a new tab"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
        {/* The name swaps the keeper where that's allowed, without adding another
            visible action button to the folder tile. */}
        {onKeepInstead ? (
          <Button
            variant="text"
            className="dup-set-name-row dup-set-name-btn"
            disabled={busy}
            title="Keep this folder instead"
            onClick={onKeepInstead}
          >
            {name}
          </Button>
        ) : (
          <span className="dup-set-name-row">{name}</span>
        )}
        <span className="dup-set-path" title={folder.folderPath || ROOT_HINT}>{folderPathLabel(folder)}</span>
        <span className="dup-set-line">{formatWhen(folder.addedAt)}</span>
        <span className="dup-set-line">
          {formatBytes(folder.bytes)}
          {folder.linkCount > 0 ? ` · ${folder.linkCount} tags/links` : ""}
          {showLibrary ? ` · ${folder.libraryName}` : ""}
        </span>
        {note && <span className="dup-set-line dup-set-note">{note}</span>}
        {action && <>{action}</>}
      </div>
    </div>
  );
}

// The warning both pages open with. This is machinery that proposes deleting
// photographs; say so before anything else on the page.
export function ExperimentalNotice() {
  return (
    <MessageBox tone="warning" title="Experimental — check before you delete">
      Duplicate detection is new and still being proven. Look at what a set actually contains before removing anything,
      and start with a few sets rather than the bulk actions. Everything removed here goes to the Recycle Bin and can
      be restored until you empty it — but the safest order is check, test, and check again.
    </MessageBox>
  );
}

/** How a folder is marked in the picker while it's being edited. */
export type PreferenceDraft = Record<string, FolderPreferenceMode>;

const MODES: { value: FolderPreferenceMode | ""; label: string; short: string; hint: string }[] = [
  { value: "keep", label: "Keep here", short: "Keep", hint: "When copies are in several places, keep this one" },
  { value: "", label: "No preference", short: "—", hint: "Let the usual rules decide" },
  { value: "clear", label: "Clear out", short: "Clear", hint: "Keep the copies elsewhere and let this folder's go" }
];

// ── One box for every way of narrowing the page ─────────────────────────────
//
// Library, tier, folders and the search term were four controls in three places, and
// nothing said how they combined. They are one dialog now, in the order you'd reason
// in — which library, which kind, which folders, then the free-text sieve — with a
// count on the button so the page says it is narrowed even when the box is shut.
//
// This matters beyond tidiness: the bulk delete acts on exactly what these leave on
// screen, so "what am I filtered to?" and "what will that button do?" have to be the
// same question with one visible answer.
export interface DuplicateFilterState {
  scopeId: string;
  search: string;
  folders: string[];
  tier: DuplicateTier;
  mediaKind: DuplicateMediaKind;
}

export type DuplicateTier = "all" | "exact" | "near";

/** Photos and videos duplicate for different reasons and are cleared at different
 *  scales — a handful of videos can outweigh a thousand photos. */
export type DuplicateMediaKind = "all" | "photo" | "video";

const MEDIA_CHOICES: { value: DuplicateMediaKind; label: string }[] = [
  { value: "all", label: "Photos and videos" },
  { value: "photo", label: "Photos only" },
  { value: "video", label: "Videos only" }
];

const TIER_CHOICES: { value: DuplicateTier; label: string; hint: string }[] = [
  { value: "all", label: "All duplicates", hint: "Identical files and near-identical alike" },
  { value: "exact", label: "Identical files only", hint: "Byte-for-byte matches — nothing to compare" },
  { value: "near", label: "Near-identical only", hint: "Same picture, different file — worth a look first" }
];

/** How many of the four are doing something, for the button's badge. */
export function activeFilterCount(state: DuplicateFilterState, withTier: boolean): number {
  return (state.scopeId ? 1 : 0)
    + (state.folders.length > 0 ? 1 : 0)
    + (withTier && state.tier !== "all" ? 1 : 0)
    + (state.mediaKind !== "all" ? 1 : 0);
}

export function DuplicateFiltersModal({
  state,
  options,
  libraries,
  withTier,
  preferences,
  preferencesBusy,
  onPreferencesChange,
  onChange,
  onClose
}: {
  state: DuplicateFilterState;
  options: FolderOption[];
  libraries: DuplicateLibraryOption[];
  /** The photo page has two tiers to choose between; the folders page has none. */
  withTier: boolean;
  /** The saved keep/clear instructions, edited in the Folders tab. A server setting,
   *  unlike the filters around it — but saved the moment it's clicked, because a
   *  dialog where one control needs a separate Save reads as one that ignored you. */
  preferences: PreferenceDraft;
  preferencesBusy: boolean;
  onPreferencesChange: (next: PreferenceDraft) => void;
  onChange: (next: DuplicateFilterState) => void;
  onClose: () => void;
}) {
  // Two tabs rather than one long scroll: the folder list runs to as many rows as you
  // have folders, and stacking it under the other three pushed them out of sight. The
  // split is by kind of question — what to compare, then which folders — and each tab
  // carries a count so a filter set on the other one can't be forgotten about.
  const [tab, setTab] = useState<"what" | "folders">("what");
  const [folderQuery, setFolderQuery] = useState("");
  // Most duplicates first by default: on a long list that is the order you'd work in.
  const [folderSort, setFolderSort] = useState<"count" | "name">("count");
  const set = (patch: Partial<DuplicateFilterState>) => onChange({ ...state, ...patch });
  const active = activeFilterCount(state, withTier);
  const whatCount = active - (state.folders.length > 0 ? 1 : 0);

  const folderNeedle = folderQuery.trim().toLowerCase();
  const shownFolders = options
    .filter((option) => !folderNeedle
      || option.folderPath.toLowerCase().includes(folderNeedle)
      || option.libraryName.toLowerCase().includes(folderNeedle))
    .sort((a, b) => (folderSort === "count"
      ? b.setCount - a.setCount || a.folderPath.localeCompare(b.folderPath)
      : a.folderPath.localeCompare(b.folderPath)));

  return (
    <Modal title="Narrow what's shown" className="dup-filters-modal" onClose={onClose}>
      <div className="modal-tabs">
        <button
          type="button"
          className={`modal-tab${tab === "what" ? " active" : ""}`}
          onClick={() => setTab("what")}
        >
          What to show{whatCount > 0 ? ` (${whatCount})` : ""}
        </button>
        <button
          type="button"
          className={`modal-tab${tab === "folders" ? " active" : ""}`}
          onClick={() => setTab("folders")}
        >
          Folders{state.folders.length > 0 ? ` (${state.folders.length})` : ""}
        </button>
      </div>

      <div className="modal-tab-content dup-filter-form">
        {tab === "what" ? (
          <>
            <label className="dup-filter-field">
              <span className="dup-filter-label">Library</span>
              <select value={state.scopeId} onChange={(event) => set({ scopeId: event.target.value })}>
                <option value="">All libraries</option>
                {libraries.map((library) => (
                  <option key={library.id} value={library.id}>{library.name}</option>
                ))}
              </select>
              <span className="dup-filter-hint">
                Choosing one compares its photos with each other; copies in other libraries drop out.
              </span>
            </label>

            {withTier && (
              <div className="dup-filter-field">
                <span className="dup-filter-label">Which duplicates</span>
                <div className="dup-tier-choices" role="radiogroup" aria-label="Which duplicates to show">
                  {TIER_CHOICES.map((choice) => (
                    <label className={`dup-tier-choice${state.tier === choice.value ? " is-on" : ""}`} key={choice.value}>
                      <input
                        type="radio"
                        name="dup-tier"
                        checked={state.tier === choice.value}
                        onChange={() => set({ tier: choice.value })}
                      />
                      <span>
                        <strong>{choice.label}</strong>
                        <span className="datagrid-muted">{choice.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="dup-filter-field">
              <span className="dup-filter-label">Media type</span>
              <select
                value={state.mediaKind}
                onChange={(event) => set({ mediaKind: event.target.value as DuplicateMediaKind })}
              >
                {MEDIA_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
            </label>

          </>
        ) : (
          <div className="dup-filter-field">
            <span className="dup-filter-hint">
              Only folders something duplicated was found in. A folder covers everything below it.
              Tick a folder to work on it — that just narrows the page. <strong>Keep</strong> and
              <strong> Clear</strong> are saved instructions about which copy survives — they save as you click them.
            </span>

            {options.length > 0 && (
              <div className="dup-folder-tools">
                <input
                  type="search"
                  value={folderQuery}
                  placeholder="Find a folder"
                  aria-label="Find a folder in this list"
                  onChange={(event) => setFolderQuery(event.target.value)}
                />
                <Button
                  variant="icon"
                  className="dup-folder-sort"
                  aria-label={folderSort === "count" ? "Sorted by most sets first — switch to name order" : "Sorted by name — switch to most sets first"}
                  title={folderSort === "count" ? "Most sets first" : "Name A–Z"}
                  onClick={() => setFolderSort((current) => (current === "count" ? "name" : "count"))}
                >
                  {folderSort === "count"
                    ? <ArrowDownWideNarrow size={17} aria-hidden="true" />
                    : <ArrowDownAZ size={17} aria-hidden="true" />}
                </Button>
              </div>
            )}

            {options.length > 0 ? (
              shownFolders.length > 0 ? (
              <div className="dup-folder-picker dup-folder-picker-tall">
                {shownFolders.map((option) => (
                  <div className="dup-folder-choice dup-folder-row" key={option.key}>
                    <input
                      type="checkbox"
                      id={`work-${option.key}`}
                      aria-label={`Work on ${option.folderPath || `every folder in ${option.libraryName}`}`}
                      checked={state.folders.includes(option.key)}
                      onChange={(event) => set({
                        folders: event.target.checked
                          ? [...state.folders, option.key]
                          : state.folders.filter((key) => key !== option.key)
                      })}
                    />
                    {/* An empty path here is NOT "the photos loose at the top" — every
                        folder covers what is below it, and this one is below the whole
                        library. Naming it after a folder invited people to go and look
                        at that folder, which is the wrong mental model entirely: keep
                        or clear on this row is an instruction about the library. */}
                    <label className="dup-folder-choice-body" htmlFor={`work-${option.key}`}>
                      <strong>{option.folderPath || `Everywhere in ${option.libraryName}`}</strong>
                      <span className="datagrid-muted">
                        {option.folderPath ? `${option.libraryName} · ` : ""}
                        {option.setCount} set{option.setCount === 1 ? "" : "s"}
                      </span>
                    </label>
                    <span className="dup-mode-group" role="radiogroup" aria-label={`When copies are in several places, ${option.folderPath || `everywhere in ${option.libraryName}`}`}>
                      {MODES.map((mode) => (
                        <label className={`dup-mode${(preferences[option.key] ?? "") === mode.value ? " is-on" : ""}`} key={mode.label} title={mode.hint}>
                          <input
                            type="radio"
                            name={`pref-${option.key}`}
                            checked={(preferences[option.key] ?? "") === mode.value}
                            disabled={preferencesBusy}
                            onChange={() => {
                              const next = { ...preferences };
                              if (mode.value === "") delete next[option.key];
                              else next[option.key] = mode.value;
                              onPreferencesChange(next);
                            }}
                          />
                          <span>{mode.short}</span>
                        </label>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
              ) : (
                <p className="management-empty">No folder matches “{folderQuery.trim()}”.</p>
              )
            ) : (
              <p className="management-empty">Nothing found yet, so there are no folders to choose.</p>
            )}
          </div>
        )}
      </div>

      <div className="modal-actions">
        <Button
          variant="text"
          disabled={active === 0 || preferencesBusy}
          onClick={() => onChange({ scopeId: "", search: "", folders: [], tier: "all", mediaKind: "all" })}
        >
          Clear filters
        </Button>
        <Button variant="secondary" disabled={preferencesBusy} onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
