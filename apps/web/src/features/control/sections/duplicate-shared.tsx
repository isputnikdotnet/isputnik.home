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
  ArrowDownAZ, ArrowDownWideNarrow, ArrowRight, ExternalLink, FolderOpen, FolderTree,
  ImageOff, RefreshCw, Search, SlidersHorizontal
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
  /** Copies in libraries outside the chosen one — cut from the set by scoping, never
   *  deleted, but said out loud so "delete every copy" can't read as removing the
   *  picture outright when another library still holds it. 0 when unscoped. */
  elsewhereCount?: number;
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

/** Two folders that share SOME identical photos — neither equal nor contained. The
 *  action deletes only the shared copies from the losing side; both folders stay. */
export interface FolderOverlapPair {
  kind: "overlap";
  id: string;
  /** Chosen by the server at read time: a protected library first, then the saved
   *  Keep/Clear instructions, then the usual scoring. Not swappable here. */
  keep: DuplicateFolderDetail;
  lose: DuplicateFolderDetail;
  sharedCount: number;
  sharedBytes: number;
  keepExtraCount: number;
  loseExtraCount: number;
  keeperReason: string | null;
  /** False when the losing side's library forbids deleting too — the pair is shown,
   *  the button isn't offered. */
  canDelete: boolean;
  coverUrls: string[];
}

/** One entry on the merged folder page — three strengths of the same relationship. */
export type FolderMatch =
  | ({ kind: "identical" } & DuplicateFolderGroup)
  | ({ kind: "contained" } & ContainedFolder)
  | FolderOverlapPair;

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
  /** False for an external library, or one with deleting turned off. Its copies are
   *  still found and shown; nothing may remove them. */
  canDelete?: boolean;
}

