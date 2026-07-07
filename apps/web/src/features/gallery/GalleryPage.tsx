import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Circle, Combine, FolderOpen, Image as ImageIcon, Images, MapPin, Pencil, Play, Heart, Folder, ScanFace, Sparkles, SquareCheck, Trash2, UploadCloud, Users, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader, AudiobookHeaderSort, formatCount } from "../audiobooks/AudiobooksPage";
import type { SortKey } from "../audiobooks/BookFilter";
import { GalleryLightbox } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryFaceSettingsModal } from "./GalleryFaceSettingsModal";
import { GalleryFilterButton, GalleryFilterChips, EMPTY_GALLERY_FILTERS, activeGalleryFilterCount, type GalleryFilters } from "./GalleryFilter";
import type { GalleryAsset, GalleryFaceSettings, GalleryFacets, GalleryFolder, GalleryLibrary, GalleryMapPoint, GalleryMemories, GalleryPerson } from "./types";

const PAGE_SIZE = 80;
// The People grid can hold thousands of clusters; render them a page at a time so a
// wall of avatar thumbnails doesn't flood the cover route (and trip its rate limit).
const PEOPLE_PAGE = 120;

// Leaflet (~140 KB) is only needed for the Map view, so it loads on demand — keeping
// it off the initial bundle for the common Timeline/Folder browsing.
const GalleryMap = lazy(() => import("./GalleryMap").then((m) => ({ default: m.GalleryMap })));

type GalleryView = "timeline" | "folder" | "map" | "people" | "memories";
type TimelineSort = "taken" | "added";

// Timeline sort, presented through the same compact dropdown the audiobooks/ebooks
// header uses, so the controls line up visually. The media-type (photo/video)
// filter lives in the Filter panel with the other facets.
const SORT_OPTIONS = [
  { value: "taken" as const, label: "Date taken" },
  { value: "added" as const, label: "Date uploaded" }
];

// Titles for the Memories strip — the server reports how wide it had to match
// before it found anything, and the heading must not overpromise.
const MEMORIES_TITLES: Record<GalleryMemories["precision"], string> = {
  day: "On this day",
  near: "Around this day",
  month: "This month over the years"
};

function yearsAgo(year: number): string {
  const diff = new Date().getFullYear() - year;
  return diff === 1 ? "1 year ago" : `${diff} years ago`;
}