// The page-level payload: scan status, the folder-shaped answers, and the filter
// box's vocabulary. Deliberately NOT the photo sets — those are paged, and asking
// for all of them was a response describing every duplicate in the install, rebuilt
// on every load and every three seconds during a scan. See DuplicatePage.
export interface DuplicatePayload {
  folderPreferences: FolderPreference[];
  /** The filter box's folder list, built server-side across all three answers. */
  folderOptions: FolderOption[];
  /** How many of each folder answer there are — the lists themselves are paged. */
  folderSetCount: number;
  containedCount: number;
  overlapCount: number;
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

/** One page of photo sets, plus the totals the page reports — which describe every
 *  match, not the page, so the counts never shrink to the size of the slice. */
export interface DuplicatePage {
  groups: DuplicateGroup[];
  total: number;
  /** Sets found, before any filter — what "N hidden" is measured against. */
  allSets: number;
  page: number;
  scopedSets: number;
  scopedExtraCopies: number;
  scopedReclaimableBytes: number;
  spanning: number;
  exactTotal: number;
  sweepableSets: number;
  sweepableCopies: number;
  sweepableBytes: number;
}

export const EMPTY_PAGE: DuplicatePage = {
  groups: [], total: 0, allSets: 0, page: 1, scopedSets: 0, scopedExtraCopies: 0,
  scopedReclaimableBytes: 0, spanning: 0, exactTotal: 0, sweepableSets: 0, sweepableCopies: 0,
  sweepableBytes: 0
};

export const EMPTY_PAYLOAD: DuplicatePayload = {
  folderPreferences: [], folderOptions: [], folderSetCount: 0, containedCount: 0, overlapCount: 0,
  lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
  scanning: false, reclaimableBytes: 0, libraries: []
};

// A response missing a field would throw during render and blank the whole app rather
// than just a panel, so every list degrades to empty instead.
export function normalisePayload(next: Partial<DuplicatePayload>): DuplicatePayload {
  return {
    folderPreferences: next.folderPreferences ?? [],
    folderOptions: next.folderOptions ?? [],
    folderSetCount: next.folderSetCount ?? 0,
    containedCount: next.containedCount ?? 0,
    overlapCount: next.overlapCount ?? 0,
    lastScanAt: next.lastScanAt ?? null,
    candidateCount: next.candidateCount ?? 0,
    scanning: next.scanning ?? false,
    reclaimableBytes: next.reclaimableBytes ?? 0,
    pendingCount: next.pendingCount ?? 0,
    staleCount: next.staleCount ?? 0,
    libraries: next.libraries ?? []
  };
}

export function normalisePage(next: Partial<DuplicatePage>): DuplicatePage {
  return { ...EMPTY_PAGE, ...next, groups: next.groups ?? [] };
}

/** The filters, as the query string both the search and the sweep-ids routes take.
 *  One function, so the page can never confirm a count from one set of filters and
 *  delete against another. */
export function duplicateQuery(state: DuplicateFilterState, options: FolderOption[], extra?: {
  sort?: string;
  page?: number;
  perPage?: number;
}): string {
  const params = new URLSearchParams();
  if (state.scopeId) params.set("library", state.scopeId);
  if (state.tier !== "all") params.set("tier", state.tier);
  if (state.mediaKind !== "all") params.set("kind", state.mediaKind);
  if (state.search.trim()) params.set("q", state.search.trim());
  const chosen = options.filter((option) => state.folders.includes(option.key));
  if (chosen.length > 0) {
    params.set("folders", JSON.stringify(chosen.map((option) => ({
      libraryId: option.libraryId,
      folderPath: option.folderPath
    }))));
  }
  if (extra?.sort) params.set("sort", extra.sort);
  if (extra?.page) params.set("page", String(extra.page));
  if (extra?.perPage !== undefined) params.set("perPage", String(extra.perPage));
  return params.toString();
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

/** The path line on a folder tile. A folder shows its path; the library's own top
 *  folder shows what it is, because "." there reads as a location and the photos in
 *  question are nowhere near the root. */
export const folderTilePath = (folder: { folderPath: string }): string =>
  folder.folderPath || "Everything in this library";

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

// Built by the server now, across all three answers at once — the page no longer
// holds the full set list this was derived from.
export const folderOptionsFrom = (payload: DuplicatePayload): FolderOption[] => payload.folderOptions;

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

/** One page of whichever folder answer a tab shows. The two differ in what an item
 *  is and in nothing else, so they share this. */
export interface FolderListPage<T> {
  items: T[];
  /** Matching the filters — what the pager counts. */
  total: number;
  /** Found by the scan, before any filter. */
  allItems: number;
  page: number;
  reclaimableBytes: number;
}

const emptyList = <T,>(): FolderListPage<T> =>
  ({ items: [], total: 0, allItems: 0, page: 1, reclaimableBytes: 0 });

// The server names them `groups`/`allSets` on one route and `rows`/`allRows` on the
// other; the tabs care about neither distinction.
function normaliseList<T>(next: Record<string, unknown>): FolderListPage<T> {
  return {
    items: (next.matches ?? next.groups ?? next.rows ?? []) as T[],
    total: (next.total as number) ?? 0,
    allItems: (next.allMatches ?? next.allSets ?? next.allRows ?? 0) as number,
    page: (next.page as number) ?? 1,
    reclaimableBytes: (next.reclaimableBytes as number) ?? 0
  };
}

export function useDuplicateFolderPage<T>(loadErrorMessage: string, listPath: string) {
  const [payload, setPayload] = useState<DuplicatePayload>(EMPTY_PAYLOAD);
  const [list, setList] = useState<FolderListPage<T>>(emptyList<T>());
  const [listLoaded, setListLoaded] = useState(false);
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

  // The cards themselves, one page at a time — their expensive half (thumbnails, and
  // a link count over what may be a whole library) is built only for what's on screen.
  const loadList = async () => {
    const query = duplicateQuery(filters, payload.folderOptions, {
      sort,
      page,
      perPage: perPage === "all" ? 0 : Number(perPage)
    });
    setList(normaliseList<T>(await api<Record<string, unknown>>(`${listPath}?${query}`)));
  };

  const reload = async () => { await Promise.all([load(), loadList()]); };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : loadErrorMessage))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      loadList()
        .catch((err) => setError(err instanceof Error ? err.message : loadErrorMessage))
        .finally(() => setListLoaded(true));
    }, filters.search ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [
    filters.scopeId, filters.search, filters.folders, sort, perPage, page, payload.folderOptions
  ]);

  // A scan started on the Duplicate photos page rebuilds these too, so follow it here
  // rather than showing a stale list until the tab is reopened.
  useEffect(() => {
    if (!payload.scanning) {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      void load().catch(() => { /* keep polling */ });
      void loadList().catch(() => { /* keep polling */ });
    }, 3000);
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
      await loadList();
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
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : whenFailed);
      // A refusal can still have changed the server: an offer it recognised as dead
      // gets taken off the list as it declines. Re-read either way, so the page can't
      // go on showing the card the message just said was gone.
      await reload().catch(() => { /* the error already on screen is the useful one */ });
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
    rebuilding, load, loadList, reload, rebuild, post,
    /** The page of cards, and the totals describing every match rather than the slice. */
    list, listLoaded,
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

export type DuplicateFolderPageState = ReturnType<typeof useDuplicateFolderPage>;

/** Filters, search, order and rebuild — identical on both folder tabs. */
export function DuplicateFolderToolbar({ page, searchHint }: { page: DuplicateFolderPageState; searchHint: string }) {
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
export function FolderStrip({ urls, total }: { urls: string[]; total?: number }) {
  const strip = urls.slice(0, FOLDER_PREVIEW_LIMIT);
  const hidden = Math.max((total ?? urls.length) - strip.length, 0);
  return (
    <div className="dup-set-strip" aria-hidden="true">
      {strip.length > 0
        ? strip.map((url) => <img key={url} src={url} alt="" loading="lazy" />)
        : <span className="dup-set-strip-empty"><ImageOff size={18} /></span>}
      {hidden > 0 && (
        <span className="dup-set-strip-more">
          +{hidden}
          <small>more</small>
        </span>
      )}
    </div>
  );
}

/** One folder on a card: green for the one being kept, red for the one that goes.
 *  Its name, its path, and the library it's in — nothing else. */
export function FolderTile({
  folder, keep, position, busy, onKeepInstead, note, action, showOpenLink = false
}: {
  folder: DuplicateFolderDetail;
  keep: boolean;
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
  showOpenLink?: boolean;
}) {
  const location = folder.folderPath ? `/${folder.libraryName}/${folder.folderPath}` : `/${folder.libraryName}`;
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
          {showOpenLink && (
            <a
              className="dup-set-open"
              href={`/gallery/folders/${folder.folderPath.split("/").map(encodeURIComponent).join("/")}?library=${encodeURIComponent(folder.libraryId)}`}
              target="_blank"
              rel="noreferrer"
              title="Open this folder in the gallery, in a new tab"
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
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
        {/* Three lines and no more: what the folder is called, where it is, and which
            library it's in. Size, date added and the tags/links count were on here
            too — true, and none of them the thing you are deciding with. The header
            above already carries what the set holds and what clearing it frees. */}
        <span className="dup-set-path" title={folder.folderPath || ROOT_HINT}>
          <FolderTree size={12} aria-hidden="true" />
          <span>{location}</span>
        </span>
        {folder.addedAt && <span className="dup-set-line">{formatWhen(folder.addedAt)}</span>}
        <span className="dup-set-line">{formatBytes(folder.bytes)}</span>
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
  // Libraries the app may read but not delete from — external, or deleting turned off.
  const protectedLibraries = new Set(libraries.filter((library) => library.canDelete === false).map((library) => library.id));
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
                      {MODES.map((mode) => {
                        // "Clear out" means "let this folder's copies go", which an
                        // external library can't do — its files are not ours to
                        // remove. Offering it would be an instruction the scan then
                        // has to ignore, so it isn't offered.
                        const blocked = mode.value === "clear" && protectedLibraries.has(option.libraryId);
                        return (
                        <label
                          className={`dup-mode${(preferences[option.key] ?? "") === mode.value ? " is-on" : ""}${blocked ? " is-blocked" : ""}`}
                          key={mode.label}
                          title={blocked ? `"${option.libraryName}" is external, so nothing can be cleared out of it` : mode.hint}
                        >
                          <input
                            type="radio"
                            name={`pref-${option.key}`}
                            checked={(preferences[option.key] ?? "") === mode.value}
                            disabled={preferencesBusy || blocked}
                            onChange={() => {
                              const next = { ...preferences };
                              if (mode.value === "") delete next[option.key];
                              else next[option.key] = mode.value;
                              onPreferencesChange(next);
                            }}
                          />
                          <span>{mode.short}</span>
                        </label>
                        );
                      })}
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