// Date heading for one year group in the Memories view — today's month/day
// projected onto that year, phrased to match the precision tier.
function memoryDateLabel(precision: GalleryMemories["precision"], year: number): string {
  const now = new Date();
  if (precision === "month") {
    return new Date(year, now.getMonth(), 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  }
  const day = new Date(year, now.getMonth(), now.getDate())
    .toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return precision === "near" ? `Around ${day}` : day;
}

// Calendar-day label for the timeline header from an asset's takenAt.
function dayLabel(takenAt: string | null): string {
  if (!takenAt) return "Undated";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Undated";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function AssetTile({
  asset,
  onOpen,
  selectionMode,
  selected,
  onToggleSelect,
  onRemove
}: {
  asset: GalleryAsset;
  onOpen: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  // When set (person page), a corner button detaches this photo from the person.
  onRemove?: () => void;
}) {
  const tile = (
    <button
      type="button"
      className={`gallery-tile${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}
      onClick={selectionMode ? onToggleSelect : onOpen}
      aria-pressed={selectionMode ? selected : undefined}
      aria-label={selectionMode ? `Select ${asset.title}` : `Open ${asset.title}`}
    >
      {asset.coverUrl ? (
        <img src={asset.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
      )}
      {asset.saved && !selectionMode && <Heart size={14} className="gallery-fav-dot" fill="currentColor" aria-hidden="true" />}
      {asset.kind === "video" && (
        <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
      )}
      {/* Only a selected tile gets the check overlay — unselected tiles stay
          clean rather than all sprouting empty circles in selection mode. */}
      {selectionMode && selected && (
        <span className="gallery-tile-check" aria-hidden="true">
          <CheckCircle2 size={22} />
        </span>
      )}
    </button>
  );
  if (!onRemove) return tile;
  return (
    <div className="gallery-tile-wrap">
      {tile}
      <button
        type="button"
        className="gallery-tile-remove"
        onClick={(event) => { event.stopPropagation(); onRemove(); }}
        aria-label={`Remove ${asset.title} from this person`}
        title="Not this person — remove from here"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// A person's avatar with a graceful fallback: if the crop can't load (a missing file,
// or a request that got rate-limited), show the placeholder icon instead of the
// browser's broken-image glyph.
function PersonAvatar({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <UserRound size={28} aria-hidden="true" />;
  return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function GalleryPage({
  user,
  logout,
  initialAssetId,
  initialView
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  initialAssetId?: string;
  initialView?: GalleryView;
}) {
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const [view, setView] = useState<GalleryView>(initialView ?? "timeline");
  const [scopeId, setScopeId] = useState<string>("all");
  const [sort, setSort] = useState<TimelineSort>("taken");

  // Search box drives the timeline `q`; a debounce keeps typing from spamming the API.
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");

  // Advanced filters (people/years/tags/cameras/location) — timeline-scoped, like
  // the audiobook catalog's filter panel. Facets supply the option lists.
  const [filters, setFilters] = useState<GalleryFilters>(EMPTY_GALLERY_FILTERS);
  const [facets, setFacets] = useState<GalleryFacets | null>(null);

  // Timeline state.
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Memories ("On this day"): feeds the strip above the timeline AND the
  // dedicated Memories view. `pendingYear` scrolls the view to a year section
  // right after a strip card opens it.
  const [memories, setMemories] = useState<GalleryMemories | null>(null);
  const [pendingYear, setPendingYear] = useState<number | null>(null);

  // Folder state.
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);
  // Folder to open on the next switch into the Folders view (set by the lightbox's
  // Folder link); the view-change effect consumes it instead of loading the root.
  const pendingFolderRef = useRef<string | null>(null);

  // Map state. `mapCount` (geotagged assets in scope, from the facets) gates whether
  // the Map tab is offered at all; `mapPoints` are the markers for the active scope/kind.
  const [mapPoints, setMapPoints] = useState<GalleryMapPoint[]>([]);
  const mapCount = facets?.withGps ?? 0;

  // People state. The People view shows person chips; picking one drills into that
  // person's photos (`personAssets`), which open in the lightbox like any other list.
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<{ id: string; name: string } | null>(null);
  const [personAssets, setPersonAssets] = useState<GalleryAsset[]>([]);
  const [personTotal, setPersonTotal] = useState(0);
  // Face recognition (admin): per-library settings + the settings popup.
  const [faceSettings, setFaceSettings] = useState<GalleryFaceSettings | null>(null);
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  // Inline rename of the open person.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [personDeleteOpen, setPersonDeleteOpen] = useState(false);
  const [showSmallGroups, setShowSmallGroups] = useState(false);
  // How many cards each section of the People grid currently renders (paged).
  const [visiblePeople, setVisiblePeople] = useState(PEOPLE_PAGE);
  const [visibleSmall, setVisibleSmall] = useState(PEOPLE_PAGE);

  // Library selector dropdown (mirrors the audiobooks/ebooks main page chip).
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<{ source: "timeline" | "folder" | "single" | "person" | "memory"; index: number } | null>(null);
  const [singleAsset, setSingleAsset] = useState<GalleryAsset | null>(null);

  // Upload (source-writing, policy-gated): the modal is offered when any library
  // accepts uploads. A notice confirms the batch after the modal closes.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState("");

  // Multi-select for bulk delete (mirrors the audiobook/ebook Select mode). Tiles
  // toggle selection instead of opening; the bulk bar acts on the chosen assets.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");

  const scopeParams = useCallback(() => (
    scopeId === "all" ? { scope: "all" as const } : { scope: "library" as const, libraryId: scopeId }
  ), [scopeId]);

  const loadLibraries = useCallback(async () => {
    try {
      const payload = await api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries");
      setLibraries(payload.libraries);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load gallery libraries");
    }
  }, []);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  // Debounce the search box into the query that hits the API.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  // Searching/filtering is a timeline operation (folder view is structural); either
  // pulls the user into the timeline so results are visible.
  useEffect(() => {
    if ((query || activeGalleryFilterCount(filters) > 0) && view === "folder") setView("timeline");
  }, [query, filters, view]);

  const loadTimeline = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
        method: "POST",
        body: JSON.stringify({ ...scopeParams(), q: query, kinds: filters.kinds, filters, sort, limit: PAGE_SIZE, offset })
      });
      setAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load photos");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, sort, query, filters]);

  const loadFolder = useCallback(async (nextParent: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ ...scopeParams(), parent: nextParent, limit: "200" } as Record<string, string>);
      const payload = await api<{ parent: string; folders: GalleryFolder[]; assets: GalleryAsset[] }>(
        `/api/library/gallery/folders?${params}`
      );
      setFolders(payload.folders);
      setFolderAssets(payload.assets);
      setParent(payload.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load folder");
    } finally {
      setLoading(false);
    }
  }, [scopeParams]);

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ ...scopeParams(), kinds: filters.kinds.join(",") } as Record<string, string>);
      const payload = await api<{ points: GalleryMapPoint[] }>(`/api/library/gallery/map?${params}`);
      setMapPoints(payload.points);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the map");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, filters.kinds]);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    setError("");
    setVisiblePeople(PEOPLE_PAGE);
    setVisibleSmall(PEOPLE_PAGE);
    try {
      const params = new URLSearchParams(scopeParams() as Record<string, string>);
      const payload = await api<{ people: GalleryPerson[] }>(`/api/library/gallery/people?${params}`);
      setPeople(payload.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load people");
    } finally {
      setLoading(false);
    }
  }, [scopeParams]);

  // Drill into one person's photos (opened from a person chip). Paged like the
  // timeline: offset 0 replaces the grid, later offsets append. A person can have
  // thousands of photos, so we never try to pull them all in one request — that
  // both hid photos past the server's page cap and flooded the thumbnail route.
  const openPerson = useCallback(async (person: { id: string; name: string }, offset = 0) => {
    setLoading(true);
    setError("");
    setSelectedPerson(person);
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/people/${person.id}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      setPersonAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setPersonTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this person's photos");
    } finally {
      setLoading(false);
    }
  }, []);

  const isAdmin = user.role === "admin";
  const canCuratePeople = libraries.some((library) => library.canWrite);

  const loadFaceSettings = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setFaceSettings(await api<GalleryFaceSettings>("/api/library/gallery/faces/settings"));
    } catch { /* non-admins / errors just hide the controls */ }
  }, [isAdmin]);

  const anyFaceEnabled = (faceSettings?.libraries ?? []).some((library) => library.enabled);

  const submitRename = useCallback(async () => {
    if (!selectedPerson || renameValue == null) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setSelectedPerson({ ...selectedPerson, name });
      setRenameValue(null);
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename");
    }
  }, [selectedPerson, renameValue, loadPeople]);

  const confirmMerge = useCallback(async (targetId: string) => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}/merge`, { method: "POST", body: JSON.stringify({ intoId: targetId }) });
      setMergeOpen(false);
      setSelectedPerson(null);
      void loadPeople();
      setNotice("People merged.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to merge");
    }
  }, [selectedPerson, loadPeople]);

  // Detach one photo from the open person (a mismatched auto-cluster member, or a
  // manual tag). Drops it from the grid optimistically and refreshes counts.
  const removeFromPerson = useCallback(async (assetId: string) => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/assets/${assetId}/people/${selectedPerson.id}`, { method: "DELETE" });
      setPersonAssets((prev) => prev.filter((a) => a.id !== assetId));
      setPersonTotal((n) => Math.max(0, n - 1));
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the photo");
    }
  }, [selectedPerson, loadPeople]);

  const confirmDeletePerson = useCallback(async () => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}`, { method: "DELETE" });
      setPersonDeleteOpen(false);
      setSelectedPerson(null);
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete");
    }
  }, [selectedPerson, loadPeople]);

  // Facets for the current scope: the filter-panel option lists plus the geotagged
  // count that decides whether the Map tab appears.
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(scopeParams() as Record<string, string>);
    api<GalleryFacets>(`/api/library/gallery/facets?${params}`)
      .then((payload) => { if (alive) setFacets(payload); })
      .catch(() => { /* facets are advisory; the filter lists just stay empty */ });
    return () => { alive = false; };
  }, [scopeParams]);

  // Memories, scope-dependent like the facets; the date is the viewer's local
  // calendar day (the server may be in another timezone, and "on this day"
  // belongs to whoever is looking at the screen). perYear is the server-side
  // max so the Memories view has every photo, not a sample.
  const loadMemories = useCallback(async () => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const params = new URLSearchParams({ ...scopeParams(), date, perYear: "200" } as Record<string, string>);
    try {
      setMemories(await api<GalleryMemories>(`/api/library/gallery/memories?${params}`));
    } catch { /* advisory; the strip/view just stay empty */ }
  }, [scopeParams]);

  useEffect(() => { void loadMemories(); }, [loadMemories]);

  // The Memories lightbox runs over ALL years flattened (newest year first,
  // chronological within a year), so Next flows from one year into the next.
  const memoryItems = useMemo(() => memories?.groups.flatMap((group) => group.items) ?? [], [memories]);

  // A strip card opens the Memories view anchored at its year.
  const openMemoryYear = useCallback((year: number) => {
    setPendingYear(year);
    setView("memories");
  }, []);

  useEffect(() => {
    if (view !== "memories" || pendingYear == null) return;
    document.getElementById(`gallery-memories-${pendingYear}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingYear(null);
  }, [view, pendingYear]);

  // Fetch one asset and open it standalone in the lightbox (used by map markers).
  const openAssetById = useCallback((id: string) => {
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${id}`)
      .then((payload) => { setSingleAsset(payload.asset); setLightbox({ source: "single", index: 0 }); })
      .catch(() => { /* asset gone / no access */ });
  }, []);

  // Reload the active view when scope/sort/query/filters/view changes.
  // (Memories loads through its own scope-keyed effect above.)
  useEffect(() => {
    if (view === "timeline") void loadTimeline(0);
    else if (view === "folder") {
      const target = pendingFolderRef.current ?? "";
      pendingFolderRef.current = null;
      void loadFolder(target);
    }
    else if (view === "people") { setSelectedPerson(null); void loadPeople(); void loadFaceSettings(); }
    else if (view === "map") void loadMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scopeId, sort, query, filters]);

  // Deep link: fetch the asset and open a standalone lightbox.
  useEffect(() => {
    if (!initialAssetId) return;
    let alive = true;
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${initialAssetId}`)
      .then((payload) => { if (alive) { setSingleAsset(payload.asset); setLightbox({ source: "single", index: 0 }); } })
      .catch(() => { /* asset gone / no access — fall back to the timeline */ });
    return () => { alive = false; };
  }, [initialAssetId]);

  // While a library is scanning, refresh so new assets/thumbnails appear.
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      void loadLibraries();
      if (view === "timeline") void loadTimeline(0);
      else if (view === "folder") void loadFolder(parent);
      else if (view === "memories") void loadMemories();
      else if (view === "map") void loadMap();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [libraries, view, parent, loadLibraries, loadTimeline, loadFolder, loadMemories, loadMap]);

  // Library selector dropdown open/close + outside-click dismissal.
  const toggleLibraryMenu = () => {
    setLibraryMenuOpen((open) => {
      if (!open && libraryTriggerRef.current) {
        const rect = libraryTriggerRef.current.getBoundingClientRect();
        setLibraryMenuPos({ top: rect.bottom + 8, left: rect.left });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!libraryMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (libraryTriggerRef.current?.contains(target)) return;
      if (libraryMenuRef.current?.contains(target)) return;
      setLibraryMenuOpen(false);
    };
    const dismiss = () => setLibraryMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [libraryMenuOpen]);

  const activeAssets = lightbox?.source === "single" && singleAsset
    ? [singleAsset]
    : lightbox?.source === "folder" ? folderAssets
      : lightbox?.source === "person" ? personAssets
        : lightbox?.source === "memory" ? memoryItems : assets;

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);
  const currentLibrary = lightbox != null && activeAssets[lightbox.index]
    ? libraryFor(activeAssets[lightbox.index].libraryId)
    : undefined;
  const canDeleteCurrent = currentLibrary?.canDelete ?? false;
  const canEditCurrent = currentLibrary?.canWrite ?? false;
  const canShareCurrent = currentLibrary?.canCurate ?? false;

  const uploadLibraries = libraries.filter((library) => library.canUpload);
  const selectedLibraryLabel = scopeId === "all" ? "All Libraries" : libraryFor(scopeId)?.name ?? "All Libraries";

  // Reload whichever view is active plus the library list (counts / scan badges).
  const refreshView = useCallback(() => {
    if (view === "timeline") void loadTimeline(0);
    else if (view === "folder") void loadFolder(parent);
    else if (view === "people") { void loadPeople(); if (selectedPerson) void openPerson(selectedPerson); }
    else if (view === "memories") void loadMemories();
    else if (view === "map") void loadMap();
    void loadLibraries();
  }, [view, parent, selectedPerson, loadTimeline, loadFolder, loadPeople, openPerson, loadMemories, loadMap, loadLibraries]);

  // Assets currently shown (the selectable set depends on the active view).
  const displayedAssets = view === "timeline" ? assets : folderAssets;
  const canDeleteAny = libraries.some((library) => library.canDelete);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkError("");
  };

  // Changing the dataset (view / scope / search / filters) clears any selection so
  // a stale id from a no-longer-visible asset can't linger. Sorting only reorders
  // the same assets, so it keeps the selection.
  useEffect(() => { setSelectionMode(false); setSelectedIds(new Set()); }, [view, scopeId, query, filters]);

  const confirmBulkDelete = async () => {
    setBulkBusy(true);
    setBulkError("");
    try {
      const result = await api<{ deleted: number; forbidden: number; failed: number }>(
        "/api/library/books/bulk-delete",
        { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
      );
      setBulkDeleteOpen(false);
      exitSelection();
      const parts: string[] = [`Moved ${result.deleted} item${result.deleted === 1 ? "" : "s"} to the Recycle Bin`];
      if (result.forbidden > 0) parts.push(`${result.forbidden} skipped (no permission)`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      setNotice(`${parts.join(" · ")}.`);
      refreshView();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unable to move the items to the Recycle Bin");
    } finally {
      setBulkBusy(false);
    }
  };

  const closeLightbox = () => {
    setLightbox(null);
    setSingleAsset(null);
    if (initialAssetId) navigate("/gallery");
  };

  // Jump from the lightbox's Folder link to that folder in the Folders view.
  // Search/filters are timeline-scoped (an active one bounces the user back to
  // the timeline), so they clear as part of the jump. `query` is set directly —
  // waiting for the debounce would re-fire the view effect after the pending
  // folder was consumed and reset the view to the folder root.
  const openAssetFolder = (folder: string) => {
    closeLightbox();
    if (view === "folder") { void loadFolder(folder); return; }
    setSearchText("");
    setQuery("");
    setFilters(EMPTY_GALLERY_FILTERS);
    pendingFolderRef.current = folder;
    setView("folder");
  };

  // Group timeline assets into calendar-day buckets for the date headers, keyed on
  // whichever date the timeline is sorted by so the buckets stay consecutive.
  const days = useMemo(() => {
    const out: { label: string; items: { asset: GalleryAsset; index: number }[] }[] = [];
    assets.forEach((asset, index) => {
      const label = dayLabel(sort === "added" ? asset.addedAt : asset.takenAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ asset, index });
      else out.push({ label, items: [{ asset, index }] });
    });
    return out;
  }, [assets, sort]);

  // Select or deselect every asset taken on one calendar day. Using a day header's
  // checkbox also enters selection mode, so it works as the entry point too.
  const toggleDaySelect = (ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      ids.forEach((id) => { if (allSelected) next.delete(id); else next.add(id); });
      return next;
    });
    setSelectionMode(true);
  };

  const breadcrumbParts = parent ? parent.split("/") : [];
  const memoriesTotal = memories?.groups.reduce((sum, group) => sum + group.count, 0) ?? 0;
  const subtitle = view === "map"
    ? `${formatCount(mapPoints.length)} on the map`
    : view === "people"
      ? (selectedPerson ? `${formatCount(personTotal)} ${personTotal === 1 ? "photo" : "photos"}` : `${formatCount(people.length)} ${people.length === 1 ? "person" : "people"}`)
      : view === "memories"
        ? `${formatCount(memoriesTotal)} ${memoriesTotal === 1 ? "photo" : "photos"} from past years`
        : view === "timeline"
          ? `${formatCount(total)} ${total === 1 ? "item" : "items"}`
          : "Browsing by folder";

  return (
    <DashboardShell active="gallery" user={user} logout={logout}>
      <section className="audiobook-main-page gallery-page">
        <AudiobookPageHeader
          title="Gallery"
          subtitle={subtitle}
          search={searchText}
          onSearchChange={setSearchText}
          searchPlaceholder="Search photos & videos..."
          actions={
            <>
              <GalleryFilterButton facets={facets} value={filters} onChange={setFilters} compact />
              <AudiobookHeaderSort
                value={sort as unknown as SortKey}
                onChange={(value) => setSort(value as unknown as TimelineSort)}
                options={SORT_OPTIONS as unknown as { value: SortKey; label: string }[]}
                ariaLabel="Sort timeline"
                compact
              />
              {uploadLibraries.length > 0 && !selectionMode && (
                <button
                  type="button"
                  className="audiobook-page-action-icon"
                  onClick={() => { setNotice(""); setUploadOpen(true); }}
                  aria-label="Upload"
                  title="Upload"
                >
                  <UploadCloud size={18} aria-hidden="true" />
                </button>
              )}
              {canDeleteAny && !selectionMode && view !== "map" && view !== "people" && view !== "memories" && (
                <button
                  type="button"
                  className="audiobook-page-action-icon"
                  onClick={() => { setNotice(""); setSelectionMode(true); }}
                  aria-label="Select"
                  title="Select"
                >
                  <SquareCheck size={18} aria-hidden="true" />
                </button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Gallery error">{error}</MessageBox>}
        {notice && <MessageBox tone="success" title="Upload complete">{notice}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <ImageIcon size={58} aria-hidden="true" />
            <h2>No gallery libraries yet</h2>
            <p className="muted">An administrator can add a gallery library from the control panel.</p>
          </div>
        ) : (
          <>
            <div className="audiobook-page-nav-row audiobook-main-nav-row">
              <div className="audiobook-page-tabs-with-library">
                <div className="audiobook-library-shortcuts">
                  <button
                    ref={libraryTriggerRef}
                    type="button"
                    className="audiobook-library-tab"
                    onClick={toggleLibraryMenu}
                    aria-haspopup="menu"
                    aria-expanded={libraryMenuOpen}
                    aria-label="Select library"
                  >
                    <Images size={19} aria-hidden="true" />
                    <span>{selectedLibraryLabel}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  {libraryMenuOpen && libraryMenuPos && createPortal(
                    <div
                      ref={libraryMenuRef}
                      className="book-detail-action-menu audiobook-library-menu"
                      role="menu"
                      aria-label="Select library"
                      style={{ position: "fixed", top: libraryMenuPos.top, left: libraryMenuPos.left, right: "auto" }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={scopeId === "all" ? "active" : ""}
                        onClick={() => { setScopeId("all"); setLibraryMenuOpen(false); }}
                      >
                        <span>All Libraries</span>
                      </button>
                      {libraries.map((library) => (
                        <button
                          key={library.id}
                          type="button"
                          role="menuitem"
                          className={scopeId === library.id ? "active" : ""}
                          onClick={() => { setScopeId(library.id); setLibraryMenuOpen(false); }}
                        >
                          <span>{library.name}</span>
                        </button>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>

                <nav className="audiobook-page-tabs" aria-label="Gallery views">
                  <a
                    href="/gallery"
                    className={view === "timeline" ? "active" : ""}
                    onClick={(event) => { event.preventDefault(); setView("timeline"); }}
                  >
                    <CalendarDays size={19} aria-hidden="true" />
                    <span>Timeline</span>
                  </a>
                  {(memories?.groups.length ?? 0) > 0 && (
                    <a
                      href="/gallery/memories"
                      className={view === "memories" ? "active" : ""}
                      onClick={(event) => { event.preventDefault(); setSearchText(""); setView("memories"); }}
                    >
                      <Sparkles size={19} aria-hidden="true" />
                      <span>Memories</span>
                    </a>
                  )}
                  <a
                    href="/gallery"
                    className={view === "folder" ? "active" : ""}
                    onClick={(event) => { event.preventDefault(); setSearchText(""); setView("folder"); }}
                  >
                    <FolderOpen size={19} aria-hidden="true" />
                    <span>Folders</span>
                  </a>
                  <a
                    href="/gallery"
                    className={view === "people" ? "active" : ""}
                    onClick={(event) => { event.preventDefault(); setSearchText(""); setView("people"); }}
                  >
                    <Users size={19} aria-hidden="true" />
                    <span>People</span>
                  </a>
                  {mapCount > 0 && (
                    <a
                      href="/gallery"
                      className={view === "map" ? "active" : ""}
                      onClick={(event) => { event.preventDefault(); setSearchText(""); setView("map"); }}
                    >
                      <MapPin size={19} aria-hidden="true" />
                      <span>Map</span>
                    </a>
                  )}
                </nav>
              </div>
            </div>

            {view === "timeline" && <GalleryFilterChips value={filters} onChange={setFilters} />}

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">Thumbnails appear as the scan finishes.</MessageBox>
            )}

            {selectionMode && (
              <div className="audiobook-bulk-bar">
                <span className="audiobook-bulk-count">{selectedIds.size} selected</span>
                <div className="row-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => setSelectedIds(new Set(displayedAssets.map((asset) => asset.id)))}
                    disabled={displayedAssets.length === 0}
                  >
                    Select all loaded
                  </button>
                  <button
                    type="button"
                    className="danger-button compact-button"
                    onClick={() => { setBulkError(""); setBulkDeleteOpen(true); }}
                    disabled={selectedIds.size === 0}
                  >
                    <Trash2 size={15} aria-hidden="true" /> Delete
                  </button>
                  <button type="button" className="icon-button" onClick={exitSelection} aria-label="Cancel selection">
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            {view === "map" ? (
              <>
                <Suspense fallback={<p className="management-empty">Loading map…</p>}>
                  <GalleryMap points={mapPoints} onOpen={openAssetById} />
                </Suspense>
                {!loading && mapPoints.length === 0 && (
                  <p className="management-empty">No photos or videos with location data{filters.kinds.length > 0 ? ` of this type` : ""} in this library.</p>
                )}
              </>
            ) : view === "people" ? (
              selectedPerson ? (
                <>
                  <div className="gallery-breadcrumb">
                    <button type="button" onClick={() => { setSelectedPerson(null); setRenameValue(null); setMergeOpen(false); void loadPeople(); }}>All people</button>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <ChevronRight size={14} aria-hidden="true" />
                      <strong>{selectedPerson.name || "Unnamed"}</strong>
                    </span>
                  </div>

                  {canCuratePeople && (
                    <div className="gallery-person-toolbar">
                      {renameValue == null ? (
                        <button type="button" className="secondary-button compact-button" onClick={() => setRenameValue(selectedPerson.name)}>
                          <Pencil size={14} aria-hidden="true" /> {selectedPerson.name ? "Rename" : "Name person"}
                        </button>
                      ) : (
                        <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                          <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Name" autoFocus maxLength={120} />
                          <button type="submit" className="primary-button compact-button" disabled={!renameValue.trim()}>Save</button>
                          <button type="button" className="icon-button" onClick={() => setRenameValue(null)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button>
                        </form>
                      )}
                      {people.length > 1 && (
                        <button type="button" className="secondary-button compact-button" onClick={() => setMergeOpen((v) => !v)}>
                          <Combine size={14} aria-hidden="true" /> Merge
                        </button>
                      )}
                      <button type="button" className="danger-button compact-button" onClick={() => setPersonDeleteOpen(true)}>
                        <Trash2 size={14} aria-hidden="true" /> Delete
                      </button>
                    </div>
                  )}

                  {mergeOpen && (
                    <div className="gallery-merge-panel">
                      <span>Merge <strong>{selectedPerson.name || "Unnamed"}</strong> into:</span>
                      <select defaultValue="" onChange={(event) => { if (event.target.value) void confirmMerge(event.target.value); }}>
                        <option value="" disabled>Choose a person…</option>
                        {people.filter((p) => p.id !== selectedPerson.id).map((p) => (
                          <option key={p.id} value={p.id}>{(p.name || "Unnamed")} ({p.faceCount})</option>
                        ))}
                      </select>
                      <button type="button" className="icon-button" onClick={() => setMergeOpen(false)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button>
                    </div>
                  )}

                  <div className="gallery-grid">
                    {personAssets.map((asset, index) => (
                      <AssetTile
                        key={asset.id}
                        asset={asset}
                        onOpen={() => setLightbox({ source: "person", index })}
                        selectionMode={false}
                        selected={false}
                        onToggleSelect={() => { /* selection disabled in People view */ }}
                        onRemove={canCuratePeople ? () => void removeFromPerson(asset.id) : undefined}
                      />
                    ))}
                  </div>
                  {!loading && personAssets.length === 0 && (
                    <p className="management-empty">No photos for this person yet.</p>
                  )}
                  {personAssets.length < personTotal && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                      <button type="button" className="secondary-button" onClick={() => void openPerson(selectedPerson, personAssets.length)} disabled={loading}>
                        {loading ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {isAdmin && (
                    <div className="gallery-face-admin">
                      <button type="button" className="secondary-button compact-button" onClick={() => setFaceModalOpen(true)}>
                        <ScanFace size={14} aria-hidden="true" /> Face recognition
                      </button>
                      <span className="muted gallery-face-hint">
                        {anyFaceEnabled
                          ? "Detecting faces and grouping people automatically — manage per library."
                          : "Turn on face recognition per library to auto-detect people in your photos."}
                      </span>
                    </div>
                  )}

                  {(() => {
                    // Keep named people and multi-photo groups up front; tuck unnamed
                    // single-photo groups into a collapsible "Small groups" section so a
                    // long tail of singletons doesn't bury the people that matter.
                    const main = people.filter((p) => p.name || p.faceCount > 1);
                    const small = people.filter((p) => !p.name && p.faceCount <= 1);
                    const card = (person: GalleryPerson) => (
                      <button key={person.id} type="button" className="gallery-person-card" onClick={() => void openPerson(person)}>
                        <span className="gallery-person-avatar">
                          <PersonAvatar url={person.coverUrl} />
                        </span>
                        <strong className={person.name ? undefined : "gallery-person-unnamed"}>{person.name || "Unnamed"}</strong>
                        <small>{person.faceCount.toLocaleString()} {person.faceCount === 1 ? "photo" : "photos"}</small>
                      </button>
                    );
                    const showMore = (onClick: () => void) => (
                      <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                        <button type="button" className="secondary-button" onClick={onClick}>Show more people</button>
                      </div>
                    );
                    return (
                      <>
                        {main.length > 0 && <div className="gallery-people-grid">{main.slice(0, visiblePeople).map(card)}</div>}
                        {main.length > visiblePeople && showMore(() => setVisiblePeople((n) => n + PEOPLE_PAGE))}
                        {small.length > 0 && (
                          <div className="gallery-small-groups">
                            <button type="button" className="gallery-small-toggle" onClick={() => setShowSmallGroups((v) => !v)}>
                              <ChevronRight size={15} className={showSmallGroups ? "rotated" : ""} aria-hidden="true" />
                              {small.length.toLocaleString()} small group{small.length === 1 ? "" : "s"} (one photo each)
                            </button>
                            {showSmallGroups && (
                              <>
                                <div className="gallery-people-grid">{small.slice(0, visibleSmall).map(card)}</div>
                                {small.length > visibleSmall && showMore(() => setVisibleSmall((n) => n + PEOPLE_PAGE))}
                              </>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {!loading && people.length === 0 && (
                    <div className="empty-state library-empty">
                      <Users size={48} aria-hidden="true" />
                      <h2>No people yet</h2>
                      <p className="muted">
                        {isAdmin && !anyFaceEnabled
                          ? "Turn on face recognition (button above) to auto-detect people — or open a photo's details to tag someone by hand."
                          : "Open a photo, show its details, and add a person to start grouping by who's in them."}
                      </p>
                    </div>
                  )}
                </>
              )
            ) : view === "memories" ? (
              (memories?.groups.length ?? 0) > 0 ? (
                (() => {
                  // Tiles open the lightbox at the asset's position in the
                  // FLATTENED memories list, so Next flows across year sections.
                  let flatBase = 0;
                  return memories!.groups.map((group) => {
                    const start = flatBase;
                    flatBase += group.items.length;
                    return (
                      <section key={group.year} id={`gallery-memories-${group.year}`} className="gallery-memories-year" aria-label={`Memories from ${group.year}`}>
                        <div className="gallery-memories-year-head">
                          <h2>{memoryDateLabel(memories!.precision, group.year)}</h2>
                          <small>{yearsAgo(group.year)} · {group.count} {group.count === 1 ? "photo" : "photos"}</small>
                        </div>
                        <div className="gallery-grid">
                          {group.items.map((asset, i) => (
                            <AssetTile
                              key={asset.id}
                              asset={asset}
                              onOpen={() => setLightbox({ source: "memory", index: start + i })}
                              selectionMode={false}
                              selected={false}
                              onToggleSelect={() => { /* selection disabled in Memories */ }}
                            />
                          ))}
                        </div>
                      </section>
                    );
                  });
                })()
              ) : (
                <div className="empty-state library-empty">
                  <Sparkles size={48} aria-hidden="true" />
                  <h2>No memories today</h2>
                  <p className="muted">
                    When photos from past years match today's date, they show up here. Check back tomorrow —
                    or add dates to older photos and they'll start resurfacing.
                  </p>
                </div>
              )
            ) : view === "timeline" ? (
              <>
                {memories && memories.groups.length > 0 && !query && activeGalleryFilterCount(filters) === 0 && !selectionMode && (
                  <section className="gallery-memories" aria-label="Memories">
                    <h2 className="gallery-memories-title">{MEMORIES_TITLES[memories.precision]}</h2>
                    <div className="gallery-memories-row">
                      {memories.groups.map((group) => (
                        <button
                          key={group.year}
                          type="button"
                          className="gallery-memory-card"
                          onClick={() => openMemoryYear(group.year)}
                          aria-label={`${MEMORIES_TITLES[memories.precision]} in ${group.year} — ${group.count} ${group.count === 1 ? "photo" : "photos"}`}
                        >
                          {group.items[0]?.coverUrl ? (
                            <img src={group.items[0].coverUrl} alt="" loading="lazy" />
                          ) : (
                            <span className="gallery-memory-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                          )}
                          <span className="gallery-memory-overlay">
                            <strong>{group.year}</strong>
                            <small>{yearsAgo(group.year)} · {group.count} {group.count === 1 ? "photo" : "photos"}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {days.map((day) => {
                  const ids = day.items.map(({ asset }) => asset.id);
                  const allSelected = ids.every((id) => selectedIds.has(id));
                  return (
                    <div key={day.items[0].asset.id}>
                      <div className="gallery-day-head">
                        {canDeleteAny && (
                          <button
                            type="button"
                            className={`gallery-day-select${allSelected ? " selected" : ""}`}
                            onClick={() => toggleDaySelect(ids)}
                            role="checkbox"
                            aria-checked={allSelected}
                            aria-label={`Select all from ${day.label}`}
                            title={allSelected ? "Deselect this day" : "Select this day"}
                          >
                            {allSelected ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                          </button>
                        )}
                        <h2 className="gallery-day-label">{day.label}</h2>
                      </div>
                      <div className="gallery-grid">
                        {day.items.map(({ asset, index }) => (
                          <AssetTile
                            key={asset.id}
                            asset={asset}
                            onOpen={() => setLightbox({ source: "timeline", index })}
                            selectionMode={selectionMode}
                            selected={selectedIds.has(asset.id)}
                            onToggleSelect={() => toggleSelect(asset.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!loading && assets.length === 0 && (
                  <p className="management-empty">{query ? "No photos or videos match this search." : "No photos or videos to show."}</p>
                )}
                {assets.length < total && (
                  <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                    <button type="button" className="secondary-button" onClick={() => void loadTimeline(assets.length)} disabled={loading}>
                      {loading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="gallery-breadcrumb">
                  <button type="button" onClick={() => void loadFolder("")}>All folders</button>
                  {breadcrumbParts.map((part, i) => {
                    const target = breadcrumbParts.slice(0, i + 1).join("/");
                    return (
                      <span key={target} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <ChevronRight size={14} aria-hidden="true" />
                        <button type="button" onClick={() => void loadFolder(target)}>{part}</button>
                      </span>
                    );
                  })}
                </div>

                {folders.length > 0 && (
                  <>
                    <p className="gallery-section-label">Folders</p>
                    <div className="gallery-folder-grid">
                      {folders.map((folder) => (
                        <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void loadFolder(folder.path)}>
                          <span className="gallery-folder-thumb">
                            {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                          </span>
                          <strong>{folder.name}</strong>
                          <small>{folder.assetCount.toLocaleString()} {folder.assetCount === 1 ? "item" : "items"}</small>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {folderAssets.length > 0 && (
                  <>
                    <p className="gallery-section-label">Photos &amp; videos</p>
                    <div className="gallery-grid">
                      {folderAssets.map((asset, index) => (
                        <AssetTile
                          key={asset.id}
                          asset={asset}
                          onOpen={() => setLightbox({ source: "folder", index })}
                          selectionMode={selectionMode}
                          selected={selectedIds.has(asset.id)}
                          onToggleSelect={() => toggleSelect(asset.id)}
                        />
                      ))}
                    </div>
                  </>
                )}

                {!loading && folders.length === 0 && folderAssets.length === 0 && (
                  <p className="management-empty">This folder is empty.</p>
                )}
              </>
            )}
          </>
        )}
      </section>

      {lightbox && activeAssets[lightbox.index] && (
        <GalleryLightbox
          assets={activeAssets}
          index={lightbox.index}
          canDelete={canDeleteCurrent}
          canEdit={canEditCurrent}
          canShare={canShareCurrent}
          onClose={closeLightbox}
          onIndexChange={(next) => setLightbox((current) => (current ? { ...current, index: next } : current))}
          onChanged={refreshView}
          onOpenFolder={openAssetFolder}
        />
      )}

      {uploadOpen && uploadLibraries.length > 0 && (
        <GalleryUploadModal
          libraries={uploadLibraries}
          onClose={() => setUploadOpen(false)}
          onUploaded={(count, libraryName) => {
            setUploadOpen(false);
            setNotice(`Added ${count} item${count === 1 ? "" : "s"} to ${libraryName}.`);
            refreshView();
          }}
        />
      )}

      {bulkDeleteOpen && (
        <ConfirmDialog
          title={`Move ${selectedIds.size} ${selectedIds.size === 1 ? "item" : "items"} to the Recycle Bin?`}
          confirmLabel={`Move ${selectedIds.size} ${selectedIds.size === 1 ? "item" : "items"}`}
          busyLabel="Moving…"
          busy={bulkBusy}
          error={bulkError}
          danger
          onConfirm={() => void confirmBulkDelete()}
          onCancel={() => { if (!bulkBusy) setBulkDeleteOpen(false); }}
        >
          These items move into the Recycle Bin and leave the gallery for everyone. You can restore them
          from the Recycle Bin, or delete them permanently from there.
        </ConfirmDialog>
      )}

      {faceModalOpen && (
        <GalleryFaceSettingsModal
          onClose={() => setFaceModalOpen(false)}
          onChanged={() => { void loadFaceSettings(); void loadLibraries(); if (view === "people") void loadPeople(); }}
        />
      )}

      {personDeleteOpen && selectedPerson && (
        <ConfirmDialog
          title={`Delete "${selectedPerson.name || "Unnamed"}"?`}
          confirmLabel="Delete person"
          danger
          onConfirm={() => void confirmDeletePerson()}
          onCancel={() => setPersonDeleteOpen(false)}
        >
          This removes the person and untags their photos. The photos themselves are not affected, and
          you can tag them again later.
        </ConfirmDialog>
      )}
    </DashboardShell>
  );
}
