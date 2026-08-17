import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Album, ArrowLeft, CalendarClock, CalendarDays, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Circle, Combine, Compass, Download, Film, FolderOpen, FolderPlus, Image as ImageIcon, ImagePlus, LayoutGrid, LibraryBig, ListMusic, MapPin, MapPinned, Pencil, Play, Plus, Heart, Folder, RefreshCw, Share2, Sparkles, SquareCheck, Trash2, UploadCloud, Users, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, galleryHref, navigate, type GalleryView } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { formatCount } from "../audiobooks/AudiobooksPage";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SortMenu } from "../../shared/SortMenu";
import { useIsMobile } from "../../shared/useIsMobile";
import { SectionNav, type SectionNavItem } from "../../shared/SectionNav";
import { AssetTile, PersonAvatar, type LightboxSource } from "./AssetTile";
import { useGalleryAlbums } from "./useGalleryAlbums";
import { useGallerySlideshows } from "./useGallerySlideshows";
import { useGalleryPeople } from "./useGalleryPeople";
import { GalleryLightbox } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryFilterButton, GalleryFilterChips, EMPTY_GALLERY_FILTERS, activeGalleryFilterCount, type GalleryFilters } from "./GalleryFilter";
import { GROUPING_OPTIONS, TILE_SIZE_OPTIONS, galleryGridClass, readGalleryView, writeGalleryView, type GalleryGrouping, type GalleryTileSize, type GalleryViewPrefs } from "./gallery-view";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { AddToAlbumModal } from "./AddToAlbumModal";
import { AddToSlideshowModal } from "./AddToSlideshowModal";
import { GalleryDateModal } from "./GalleryDateModal";
import { GalleryLocationModal } from "./GalleryLocationModal";
import { GalleryFolderPicker } from "./GalleryFolderPicker";
import { GallerySlideshowEditor } from "./GallerySlideshowEditor";
import { ShareSetModal } from "../share/ShareSetModal";
import { ShareAlbumModal } from "./ShareAlbumModal";
import { Modal } from "../../shared/Modal";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import type { GalleryAlbum, GalleryAlbumDetail, GalleryAsset, GalleryFaceSettings, GalleryFacets, GalleryFolder, GalleryLibrary, GalleryMapPoint, GalleryMemories, GalleryMemoryGroup, GalleryMemorySuggestion, GalleryPerson, GallerySlideshow, GallerySlideshowDetail, GallerySlideshowSettings, SlideshowTransition } from "./types";
import { faceFocusStyle } from "./types";

const PAGE_SIZE = 80;
// The People grid can hold thousands of clusters; render them a page at a time so a
// wall of avatar thumbnails doesn't flood the cover route (and trip its rate limit).
const PEOPLE_PAGE = 120;

// Leaflet (~140 KB) is only needed for the Map view, so it loads on demand — keeping
// it off the initial bundle for the common Timeline/Folder browsing.
const GalleryMap = lazy(() => import("./GalleryMap").then((m) => ({ default: m.GalleryMap })));

type TimelineSort = "taken" | "added";

// What the page calls itself in each view. The Timeline is the gallery's own
// front page, so it keeps the section's name; every other view is titled after
// the nav item that opens it, the way Series and Narrators are under Audiobooks.
const VIEW_TITLES: Record<GalleryView, string> = {
  timeline: "Gallery",
  memories: "Memories",
  albums: "Albums",
  slideshows: "Slideshows",
  folder: "Folders",
  people: "People",
  map: "Map"
};

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
// projected onto that year, phrased to match the precision tier. Takes the
// GROUP's precision, not the row's: years widen independently, so a 1990 photo
// dated two days off says "Around August 11, 1990" while the rest of the row
// still says the day itself.
function memoryDateLabel(precision: GalleryMemoryGroup["precision"], year: number): string {
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

export function GalleryPage({
  user,
  logout,
  view,
  initialAssetId,
  initialFolder,
  initialLibraryId
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  /** Which browse view the address names. Not state — the URL is the view, so
   *  every one of them can be linked to, opened in a new tab and stepped back
   *  out of; switching views goes through goToView() below. */
  view: GalleryView;
  initialAssetId?: string;
  /** Deep link (/gallery/folders/…): open the Folders view straight into this folder. */
  initialFolder?: string;
  initialLibraryId?: string | null;
}) {
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = user.role === "admin";
  // Declared up here with error/loading because the view hooks below report into
  // all three — one loading flag, one error box, one notice line for the page.
  const [notice, setNotice] = useState("");

  // Switching view is a navigation. The page itself is not remounted — App hands
  // every gallery address to this same component — so the scope, sort and loaded
  // libraries survive the move, exactly as they did when view was useState.
  const goToView = useCallback((next: GalleryView) => navigate(galleryHref(next)), []);

  const [sort, setSort] = useState<TimelineSort>("taken");

  // How the photo grids look: tile size, and whether the timeline comes in dated
  // sections or as one uninterrupted grid. Both live behind the toolbar's View
  // menu and are remembered between visits (see gallery-view.ts).
  const [viewPrefs, setViewPrefs] = useState<GalleryViewPrefs>(readGalleryView);
  useEffect(() => { writeGalleryView(viewPrefs); }, [viewPrefs]);
  const gridClass = galleryGridClass(viewPrefs.tileSize);

  // Search box drives the timeline `q`; a debounce keeps typing from spamming the API.
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");

  // Advanced filters (people/years/tags/cameras/location) — timeline-scoped, like
  // the audiobook catalog's filter panel. Facets supply the option lists. Which
  // libraries a view draws from lives here too, as the first facet, rather than
  // a picker of its own — a deep link into one library's folder tree (Folders'
  // "?library=") seeds it with that one library chosen.
  const [filters, setFilters] = useState<GalleryFilters>(() => ({
    ...EMPTY_GALLERY_FILTERS,
    libraries: initialLibraryId ? [initialLibraryId] : []
  }));
  const [facets, setFacets] = useState<GalleryFacets | null>(null);
  // A few actions — rescanning a folder, Folders' own scope — only make sense
  // against exactly one library, the same way Audiobooks only offers "Add to
  // series" once its library filter narrows to one.
  const soleLibraryId = filters.libraries.length === 1 ? filters.libraries[0] : null;

  // Timeline state.
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Memories ("On this day"): feeds the strip above the timeline AND the
  // dedicated Memories view.
  const [memories, setMemories] = useState<GalleryMemories | null>(null);
  const [memorySuggestions, setMemorySuggestions] = useState<GalleryMemorySuggestion[]>([]);
  // A suggestion opened for PREVIEW — nothing is created until the user picks an
  // action in the modal. previewAssets null = thumbnails still loading.
  const [previewSuggestion, setPreviewSuggestion] = useState<GalleryMemorySuggestion | null>(null);
  const [previewAssets, setPreviewAssets] = useState<GalleryAsset[] | null>(null);

  // Folder state.
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);
  // Photos/videos sitting DIRECTLY in the open folder (subfolders excluded) — the
  // grid below only holds a page of them, so the count comes from the server.
  const [folderTotal, setFolderTotal] = useState(0);

  // The Albums and Slideshows views own their own state and loaders. Destructured
  // back into the names the rest of this file already uses, so the seam is the
  // state and not a rewrite of the markup.
  // Above the view hooks because People is scope-filtered and takes this. Omitted
  // entirely when no library is chosen — every accessible one, same as before.
  const scopeParams = useCallback(() => (
    filters.libraries.length > 0 ? { libraryIds: filters.libraries.join(",") } : {}
  ), [filters.libraries]);

  const status = { setLoading, setError, setNotice };
  const {
    albums, setAlbums, selectedAlbum, setSelectedAlbum, albumAssets, setAlbumAssets,
    albumTotal, setAlbumTotal, albumCreateOpen, setAlbumCreateOpen,
    albumNewName, setAlbumNewName, albumNewDesc, setAlbumNewDesc,
    albumRename, setAlbumRename, albumDeleteOpen, setAlbumDeleteOpen,
    albumBusy, setAlbumBusy, shareAlbumOpen, setShareAlbumOpen,
    bulkAlbumOpen, setBulkAlbumOpen, coverPickerOpen, setCoverPickerOpen,
    albumBrowseOpen, setAlbumBrowseOpen,
    loadAlbums, openAlbum, patchAlbum, setAlbumCover,
    removeFromAlbum, createAlbumSubmit, confirmDeleteAlbum
  } = useGalleryAlbums(status);
  const {
    slideshows, selectedSlideshow, setSelectedSlideshow,
    slideshowAssets, setSlideshowAssets, slideshowTotal, setSlideshowTotal,
    slideshowCreateOpen, setSlideshowCreateOpen,
    slideshowNewName, setSlideshowNewName, slideshowRename, setSlideshowRename,
    slideshowDeleteOpen, setSlideshowDeleteOpen, slideshowBusy,
    bulkSlideshowOpen, setBulkSlideshowOpen, browseOpen, setBrowseOpen,
    slideshowCoverPickerOpen, setSlideshowCoverPickerOpen,
    movieDeleteOpen, setMovieDeleteOpen, movieDeleteBusy,
    slideshowSettings, loadSlideshowSettings, setRenderLibrary,
    loadSlideshows, openSlideshow, patchSlideshow, setSlideshowCover, renderSlideshowMovie,
    deleteSlideshowMovie, reorderSlideshow, removeFromSlideshow,
    createSlideshowSubmit, confirmDeleteSlideshow
  } = useGallerySlideshows({ ...status, isAdmin });
  const {
    people, selectedPerson, setSelectedPerson, personAssets, personTotal,
    renameValue, setRenameValue, mergeOpen, setMergeOpen,
    personCoverPickerOpen, setPersonCoverPickerOpen, setPersonCover,
    personDeleteOpen, setPersonDeleteOpen, personPick, setPersonPick,
    moveNewName, setMoveNewName, movingPhotos,
    showSmallGroups, setShowSmallGroups,
    visiblePeople, setVisiblePeople, visibleSmall, setVisibleSmall,
    anyFaceEnabled, loadPeople, openPerson, loadFaceSettings, submitRename,
    confirmMerge, removeFromPerson, togglePersonPick, movePickedPhotos,
    confirmDeletePerson
  } = useGalleryPeople({ ...status, scopeParams, isAdmin });

  // What the header's one search box means here — and whether it is offered at
  // all. Timeline and Folders are a stream of photos, so the box searches the
  // photos themselves (and Folders hands off to the Timeline, where results can
  // be seen). The three list views are named things, so it filters that list by
  // name, in memory. Memories is a fixed handful of anniversaries and the Map is
  // everything at once — neither has anything to search, so neither shows a box.
  //
  // A list view with one of its things OPEN is showing that thing's photos, not
  // the list, so its box goes too until you come back out.
  const browsingPhotos = view === "timeline" || view === "folder";
  const browsingNamedList =
    (view === "albums" && !selectedAlbum)
    || (view === "slideshows" && !selectedSlideshow)
    || (view === "people" && !selectedPerson);
  const hasSearch = browsingPhotos || browsingNamedList;
  // An open album, slideshow or person has its own compact icon topbar (Back
  // plus every action) and its cover-title heading — the shared toolbar and
  // page header would only repeat that, so both step aside while one is open.
  // The toolbar still needs to come back for a live selection, though — it's
  // the only place the bulk-action bar renders, and Albums' own Select uses it.
  const openDetailView = (view === "albums" && selectedAlbum) || (view === "slideshows" && selectedSlideshow) || (view === "people" && selectedPerson);
  const showBrowseChrome = !openDetailView;
  // People's own toolbar only ever held Filter (libraries-only) and Upload —
  // neither pulls its weight on a page about who's in your photos, so it goes
  // without one entirely (list and open-person alike), unlike Albums/
  // Slideshows which only step aside while something specific is open.
  const showToolbar = showBrowseChrome && view !== "people";
  const searchPlaceholder = view === "timeline"
    ? "Search photos & videos..."
    : view === "folder" ? "Search folders..."
      : view === "albums" ? "Search albums..."
        : view === "slideshows" ? "Search slideshows..."
          : "Search people...";

  // Folder to open on the next switch into the Folders view (set by the lightbox's
  // Folder link); the view-change effect consumes it instead of loading the root.
  const pendingFolderRef = useRef<string | null>(null);
  // A /gallery/folders/… deep link can't use the ref above: the view effect already
  // holds "folder" on mount, and StrictMode invokes it twice — the first pass would
  // consume the ref and the second would fall through to the library root. State
  // survives both passes, and is dropped as soon as the folder view is navigated.
  const [deepLinkFolder, setDeepLinkFolder] = useState<string | null>(initialFolder ?? null);

  // Map state. `mapCount` (geotagged assets in scope, from the facets) gates whether
  // the Map tab is offered at all; `mapPoints` are the markers for the active scope/kind.
  const [mapPoints, setMapPoints] = useState<GalleryMapPoint[]>([]);
  const mapCount = facets?.withGps ?? 0;

  const isMobile = useIsMobile();

  // Mobile / PWA: "Browse" dropdown that collapses the view tabs (Timeline,
  // Memories, Albums, …), matching the audiobooks/ebooks compact header.
  // ("viewMenu" rather than "browse" — browseOpen is the slideshow photo browser.)
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewMenuPos, setViewMenuPos] = useState<{ top: number; left: number | null; right: number | null } | null>(null);
  const viewMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<{ source: LightboxSource; index: number; autoPlay?: boolean } | null>(null);
  const [singleAsset, setSingleAsset] = useState<GalleryAsset | null>(null);

  // Upload (source-writing, policy-gated): the modal is offered when any library
  // accepts uploads. A notice confirms the batch after the modal closes.
  const [uploadOpen, setUploadOpen] = useState(false);

  // Where a rendered slideshow movie is saved — an admin-only setting reached
  // from the toolbar rather than a standing dropdown on the list page.
  const [movieLibraryOpen, setMovieLibraryOpen] = useState(false);

  // Multi-select for bulk delete (mirrors the audiobook/ebook Select mode). Tiles
  // toggle selection instead of opening; the bulk bar acts on the chosen assets.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkCollectionOpen, setBulkCollectionOpen] = useState(false);
  const [bulkDateOpen, setBulkDateOpen] = useState(false);
  const [bulkLocationOpen, setBulkLocationOpen] = useState(false);
  // Share is opened over an explicit id set — the bulk bar passes the current
  // selection, a day/year header passes just that group. null = closed.
  const [shareIds, setShareIds] = useState<string[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");

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

  // Folder-name search results, replacing the folder browse while a term is typed.
  // null = not searching; the browse state underneath is left alone, so clearing
  // the box lands back exactly where you were.
  const [folderQuery, setFolderQuery] = useState("");
  const [folderMatches, setFolderMatches] = useState<{ folders: GalleryFolder[]; total: number } | null>(null);

  // Debounce the search box into the query that hits the API — but only where the
  // box means "search the photos". In the Folders view the SAME box searches folder
  // names instead (folderQuery above) — typing there used to yank the page into the
  // Timeline and search the photos, which answered a question nobody standing in a
  // folder tree was asking. On the list views the box is a name filter applied in
  // memory (see nameTerm below), and letting it reach `query` would refetch that
  // list on every keystroke, since query is a dependency of the view loader.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(view === "timeline" ? searchText.trim() : "");
      setFolderQuery(view === "folder" ? searchText.trim() : "");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText, view]);

  // FILTERS are still a timeline operation (a folder tree can't show "only videos
  // from 2019" without becoming the timeline), so they pull the user there where
  // the results are visible. Which libraries the view draws from is exempt —
  // Folders is already a per-library concept, so narrowing to a library stays put.
  useEffect(() => {
    const nonLibraryFilters = activeGalleryFilterCount({ ...filters, libraries: [] });
    if (nonLibraryFilters > 0 && view === "folder") goToView("timeline");
  }, [filters, view, goToView]);

  useEffect(() => {
    if (view !== "folder" || !folderQuery) {
      setFolderMatches(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ ...scopeParams(), q: folderQuery } as Record<string, string>);
        const payload = await api<{ folders: GalleryFolder[]; total: number }>(
          `/api/library/gallery/folders/search?${params}`
        );
        if (!cancelled) setFolderMatches(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to search folders");
      }
    })();
    return () => { cancelled = true; };
  }, [view, folderQuery, scopeParams]);

  // The box means something different in each view — photos here, album names
  // there — so a term does not follow you between them. Cleared on every change
  // of view, including back onto the timeline.
  useEffect(() => {
    setSearchText("");
    setQuery("");
  }, [view]);

  const loadTimeline = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      // Which libraries this draws from is already inside `filters.libraries` —
      // the POST body's JSON carries it natively, unlike the GET views below
      // which need scopeParams()'s query-string form.
      const payload = await api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
        method: "POST",
        body: JSON.stringify({ q: query, kinds: filters.kinds, filters, sort, limit: PAGE_SIZE, offset })
      });
      setAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load photos");
    } finally {
      setLoading(false);
    }
  }, [sort, query, filters]);

  // `offset` > 0 is the "Load more" path: keep what is on screen and append the
  // next page (the folder list itself is identical, so it is simply re-set).
  const loadFolder = useCallback(async (nextParent: string, offset = 0) => {
    // The deep link has served its purpose once a folder is being loaded; from here
    // browsing (and any scope change) starts from the root like a normal visit.
    setDeepLinkFolder((current) => (current === null ? current : null));
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ ...scopeParams(), parent: nextParent, limit: "200", offset: String(offset) } as Record<string, string>);
      const payload = await api<{ parent: string; folders: GalleryFolder[]; assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/folders?${params}`
      );
      setFolders(payload.folders);
      setFolderAssets((current) => (offset > 0 ? [...current, ...payload.assets] : payload.assets));
      setFolderTotal(payload.total);
      setParent(payload.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load folder");
    } finally {
      setLoading(false);
    }
  }, [scopeParams]);

  // Admin: rescan just the folder currently open (a single library must be in
  // scope — a folder path can exist under several libraries otherwise). The scan
  // runs on the server; progress shows on Control panel → Overview → Tasks.
  const [folderRescanBusy, setFolderRescanBusy] = useState(false);
  const rescanFolder = useCallback(async () => {
    if (!soleLibraryId || !parent) return;
    setFolderRescanBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/library/gallery-libraries/${soleLibraryId}/rescan`, {
        method: "POST",
        body: JSON.stringify({ folder: parent })
      });
      setNotice(`Rescanning "${parent}" — new, changed, and removed files there update shortly. Follow progress under Control panel → Overview → Tasks.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the folder rescan");
    } finally {
      setFolderRescanBusy(false);
    }
  }, [soleLibraryId, parent]);

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

  const canCuratePeople = libraries.some((library) => library.canWrite);

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

  // Suggested memories (event/trip clusters). Loaded on mount too, so the Memories
  // tab can appear even when there are no "On this day" anniversaries today.
  const loadMemorySuggestions = useCallback(async () => {
    const params = new URLSearchParams({ ...scopeParams(), limit: "8" } as Record<string, string>);
    try {
      const payload = await api<{ suggestions: GalleryMemorySuggestion[] }>(`/api/library/gallery/memories/suggestions?${params}`);
      setMemorySuggestions(payload.suggestions);
    } catch { /* advisory; the section just stays empty */ }
  }, [scopeParams]);

  useEffect(() => { void loadMemorySuggestions(); }, [loadMemorySuggestions]);

  // Open a suggestion for preview: show its photos and let the user choose an action
  // (create a slideshow, or add the photos to an existing/new one). Nothing persists
  // until they pick one.
  const openSuggestionPreview = useCallback(async (suggestion: GalleryMemorySuggestion) => {
    setPreviewSuggestion(suggestion);
    setPreviewAssets(null);
    try {
      const payload = await api<{ assets: GalleryAsset[] }>("/api/library/gallery/assets/lookup", {
        method: "POST",
        body: JSON.stringify({ itemIds: suggestion.itemIds })
      });
      setPreviewAssets(payload.assets);
    } catch {
      setPreviewAssets([]); // grid stays empty; the actions still work
    }
  }, []);

  // Turn a suggested memory into a real slideshow (sourceKind=memory) and jump into
  // its editor, pre-filled with the montage. From there the user customizes/plays it.
  const createFromMemory = useCallback(async (suggestion: GalleryMemorySuggestion) => {
    setError("");
    try {
      const { slideshow } = await api<{ slideshow: GallerySlideshow }>("/api/library/gallery/slideshows", {
        method: "POST",
        body: JSON.stringify({ name: suggestion.title, itemIds: suggestion.itemIds, sourceKind: "memory", sourceRef: suggestion.id })
      });
      setSlideshowAssets([]);
      setSlideshowTotal(0);
      goToView("slideshows");
      await openSlideshow(slideshow.id);
      setNotice(`Created slideshow “${slideshow.name}” from a memory.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the slideshow");
    }
  }, [openSlideshow, goToView]);

  // The Memories lightbox runs over ALL years flattened (newest year first,
  // chronological within a year), so Next flows from one year into the next.
  const memoryItems = useMemo(() => memories?.groups.flatMap((group) => group.items) ?? [], [memories]);

  // A strip card opens the Memories view anchored at its year.
  // A strip card opens the viewer directly at that year's first photo (same as
  // the home page) — the full memory set is already loaded, no view switch.
  const openMemoryYear = useCallback((year: number) => {
    const groups = memories?.groups ?? [];
    let start = 0;
    for (const group of groups) {
      if (group.year === year) break;
      start += group.items.length;
    }
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    if (total === 0) return;
    setLightbox({ source: "memory", index: Math.min(start, total - 1) });
  }, [memories]);

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
      const target = pendingFolderRef.current ?? deepLinkFolder ?? "";
      pendingFolderRef.current = null;
      void loadFolder(target);
    }
    else if (view === "people") { setSelectedPerson(null); void loadPeople(); void loadFaceSettings(); }
    else if (view === "albums") { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); }
    else if (view === "slideshows") { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); void loadSlideshowSettings(); }
    else if (view === "map") void loadMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sort, query, filters]);

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

  // Mobile "Browse" (views) dropdown open/close + outside-click dismissal.
  const toggleViewMenu = () => {
    setViewMenuOpen((open) => {
      if (!open && viewMenuTriggerRef.current) {
        const rect = viewMenuTriggerRef.current.getBoundingClientRect();
        const alignRight = rect.left + 200 > window.innerWidth;
        setViewMenuPos({
          top: rect.bottom + 8,
          left: alignRight ? null : rect.left,
          right: alignRight ? window.innerWidth - rect.right : null
        });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!viewMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (viewMenuTriggerRef.current?.contains(target)) return;
      if (viewMenuRef.current?.contains(target)) return;
      setViewMenuOpen(false);
    };
    const dismiss = () => setViewMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [viewMenuOpen]);

  // Opening a different album (or closing) drops the cover picker, the folder
  // browser, and any selection carried over from the previous album.
  useEffect(() => {
    setCoverPickerOpen(false);
    setShareAlbumOpen(false);
    setAlbumBrowseOpen(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [selectedAlbum?.id]);

  const activeAssets = lightbox?.source === "single" && singleAsset
    ? [singleAsset]
    : lightbox?.source === "folder" ? folderAssets
      : lightbox?.source === "person" ? personAssets
        : lightbox?.source === "memory" ? memoryItems
          : lightbox?.source === "album" ? albumAssets
            : lightbox?.source === "slideshow" ? slideshowAssets : assets;

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);
  const currentLibrary = lightbox != null && activeAssets[lightbox.index]
    ? libraryFor(activeAssets[lightbox.index].libraryId)
    : undefined;
  const canDeleteCurrent = currentLibrary?.canDelete ?? false;
  const canEditCurrent = currentLibrary?.canWrite ?? false;
  const canShareCurrent = currentLibrary?.canCurate ?? false;

  const uploadLibraries = libraries.filter((library) => library.canUpload);

  // Reload whichever view is active plus the library list (counts / scan badges).
  const refreshView = useCallback(() => {
    if (view === "timeline") void loadTimeline(0);
    else if (view === "folder") void loadFolder(parent);
    else if (view === "people") { void loadPeople(); if (selectedPerson) void openPerson(selectedPerson); }
    else if (view === "albums") { if (selectedAlbum) void openAlbum(selectedAlbum.id); else void loadAlbums(); }
    else if (view === "slideshows") { if (selectedSlideshow) void openSlideshow(selectedSlideshow.id); else void loadSlideshows(); }
    else if (view === "memories") void loadMemories();
    else if (view === "map") void loadMap();
    void loadLibraries();
  }, [view, parent, selectedPerson, selectedAlbum, selectedSlideshow, loadTimeline, loadFolder, loadPeople, openPerson, openAlbum, loadAlbums, openSlideshow, loadSlideshows, loadMemories, loadMap, loadLibraries]);

  // Assets currently shown (the selectable set depends on the active view).
  const displayedAssets = view === "timeline" ? assets : view === "memories" ? memoryItems : view === "albums" ? albumAssets : folderAssets;

  // The linear set a slideshow plays, mapped from the active view. Null on the
  // index screens (library/album/people lists, map) where there's no single photo
  // stream to run through. Mirrors the lightbox's `source` → array mapping.
  const slideshow = view === "timeline" ? { source: "timeline" as const, list: assets }
    : view === "memories" ? { source: "memory" as const, list: memoryItems }
      : view === "folder" ? { source: "folder" as const, list: folderAssets }
        : view === "albums" && selectedAlbum ? { source: "album" as const, list: albumAssets }
          : view === "slideshows" && selectedSlideshow ? { source: "slideshow" as const, list: slideshowAssets }
            : view === "people" && selectedPerson ? { source: "person" as const, list: personAssets }
              : null;

  // Open the lightbox at the first item and auto-play through the current set.
  const startSlideshow = () => {
    if (!slideshow || slideshow.list.length === 0) return;
    setNotice("");
    setLightbox({ source: slideshow.source, index: 0, autoPlay: true });
  };

  // Context-aware "back" shown above every sub-view. Inside a detail level (one
  // album's photos, one person's photos, a folder below the root) it steps up to
  // that parent list; from a list root / Memories / Map it returns to the Timeline.
  const backTarget: { label: string; onClick: () => void } | null =
    view === "albums" && selectedAlbum
      ? { label: "Back to albums", onClick: () => { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); } }
      : view === "slideshows" && selectedSlideshow
        ? { label: "Back to slideshows", onClick: () => { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); } }
      : view === "people" && selectedPerson
        ? { label: "Back to people", onClick: () => { setSelectedPerson(null); setRenameValue(null); setMergeOpen(false); void loadPeople(); } }
        : view === "folder" && parent
          ? { label: "Back to folders", onClick: () => void loadFolder("") }
          : view !== "timeline"
            ? { label: "Back to gallery", onClick: () => goToView("timeline") }
            : null;
  const canDeleteAny = libraries.some((library) => library.canDelete);
  // Stamping a date/location is a metadata write; the server re-checks per item's
  // library and skips the ones the user can't write.
  const canWriteAny = libraries.some((library) => library.canWrite);
  // Sharing hands out file access, so the bar's Share needs the curate
  // capability somewhere; the server filters the selection per library anyway.
  const canShareAny = libraries.some((library) => library.canCurate);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Toggle one photo in the "move these to someone else" picker on a person.
  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkError("");
  };

  // Changing the dataset (view / scope / search / filters) clears any selection so
  // a stale id from a no-longer-visible asset can't linger. Sorting only reorders
  // the same assets, so it keeps the selection.
  useEffect(() => { setSelectionMode(false); setSelectedIds(new Set()); }, [view, query, filters]);

  // Close the folder browser / movie-delete confirm when leaving a slideshow, so neither
  // reappears over the next one (a refresh keeps selectedSlideshow truthy, so the browser
  // stays open through adds).
  useEffect(() => { if (!selectedSlideshow) { setBrowseOpen(false); setSlideshowCoverPickerOpen(false); setMovieDeleteOpen(false); } }, [selectedSlideshow]);

  // Bulk favorite: one request for the whole selection. Items in libraries the
  // user can't favorite (shouldn't happen from this UI) come back as skipped.
  const bulkFavorite = async () => {
    setBulkBusy(true);
    setBulkError("");
    try {
      const result = await api<{ saved: number; forbidden: number }>(
        "/api/library/books/bulk-save",
        { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
      );
      exitSelection();
      const parts = [`Added ${result.saved} item${result.saved === 1 ? "" : "s"} to Favorites`];
      if (result.forbidden > 0) parts.push(`${result.forbidden} skipped`);
      setNotice(`${parts.join(" · ")}.`);
      refreshView();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Unable to add the items to Favorites");
    } finally {
      setBulkBusy(false);
    }
  };

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
    goToView("folder");
  };

  // Group timeline assets into calendar-day buckets for the date headers, keyed on
  // whichever date the timeline is sorted by so the buckets stay consecutive.
  // Skipped entirely in one-continuous-grid mode: that view renders `assets`
  // straight through, so there is nothing to bucket.
  const days = useMemo(() => {
    const out: { label: string; items: { asset: GalleryAsset; index: number }[] }[] = [];
    if (viewPrefs.grouping === "none") return out;
    assets.forEach((asset, index) => {
      const label = dayLabel(sort === "added" ? asset.addedAt : asset.takenAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ asset, index });
      else out.push({ label, items: [{ asset, index }] });
    });
    return out;
  }, [assets, sort, viewPrefs.grouping]);

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
  // Folder counts: what sits directly here, and — when there are subfolders — the
  // whole subtree, so the number matches what the folder's tile advertised.
  const folderSubtreeTotal = folderTotal + folders.reduce((sum, folder) => sum + folder.assetCount, 0);
  const folderCountLabel = `${formatCount(folderTotal)} ${folderTotal === 1 ? "item" : "items"}`;
  const folderSubtitle = loading && folders.length === 0 && folderTotal === 0
    ? "Browsing by folder"
    : folders.length === 0
      ? folderCountLabel
      // Loose files at this level are worth calling out separately; with none (the
      // usual shape of a library root) the subtree count alone reads better.
      : folderTotal === 0
        ? `${formatCount(folderSubtreeTotal)} ${folderSubtreeTotal === 1 ? "item" : "items"} in ${formatCount(folders.length)} ${folders.length === 1 ? "folder" : "folders"}`
        : `${folderCountLabel} here · ${formatCount(folderSubtreeTotal)} with subfolders`;
  const memoriesTotal = memories?.groups.reduce((sum, group) => sum + group.count, 0) ?? 0;

  // The name filter the list views run on the box. Kept apart from `query` — the
  // debounced term the timeline sends to the server — because these lists are
  // already in memory and filter as you type.
  const nameTerm = searchText.trim().toLowerCase();
  const shownAlbums = nameTerm ? albums.filter((album) => album.name.toLowerCase().includes(nameTerm)) : albums;
  const shownSlideshows = nameTerm ? slideshows.filter((show) => show.name.toLowerCase().includes(nameTerm)) : slideshows;
  // An unnamed cluster has name "", so searching by name drops them — which is
  // the point: you are looking for someone you have named.
  const shownPeople = nameTerm ? people.filter((person) => person.name.toLowerCase().includes(nameTerm)) : people;

  const subtitle = view === "map"
    ? `${formatCount(mapPoints.length)} on the map`
    : view === "people"
      // An open person shows its own count under its cover title too — see
      // the album/slideshow cases below.
      ? (selectedPerson ? undefined : `${formatCount(shownPeople.length)} ${shownPeople.length === 1 ? "person" : "people"}`)
      : view === "memories"
        ? `${formatCount(memoriesTotal)} ${memoriesTotal === 1 ? "photo" : "photos"} from past years`
        : view === "albums"
          // An open album shows its own count under its cover title too — see
          // the slideshow case below.
          ? (selectedAlbum ? undefined : `${formatCount(shownAlbums.length)} ${shownAlbums.length === 1 ? "album" : "albums"}`)
          : view === "slideshows"
            // An open slideshow shows its own count under its cover title — the
            // page-level subtitle would just be saying it a second time.
            ? (selectedSlideshow ? undefined : `${formatCount(shownSlideshows.length)} ${shownSlideshows.length === 1 ? "slideshow" : "slideshows"}`)
          : view === "timeline"
            ? `${formatCount(total)} ${total === 1 ? "item" : "items"}`
            : folderSubtitle;

  // Ordinary links to ordinary addresses. Memories and Map only appear when there
  // is something behind them — no memories on file, nothing geotagged in scope —
  // which is why they are the two conditional entries.
  const galleryNavItems: SectionNavItem[] = [
    { key: "timeline", label: "Timeline", href: galleryHref("timeline"), icon: CalendarDays },
    ...((memories?.groups.length ?? 0) > 0
      ? [{ key: "memories", label: "Memories", href: galleryHref("memories"), icon: Sparkles }]
      : []),
    { key: "albums", label: "Albums", href: galleryHref("albums"), icon: Album },
    { key: "slideshows", label: "Slideshows", href: galleryHref("slideshows"), icon: Film },
    { key: "folder", label: "Folders", href: galleryHref("folder"), icon: FolderOpen },
    { key: "people", label: "People", href: galleryHref("people"), icon: Users },
    ...(mapCount > 0
      ? [{ key: "map", label: "Map", href: galleryHref("map"), icon: MapPin }]
      : [])
  ];

  // The phone's stand-in for the left nav, in the header row beside the search
  // box. It rides the header rather than the toolbar because the toolbar is not
  // on every view — People has none at all, and an open album or slideshow trades
  // it for a compact topbar — which used to leave those views with no way to
  // reach the others. Every view that draws browse chrome now draws this too.
  const browseMenu = isMobile ? (
    <div className="audiobook-library-shortcuts gallery-browse-shortcut">
      <button
        ref={viewMenuTriggerRef}
        type="button"
        className="audiobook-library-tab"
        onClick={toggleViewMenu}
        aria-haspopup="menu"
        aria-expanded={viewMenuOpen}
        aria-label="Browse gallery views"
      >
        <Compass size={19} aria-hidden="true" />
        <span>Browse</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {viewMenuOpen && viewMenuPos && createPortal(
        <div
          ref={viewMenuRef}
          className="book-detail-action-menu audiobook-library-menu"
          role="menu"
          aria-label="Browse"
          style={{ position: "fixed", top: viewMenuPos.top, left: viewMenuPos.left ?? undefined, right: viewMenuPos.right ?? undefined }}
        >
          {/* The phone's version of the left nav, off the same list, so a view
              added there appears here too. */}
          {galleryNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={view === item.key ? "active" : ""}
                onClick={() => { setViewMenuOpen(false); navigate(item.href); }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  ) : null;

  // The one Create this view offers, in the header's primary slot — the same
  // place "New series" and "New narrator" sit. Only the list levels have one:
  // inside an open album or slideshow the page is about that one thing.
  const primaryAction = view === "albums" && !selectedAlbum ? (
    <Button variant="primary" onClick={() => setAlbumCreateOpen(true)}>
      <Plus size={16} aria-hidden="true" />
      <span>New album</span>
    </Button>
  ) : view === "slideshows" && !selectedSlideshow ? (
    <Button variant="primary" onClick={() => setSlideshowCreateOpen(true)}>
      <Plus size={16} aria-hidden="true" />
      <span>New slideshow</span>
    </Button>
  ) : null;

  return (
    <DashboardShell
      active="gallery"
      user={user}
      logout={logout}
      sideNav={<SectionNav ariaLabel="Gallery" groupLabel="Gallery" items={galleryNavItems} activeKey={view} />}
    >
      <section className={`audiobook-main-page gallery-page${selectionMode ? " is-selecting" : ""}`}>
        {showBrowseChrome && (
        <LibraryPageHeader
          title={VIEW_TITLES[view]}
          subtitle={subtitle}
          nav={browseMenu}
          search={searchText}
          onSearchChange={hasSearch ? setSearchText : undefined}
          searchPlaceholder={searchPlaceholder}
          // Every control lives in the toolbar below, Upload and the view's own
          // Create included: the header is the page's name, its search box, and
          // (on a phone) the Browse menu that stands in for the left nav.
        />
        )}

        {error && <MessageBox tone="error" title="Gallery error">{error}</MessageBox>}
        {notice && <MessageBox tone="success" title="Gallery updated">{notice}</MessageBox>}
        {/* Favorite/collection failures surface here — the delete flow shows its
            own error inside the confirm dialog. */}
        {bulkError && !bulkDeleteOpen && <MessageBox tone="error" title="Unable to update">{bulkError}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <ImageIcon size={58} aria-hidden="true" />
            <h2>No gallery libraries yet</h2>
            {isAdmin ? (
              <>
                <p className="muted">
                  Create a library and point it at the folder holding your photos and videos — the scanner takes it from there.
                </p>
                <a
                  className="primary-button"
                  href="/control/libraries"
                  onClick={(event) => followRoute(event, "/control/libraries")}
                >
                  <LibraryBig size={16} aria-hidden="true" />
                  Create a library
                </a>
              </>
            ) : (
              <p className="muted">An administrator can add a gallery library from the control panel.</p>
            )}
          </div>
        ) : (
          <>
            {/* An open album still needs this for one thing: the pinned bulk-
                action bar a live selection swaps in. Otherwise it steps aside
                for the compact icon topbar below. */}
            {(showToolbar || selectionMode) && (
            <LibraryPageToolbar
              // Scope says where you are — back out of a sub-view. Which library
              // the view draws from is a filter now, like every other way of
              // narrowing it (see the Libraries facet below): no standalone
              // picker to keep in step with it.
              scope={
                backTarget && (
                  <button type="button" className="library-toolbar-button" onClick={backTarget.onClick}>
                    <ArrowLeft size={18} aria-hidden="true" />
                    <span className="toolbar-label">{backTarget.label}</span>
                  </button>
                )
              }
              // Filter and sort describe a set of photos — the people, camera,
              // year and place a shot was taken, and the order to show them in.
              // Only the two views that ARE a set of photos can answer that, so
              // the other five don't offer controls that would sit there doing
              // nothing.
              tools={
                <>
                  {browsingPhotos && (
                    <>
                      <GalleryFilterButton facets={facets} value={filters} onChange={setFilters} libraries={libraries} />
                      <SortMenu
                        value={sort}
                        onChange={setSort}
                        options={SORT_OPTIONS}
                        ariaLabel="Sort timeline"
                        presentation="labelled"
                      />
                      {/* One menu, two settings — how big the tiles are, and (on
                          the timeline) whether they come in dated sections. Both
                          are visible on screen already, so the trigger says
                          "View" rather than printing back what you can see.
                          Folders has no dates to group by, so it gets the size
                          section alone. */}
                      <SortMenu
                        ariaLabel="View"
                        label="View"
                        presentation="labelled"
                        icon={<LayoutGrid size={18} aria-hidden="true" />}
                        groups={[
                          {
                            heading: "Tile size",
                            value: viewPrefs.tileSize,
                            options: TILE_SIZE_OPTIONS,
                            onChange: (value) => setViewPrefs((prefs) => ({ ...prefs, tileSize: value as GalleryTileSize }))
                          },
                          ...(view === "timeline" ? [{
                            heading: "Dates",
                            value: viewPrefs.grouping,
                            options: GROUPING_OPTIONS,
                            onChange: (value: string) => setViewPrefs((prefs) => ({ ...prefs, grouping: value as GalleryGrouping }))
                          }] : [])
                        ]}
                      />
                    </>
                  )}
                  {/* Memories and Map have nothing to narrow but which libraries
                      they draw from — Filter renders just that one section,
                      and only once there's more than one library to choose
                      between (GalleryFilterButton hides it otherwise, which
                      would leave the button with nothing behind it). People
                      has no toolbar at all (see showToolbar). */}
                  {(view === "memories" || view === "map") && libraries.length > 1 && (
                    <GalleryFilterButton facets={null} value={filters} onChange={setFilters} fields={["libraries"]} libraries={libraries} />
                  )}
                  {/* Where a rendered movie is saved is otherwise invisible, so
                      the label carries it — same reasoning as Sort showing the
                      order it's in. Admin-only, and only once there's somewhere
                      to save one. */}
                  {view === "slideshows" && !selectedSlideshow && isAdmin && slideshowSettings && slideshowSettings.libraries.length > 0 && (
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setMovieLibraryOpen(true)}
                    >
                      <LibraryBig size={18} aria-hidden="true" />
                      <span className="toolbar-label">
                        {(slideshowSettings.renderLibraryId && slideshowSettings.libraries.find((lib) => lib.id === slideshowSettings.renderLibraryId)?.name) || "Movie library"}
                      </span>
                    </button>
                  )}
                  {/* Nothing narrows the other list views, so there is nothing to
                      divide the acting controls from. */}
                  {browsingPhotos && <span className="library-toolbar-divider" aria-hidden="true" />}
                  {/* Selection is not delete-gated: favouriting and adding to a
                      collection are for every member. Delete inside it still is. */}
                  {/* Desktop only, as on the book pages: bulk editing from a phone
                      is a row of eleven verbs on a 375px screen. */}
                  {!isMobile && view !== "map" && view !== "people" && view !== "albums" && view !== "slideshows" && (
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => { setNotice(""); setSelectionMode(true); }}
                    >
                      <SquareCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">Select</span>
                    </button>
                  )}
                  {uploadLibraries.length > 0 && (
                    <button
                      type="button"
                      // The view's own Create outranks it when there is one, so
                      // only one control in the row is filled.
                      className={`library-toolbar-button${primaryAction ? "" : " primary"}`}
                      onClick={() => { setNotice(""); setUploadOpen(true); }}
                    >
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">Upload</span>
                    </button>
                  )}
                  {primaryAction}
                </>
              }
              selection={selectionMode ? {
                count: selectedIds.size,
                actions: (
                  <>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setSelectedIds(new Set(displayedAssets.map((asset) => asset.id)))}
                      disabled={displayedAssets.length === 0}
                      title="Select everything loaded so far"
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">All</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => void bulkFavorite()}
                      disabled={selectedIds.size === 0 || bulkBusy}
                      title={bulkBusy ? "Adding…" : "Add to Favorites"}
                    >
                      <Heart size={18} aria-hidden="true" />
                      <span className="toolbar-label">Favorite</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => { setBulkError(""); setBulkAlbumOpen(true); }}
                      disabled={selectedIds.size === 0 || bulkBusy}
                      title="Add to album"
                    >
                      <ImagePlus size={18} aria-hidden="true" />
                      <span className="toolbar-label">Album</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => { setBulkError(""); setBulkSlideshowOpen(true); }}
                      disabled={selectedIds.size === 0 || bulkBusy}
                      title="Add to slideshow"
                    >
                      <Film size={18} aria-hidden="true" />
                      <span className="toolbar-label">Slideshow</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => { setBulkError(""); setBulkCollectionOpen(true); }}
                      disabled={selectedIds.size === 0 || bulkBusy}
                      title="Add to collection"
                    >
                      <ListMusic size={18} aria-hidden="true" />
                      <span className="toolbar-label">Collection</span>
                    </button>
                    {canShareAny && (
                      <button
                        type="button"
                        className="library-toolbar-button"
                        onClick={() => { setBulkError(""); setShareIds([...selectedIds]); }}
                        disabled={selectedIds.size === 0 || bulkBusy}
                        title="Share"
                      >
                        <Share2 size={18} aria-hidden="true" />
                        <span className="toolbar-label">Share</span>
                      </button>
                    )}
                    {canWriteAny && (
                      <button
                        type="button"
                        className="library-toolbar-button"
                        onClick={() => { setBulkError(""); setBulkDateOpen(true); }}
                        disabled={selectedIds.size === 0 || bulkBusy}
                        title="Set date taken"
                      >
                        <CalendarClock size={18} aria-hidden="true" />
                        <span className="toolbar-label">Date</span>
                      </button>
                    )}
                    {canWriteAny && (
                      <button
                        type="button"
                        className="library-toolbar-button"
                        onClick={() => { setBulkError(""); setBulkLocationOpen(true); }}
                        disabled={selectedIds.size === 0 || bulkBusy}
                        title="Set location"
                      >
                        <MapPinned size={18} aria-hidden="true" />
                        <span className="toolbar-label">Place</span>
                      </button>
                    )}
                    {canDeleteAny && (
                      <button
                        type="button"
                        className="library-toolbar-button danger"
                        onClick={() => { setBulkError(""); setBulkDeleteOpen(true); }}
                        disabled={selectedIds.size === 0 || bulkBusy}
                        title="Move the selected photos to the Recycle Bin"
                      >
                        <Trash2 size={18} aria-hidden="true" />
                        <span className="toolbar-label">Delete</span>
                      </button>
                    )}
                    <span className="library-toolbar-divider" aria-hidden="true" />
                    <button type="button" className="library-toolbar-button" onClick={exitSelection} title="Leave selection">
                      <X size={18} aria-hidden="true" />
                      <span className="toolbar-label">Done</span>
                    </button>
                  </>
                )
              } : null}
            />
            )}

            {view === "timeline" && <GalleryFilterChips value={filters} onChange={setFilters} libraries={libraries} />}

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">Thumbnails appear as the scan finishes.</MessageBox>
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
              selectedPerson ? (() => {
                const personCoverUrl = people.find((p) => p.id === selectedPerson.id)?.coverUrl ?? null;
                return (
                <>
                  {/* Same idea as the album/slideshow detail's topbar: Back
                      plus every action this person offers, icon-only. */}
                  <div className="slideshow-detail-topbar">
                    <Button
                      variant="icon"
                      title="Back to people"
                      aria-label="Back to people"
                      onClick={() => { setSelectedPerson(null); setRenameValue(null); setMergeOpen(false); void loadPeople(); }}
                    >
                      <ArrowLeft size={18} aria-hidden="true" />
                    </Button>
                    {canCuratePeople && (
                      <>
                        <span className="library-toolbar-divider" aria-hidden="true" />
                        {people.length > 1 && (
                          <Button variant="icon" title="Merge all" aria-label="Merge all" onClick={() => setMergeOpen((v) => !v)}>
                            <Combine size={18} aria-hidden="true" />
                          </Button>
                        )}
                        <Button
                          variant="icon"
                          title={personPick ? "Cancel selection" : "Pick photos"}
                          aria-label={personPick ? "Cancel selection" : "Pick photos"}
                          onClick={() => { setPersonPick(personPick ? null : new Set()); setMoveNewName(null); setMergeOpen(false); }}
                        >
                          <SquareCheck size={18} aria-hidden="true" />
                        </Button>
                        {personAssets.length > 0 && (
                          <Button variant="icon" title="Set cover photo" aria-label="Set cover photo" onClick={() => { setNotice(""); setPersonCoverPickerOpen(true); }}>
                            <ImageIcon size={18} aria-hidden="true" />
                          </Button>
                        )}
                        <Button variant="icon" danger title="Delete" aria-label="Delete" onClick={() => setPersonDeleteOpen(true)}>
                          <Trash2 size={18} aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>

                  <div className="gallery-album-header">
                    <span className="gallery-person-avatar">
                      <PersonAvatar url={personCoverUrl} />
                    </span>
                    <div className="gallery-album-heading">
                      {renameValue == null ? (
                        <div className="gallery-title-row">
                          <h2 className={selectedPerson.name ? undefined : "gallery-person-unnamed"}>{selectedPerson.name || "Unnamed"}</h2>
                          {canCuratePeople && (
                            <Button
                              variant="icon"
                              title={selectedPerson.name ? "Rename" : "Name person"}
                              aria-label={selectedPerson.name ? "Rename" : "Name person"}
                              onClick={() => setRenameValue(selectedPerson.name)}
                            >
                              <Pencil size={18} aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      ) : (
                        <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                          <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Name" autoFocus maxLength={120} />
                          <button type="submit" className="primary-button compact-button" disabled={!renameValue.trim()}>Save</button>
                          <button type="button" className="icon-button" onClick={() => setRenameValue(null)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button>
                        </form>
                      )}
                      <p className="gallery-album-sub">
                        {formatCount(personTotal)} {personTotal === 1 ? "photo" : "photos"}
                      </p>
                    </div>
                  </div>

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

                  {personPick && (
                    <div className="gallery-move-panel">
                      <span className="audiobook-bulk-count">
                        {personPick.size} selected
                      </span>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        onClick={() => setPersonPick(new Set(personAssets.map((asset) => asset.id)))}
                        disabled={personAssets.length === 0 || movingPhotos}
                      >
                        Select all loaded
                      </button>
                      {moveNewName == null ? (
                        <label className="gallery-move-target">
                          <span className="sr-only">Move the selected photos to</span>
                          <select
                            value=""
                            disabled={personPick.size === 0 || movingPhotos}
                            onChange={(event) => {
                              const value = event.target.value;
                              if (value === "__new") setMoveNewName("");
                              else if (value) void movePickedPhotos({ intoId: value });
                            }}
                          >
                            <option value="" disabled>{movingPhotos ? "Moving…" : "Move to…"}</option>
                            {people.filter((p) => p.id !== selectedPerson.id).map((p) => (
                              <option key={p.id} value={p.id}>{(p.name || "Unnamed")} ({p.faceCount})</option>
                            ))}
                            <option value="__new">New person…</option>
                          </select>
                        </label>
                      ) : (
                        <form
                          className="gallery-person-rename"
                          onSubmit={(event) => { event.preventDefault(); void movePickedPhotos({ name: moveNewName.trim() }); }}
                        >
                          <input
                            value={moveNewName}
                            onChange={(event) => setMoveNewName(event.target.value)}
                            placeholder="New person's name"
                            autoFocus
                            maxLength={120}
                          />
                          <button type="submit" className="primary-button compact-button" disabled={!moveNewName.trim() || movingPhotos}>
                            {movingPhotos ? "Moving…" : "Move"}
                          </button>
                          <button type="button" className="icon-button" onClick={() => setMoveNewName(null)} aria-label="Cancel">
                            <X size={14} aria-hidden="true" />
                          </button>
                        </form>
                      )}
                      <span className="muted gallery-move-hint">
                        Photos of someone else? Move them instead of removing — the correction survives the next scan.
                      </span>
                    </div>
                  )}

                  <div className="gallery-grid">
                    {personAssets.map((asset, index) => (
                      <AssetTile
                        key={asset.id}
                        asset={asset}
                        onOpen={() => setLightbox({ source: "person", index })}
                        selectionMode={personPick != null}
                        selected={personPick?.has(asset.id) ?? false}
                        onToggleSelect={() => togglePersonPick(asset.id)}
                        onRemove={canCuratePeople && !personPick ? () => void removeFromPerson(asset.id) : undefined}
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
                );
              })() : (
                <>
                  {(() => {
                    // Keep named people and multi-photo groups up front; tuck unnamed
                    // single-photo groups into a collapsible "Small groups" section so a
                    // long tail of singletons doesn't bury the people that matter.
                    // Off shownPeople, so the search box narrows both sections.
                    const main = shownPeople.filter((p) => p.name || p.faceCount > 1);
                    const small = shownPeople.filter((p) => !p.name && p.faceCount <= 1);
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
                  {!loading && shownPeople.length === 0 && nameTerm && (
                    <div className="empty-state library-empty">
                      <Users size={48} aria-hidden="true" />
                      <h2>No one matches</h2>
                      <p className="muted">Unnamed groups have no name to search — clear the box to see them again.</p>
                    </div>
                  )}
                  {!loading && people.length === 0 && (
                    <div className="empty-state library-empty">
                      <Users size={48} aria-hidden="true" />
                      <h2>No people yet</h2>
                      <p className="muted">
                        {isAdmin && !anyFaceEnabled
                          ? "Turn on face recognition from Control Panel → Libraries to auto-detect people — or open a photo's details to tag someone by hand."
                          : "Open a photo, show its details, and add a person to start grouping by who's in them."}
                      </p>
                    </div>
                  )}
                </>
              )
            ) : view === "albums" ? (
              selectedAlbum ? (() => {
                const albumCoverUrl = albums.find((al) => al.id === selectedAlbum.id)?.coverUrl ?? albumAssets[0]?.coverUrl ?? null;
                return (
                <>
                  {/* Same idea as the slideshow detail's topbar: Back plus every
                      action this album offers, icon-only, replacing the toolbar
                      and page header that step aside while it's open. */}
                  <div className="slideshow-detail-topbar">
                    <Button
                      variant="icon"
                      title="Back to albums"
                      aria-label="Back to albums"
                      onClick={() => { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); }}
                    >
                      <ArrowLeft size={18} aria-hidden="true" />
                    </Button>
                    <span className="library-toolbar-divider" aria-hidden="true" />
                    <Button
                      variant="icon"
                      disabled={albumAssets.length < 2}
                      title={albumAssets.length < 2 ? "Add more photos to play a slideshow" : "Play this album as a slideshow"}
                      aria-label="Play this album as a slideshow"
                      onClick={startSlideshow}
                    >
                      <Play size={18} aria-hidden="true" />
                    </Button>
                    {selectedAlbum.canEdit && (
                      <Button variant="icon" title="Add photos" aria-label="Add photos" onClick={() => setAlbumBrowseOpen(true)}>
                        <FolderPlus size={18} aria-hidden="true" />
                      </Button>
                    )}
                    {selectedAlbum.canEdit && (
                      <Button variant="icon" title="Share" aria-label="Share" onClick={() => setShareAlbumOpen(true)}>
                        <Share2 size={18} aria-hidden="true" />
                      </Button>
                    )}
                    {selectedAlbum.canEdit && (
                      <Button variant="icon" title="Set cover photo" aria-label="Set cover photo" onClick={() => { setNotice(""); setCoverPickerOpen(true); }}>
                        <ImageIcon size={18} aria-hidden="true" />
                      </Button>
                    )}
                    <a
                      className="icon-button"
                      title="Download album"
                      aria-label="Download album"
                      href={`/api/library/gallery/albums/${selectedAlbum.id}/download`}
                      download
                    >
                      <Download size={18} aria-hidden="true" />
                    </a>
                    {selectedAlbum.canEdit && (
                      <Button variant="icon" danger title="Delete" aria-label="Delete album" onClick={() => setAlbumDeleteOpen(true)}>
                        <Trash2 size={18} aria-hidden="true" />
                      </Button>
                    )}
                    {!isMobile && !selectionMode && (
                      <Button variant="icon" title="Select" aria-label="Select photos" onClick={() => { setNotice(""); setSelectionMode(true); }}>
                        <SquareCheck size={18} aria-hidden="true" />
                      </Button>
                    )}
                  </div>

                  <div className="gallery-album-header">
                    <span className="gallery-album-cover">
                      {albumCoverUrl ? <img src={albumCoverUrl} alt="" /> : <Album size={30} aria-hidden="true" />}
                    </span>
                    <div className="gallery-album-heading">
                      {albumRename == null ? (
                        <div className="gallery-title-row">
                          <h2>{selectedAlbum.name}</h2>
                          {selectedAlbum.canEdit && (
                            <Button variant="icon" title="Rename" aria-label="Rename" onClick={() => setAlbumRename(selectedAlbum.name)}>
                              <Pencil size={18} aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      ) : (
                        <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); if (albumRename.trim()) void patchAlbum(selectedAlbum.id, { name: albumRename.trim() }); }}>
                          <input value={albumRename} onChange={(event) => setAlbumRename(event.target.value)} placeholder="Album name" autoFocus maxLength={120} />
                          <button type="submit" className="primary-button compact-button" disabled={!albumRename.trim()}>Save</button>
                          <button type="button" className="icon-button" onClick={() => setAlbumRename(null)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button>
                        </form>
                      )}
                      <p className="gallery-album-sub">
                        {formatCount(albumTotal)} {albumTotal === 1 ? "item" : "items"}
                        {selectedAlbum.description ? <> · {selectedAlbum.description}</> : null}
                      </p>
                    </div>
                  </div>

                  <div className="gallery-grid">
                    {albumAssets.map((asset, index) => (
                      <AssetTile
                        key={asset.id}
                        asset={asset}
                        onOpen={() => setLightbox({ source: "album", index })}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(asset.id)}
                        onToggleSelect={() => toggleSelect(asset.id)}
                        onRemove={selectedAlbum.canEdit && !selectionMode ? () => void removeFromAlbum(selectedAlbum.id, asset.id) : undefined}
                        removeTitle="Remove from this album"
                      />
                    ))}
                  </div>
                  {!loading && albumAssets.length === 0 && (
                    <p className="management-empty">
                      This album is empty. Use “Add photos” above to browse your galleries by folder, or select photos in the Timeline and use “Add to album”.
                    </p>
                  )}
                  {albumAssets.length < albumTotal && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                      <button type="button" className="secondary-button" onClick={() => void openAlbum(selectedAlbum.id, albumAssets.length)} disabled={loading}>
                        {loading ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
                );
              })() : (
                <>
                  {/* New album lives in the page header's primary slot now, with
                      every other page's Create button. */}
                  <div className="gallery-person-toolbar">
                    <span className="muted gallery-face-hint">
                      Albums organize photos across libraries. Anyone can view; only the creator and admins can change one.
                    </span>
                  </div>

                  {shownAlbums.length > 0 && (
                    <div className="gallery-folder-grid">
                      {shownAlbums.map((album) => (
                        <button key={album.id} type="button" className="gallery-folder-tile" onClick={() => { setAlbumAssets([]); setAlbumTotal(0); void openAlbum(album.id); }}>
                          <span className="gallery-folder-thumb">
                            {album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <Album size={28} aria-hidden="true" />}
                          </span>
                          <strong>{album.name}</strong>
                          <small>{album.itemCount.toLocaleString()} {album.itemCount === 1 ? "item" : "items"}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {!loading && albums.length > 0 && shownAlbums.length === 0 && (
                    <div className="empty-state library-empty">
                      <Album size={48} aria-hidden="true" />
                      <h2>No albums match</h2>
                    </div>
                  )}
                  {!loading && albums.length === 0 && (
                    <div className="empty-state library-empty">
                      <Album size={48} aria-hidden="true" />
                      <h2>No albums yet</h2>
                      <p className="muted">
                        Create an album here, or select photos in the Timeline and use “Add to album”.
                      </p>
                    </div>
                  )}
                </>
              )
            ) : view === "slideshows" ? (
              selectedSlideshow ? (() => {
                const cover = slideshows.find((s) => s.id === selectedSlideshow.id)?.coverUrl ?? slideshowAssets[0]?.coverUrl ?? null;
                return (
                  <>
                    {/* The toolbar and page header are gone on an open slideshow
                        (see showBrowseChrome). This compact icon row is what
                        replaces them — Back plus every action, icon-only. */}
                    <div className="slideshow-detail-topbar">
                      <Button
                        variant="icon"
                        title="Back to slideshows"
                        aria-label="Back to slideshows"
                        onClick={() => { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); }}
                      >
                        <ArrowLeft size={18} aria-hidden="true" />
                      </Button>
                      <span className="library-toolbar-divider" aria-hidden="true" />
                      <Button
                        variant="icon"
                        disabled={slideshowAssets.length === 0}
                        title={slideshowAssets.length < 2 ? "Add more photos to play a slideshow" : "Play this slideshow"}
                        aria-label="Play this slideshow"
                        onClick={startSlideshow}
                      >
                        <Play size={18} aria-hidden="true" />
                      </Button>
                      {selectedSlideshow.canEdit && (
                        <Button variant="icon" title="Add photos" aria-label="Add photos" onClick={() => setBrowseOpen(true)}>
                          <FolderPlus size={18} aria-hidden="true" />
                        </Button>
                      )}
                      {selectedSlideshow.canEdit && (
                        <Button variant="icon" title="Set cover photo" aria-label="Set cover photo" onClick={() => { setNotice(""); setSlideshowCoverPickerOpen(true); }}>
                          <ImageIcon size={18} aria-hidden="true" />
                        </Button>
                      )}
                      {selectedSlideshow.canEdit && (
                        <Button variant="icon" danger title="Delete" aria-label="Delete" onClick={() => setSlideshowDeleteOpen(true)}>
                          <Trash2 size={18} aria-hidden="true" />
                        </Button>
                      )}
                    </div>

                    <div className="gallery-album-header">
                      <span className="gallery-album-cover">
                        {cover ? <img src={cover} alt="" /> : <Film size={30} aria-hidden="true" />}
                      </span>
                      <div className="gallery-album-heading">
                        {slideshowRename == null ? (
                          <div className="gallery-title-row">
                            <h2>{selectedSlideshow.name}</h2>
                            {selectedSlideshow.canEdit && (
                              <Button variant="icon" title="Rename" aria-label="Rename" onClick={() => setSlideshowRename(selectedSlideshow.name)}>
                                <Pencil size={18} aria-hidden="true" />
                              </Button>
                            )}
                          </div>
                        ) : (
                          <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); if (slideshowRename.trim()) void patchSlideshow(selectedSlideshow.id, { name: slideshowRename.trim() }); }}>
                            <input value={slideshowRename} onChange={(event) => setSlideshowRename(event.target.value)} placeholder="Slideshow name" autoFocus maxLength={120} />
                            <button type="submit" className="primary-button compact-button" disabled={!slideshowRename.trim()}>Save</button>
                            <button type="button" className="icon-button" onClick={() => setSlideshowRename(null)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button>
                          </form>
                        )}
                        <p className="gallery-album-sub">
                          {formatCount(slideshowTotal)} {slideshowTotal === 1 ? "photo" : "photos"}
                        </p>
                      </div>
                    </div>

                    <GallerySlideshowEditor
                      slideshow={selectedSlideshow}
                      assets={slideshowAssets}
                      total={slideshowTotal}
                      loading={loading}
                      canEdit={selectedSlideshow.canEdit}
                      onOpenAt={(index) => setLightbox({ source: "slideshow", index })}
                      onPlay={startSlideshow}
                      onLoadMore={() => void openSlideshow(selectedSlideshow.id, slideshowAssets.length)}
                      onReorder={(ids) => void reorderSlideshow(selectedSlideshow.id, ids)}
                      onRemove={(id) => void removeFromSlideshow(selectedSlideshow.id, id)}
                      onPatch={(fields) => patchSlideshow(selectedSlideshow.id, fields)}
                      onRender={() => void renderSlideshowMovie(selectedSlideshow.id)}
                      onDeleteMovie={() => setMovieDeleteOpen(true)}
                    />
                  </>
                );
              })() : (
                <>
                  {/* Suggestions are slideshows you don't have yet, so they are
                      not something a search of your own can match — they step
                      aside while the box has a term in it. Ahead of your own
                      slideshows: it's the "make something new" prompt, and a
                      single scrollable row (the fetch itself is capped) keeps
                      it from pushing your actual list below the fold. */}
                  {memorySuggestions.length > 0 && !nameTerm && (
                    <section className="gallery-memory-suggestions" aria-label="Suggested slideshows">
                      <div className="gallery-memory-suggestions-head">
                        <h2>Suggested slideshows</h2>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => { const pick = memorySuggestions[Math.floor(Math.random() * memorySuggestions.length)]; if (pick) void openSuggestionPreview(pick); }}
                        >
                          <Sparkles size={15} aria-hidden="true" /> Surprise me
                        </button>
                      </div>
                      <div className="gallery-suggestion-row">
                        {memorySuggestions.map((memory) => (
                          <button
                            key={memory.id}
                            type="button"
                            className="gallery-folder-tile gallery-memory-tile"
                            onClick={() => void openSuggestionPreview(memory)}
                            title={`Preview “${memory.title}”`}
                          >
                            <span className="gallery-folder-thumb">
                              {memory.coverUrl ? <img src={memory.coverUrl} alt="" loading="lazy" /> : <Sparkles size={28} aria-hidden="true" />}
                              <span className="gallery-memory-play" aria-hidden="true"><Play size={20} /></span>
                            </span>
                            <strong>{memory.title}</strong>
                            <small>{memory.subtitle}</small>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {shownSlideshows.length > 0 && (
                    <>
                      {memorySuggestions.length > 0 && !nameTerm && <h2 className="gallery-memories-title">Your slideshows</h2>}
                      <div className="gallery-folder-grid">
                        {shownSlideshows.map((slideshow) => (
                          <button key={slideshow.id} type="button" className="gallery-folder-tile" onClick={() => { setSlideshowAssets([]); setSlideshowTotal(0); void openSlideshow(slideshow.id); }}>
                            <span className="gallery-folder-thumb">
                              {slideshow.coverUrl ? <img src={slideshow.coverUrl} alt="" loading="lazy" /> : <Film size={28} aria-hidden="true" />}
                              {slideshow.renderStatus === "ready" && <span className="slideshow-card-badge ready" title="Movie ready"><Play size={11} aria-hidden="true" />Movie</span>}
                              {(slideshow.renderStatus === "rendering" || slideshow.renderStatus === "queued") && <span className="slideshow-card-badge busy" title="Rendering a movie">Rendering…</span>}
                            </span>
                            <strong>{slideshow.name}</strong>
                            <small>{slideshow.itemCount.toLocaleString()} {slideshow.itemCount === 1 ? "photo" : "photos"}</small>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {!loading && slideshows.length > 0 && shownSlideshows.length === 0 && (
                    <div className="empty-state library-empty">
                      <Film size={48} aria-hidden="true" />
                      <h2>No slideshows match</h2>
                    </div>
                  )}
                  {!loading && slideshows.length === 0 && memorySuggestions.length === 0 && (
                    <div className="empty-state library-empty">
                      <Film size={48} aria-hidden="true" />
                      <h2>No slideshows yet</h2>
                      <p className="muted">
                        Create a slideshow here, or select photos in the Timeline and use “Add to slideshow”.
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
                    const ids = group.items.map((asset) => asset.id);
                    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
                    return (
                      <section key={group.year} id={`gallery-memories-${group.year}`} className="gallery-memories-year" aria-label={`Memories from ${group.year}`}>
                        <div className="gallery-memories-year-head">
                          <button
                            type="button"
                            className={`gallery-day-select${allSelected ? " selected" : ""}`}
                            onClick={() => toggleDaySelect(ids)}
                            role="checkbox"
                            aria-checked={allSelected}
                            aria-label={`Select all from ${memoryDateLabel(group.precision, group.year)}`}
                            title={allSelected ? "Deselect these photos" : "Select these photos"}
                          >
                            {allSelected ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                          </button>
                          {canShareAny && (
                            <button
                              type="button"
                              className="gallery-day-share"
                              onClick={() => setShareIds(ids)}
                              aria-label={`Share photos from ${memoryDateLabel(group.precision, group.year)}`}
                              title="Share these photos"
                            >
                              Share
                            </button>
                          )}
                          <h2>{memoryDateLabel(group.precision, group.year)}</h2>
                          <small>{yearsAgo(group.year)} · {group.count} {group.count === 1 ? "photo" : "photos"}</small>
                        </div>
                        <div className="gallery-grid">
                          {group.items.map((asset, i) => (
                            <AssetTile
                              key={asset.id}
                              asset={asset}
                              onOpen={() => setLightbox({ source: "memory", index: start + i })}
                              selectionMode={selectionMode}
                              selected={selectedIds.has(asset.id)}
                              onToggleSelect={() => toggleSelect(asset.id)}
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
                  <h2>No memories yet</h2>
                  <p className="muted">
                    Memories resurfaces shots from past years on their anniversary. Add dates to
                    more photos and they'll start appearing here. Looking to turn a trip into a
                    slideshow? Those suggestions now live under Slideshows.
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
                {viewPrefs.grouping === "none" ? (
                  // One uninterrupted grid: no date headers, so the whole run of
                  // photos reads as a single wall. Selection is still available —
                  // through the toolbar's Select rather than a day's checkbox.
                  <div className={gridClass}>
                    {assets.map((asset, index) => (
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
                ) : days.map((day) => {
                  const ids = day.items.map(({ asset }) => asset.id);
                  const allSelected = ids.every((id) => selectedIds.has(id));
                  return (
                    <div key={day.items[0].asset.id}>
                      <div className="gallery-day-head">
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
                        {canShareAny && (
                          <button
                            type="button"
                            className="gallery-day-share"
                            onClick={() => setShareIds(ids)}
                            aria-label={`Share photos from ${day.label}`}
                            title="Share these photos"
                          >
                            Share
                          </button>
                        )}
                        <h2 className="gallery-day-label">{day.label}</h2>
                      </div>
                      <div className={gridClass}>
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
            ) : folderMatches ? (
              /* Folder-NAME search, everywhere in scope. Clicking a result opens the
                 folder and clears the box — the term found its answer. The browse
                 state underneath is untouched, so clearing by hand lands back where
                 you were. */
              <>
                <p className="gallery-section-label">
                  {folderMatches.total === 0
                    ? "No folders match"
                    : `Folders matching “${folderQuery}” (${formatCount(folderMatches.total)}${folderMatches.total > folderMatches.folders.length ? `, first ${formatCount(folderMatches.folders.length)}` : ""})`}
                </p>
                {folderMatches.folders.length > 0 ? (
                  <div className="gallery-folder-grid">
                    {folderMatches.folders.map((folder) => (
                      <button
                        key={folder.path}
                        type="button"
                        className="gallery-folder-tile"
                        title={folder.path}
                        onClick={() => { setSearchText(""); void loadFolder(folder.path); }}
                      >
                        <span className="gallery-folder-thumb">
                          {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                        </span>
                        <strong>{folder.name}</strong>
                        {/* Where it sits — the name alone can't tell 2004's "wedding"
                            from 2019's. Top-level folders have nowhere to say. */}
                        {folder.path.includes("/") && (
                          <small className="gallery-folder-where">{folder.path.slice(0, folder.path.lastIndexOf("/"))}</small>
                        )}
                        <small>{folder.assetCount.toLocaleString()} {folder.assetCount === 1 ? "item" : "items"}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="management-empty">No folder name contains “{folderQuery}”.</p>
                )}
              </>
            ) : (
              <>
                <div className="gallery-folder-bar">
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
                  {isAdmin && soleLibraryId && parent !== "" && (
                    <Button
                      variant="secondary"
                      compact
                      disabled={folderRescanBusy}
                      title="Rescan just this folder (leaves the rest of the library untouched)"
                      onClick={() => void rescanFolder()}
                    >
                      <RefreshCw size={14} aria-hidden="true" /> {folderRescanBusy ? "Starting…" : "Rescan this folder"}
                    </Button>
                  )}
                </div>

                {folders.length > 0 && (
                  <>
                    <p className="gallery-section-label">Folders ({formatCount(folders.length)})</p>
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
                    <p className="gallery-section-label">Photos &amp; videos ({formatCount(folderTotal)})</p>
                    <div className={gridClass}>
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
                    {folderAssets.length < folderTotal && (
                      <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
                        <button type="button" className="secondary-button" onClick={() => void loadFolder(parent, folderAssets.length)} disabled={loading}>
                          {loading ? "Loading…" : "Load more"}
                        </button>
                      </div>
                    )}
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
          autoPlay={lightbox.autoPlay}
          transition={lightbox.source === "slideshow" ? selectedSlideshow?.transition : undefined}
          transitionSeconds={lightbox.source === "slideshow" ? selectedSlideshow?.transitionSeconds : undefined}
          initialInterval={lightbox.source === "slideshow" ? selectedSlideshow?.slideSeconds : undefined}
          musicUrl={lightbox.source === "slideshow" ? selectedSlideshow?.musicUrl ?? undefined : undefined}
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

      {shareIds && (
        <ShareSetModal
          itemIds={shareIds}
          onClose={() => setShareIds(null)}
        />
      )}

      {shareAlbumOpen && selectedAlbum && (
        <ShareAlbumModal
          albumId={selectedAlbum.id}
          albumName={selectedAlbum.name}
          onClose={() => setShareAlbumOpen(false)}
        />
      )}

      {bulkAlbumOpen && (
        <AddToAlbumModal
          itemIds={[...selectedIds]}
          title={`${selectedIds.size} selected ${selectedIds.size === 1 ? "item" : "items"}`}
          onClose={() => setBulkAlbumOpen(false)}
          onAdded={(albumName, added) => {
            setBulkAlbumOpen(false);
            exitSelection();
            setNotice(`Added ${added} item${added === 1 ? "" : "s"} to "${albumName}".`);
          }}
        />
      )}

      {bulkSlideshowOpen && (
        <AddToSlideshowModal
          itemIds={[...selectedIds]}
          title={`${selectedIds.size} selected ${selectedIds.size === 1 ? "item" : "items"}`}
          onClose={() => setBulkSlideshowOpen(false)}
          onAdded={(slideshowName, added) => {
            setBulkSlideshowOpen(false);
            exitSelection();
            setNotice(`Added ${added} photo${added === 1 ? "" : "s"} to "${slideshowName}".`);
          }}
        />
      )}

      {bulkDateOpen && (
        <GalleryDateModal
          itemIds={[...selectedIds]}
          onClose={() => setBulkDateOpen(false)}
          onApplied={(updated, forbidden, noDate) => {
            setBulkDateOpen(false);
            exitSelection();
            const parts = [`Dated ${updated} item${updated === 1 ? "" : "s"}`];
            if (noDate > 0) parts.push(`${noDate} had no date to shift`);
            if (forbidden > 0) parts.push(`${forbidden} skipped (no permission)`);
            setNotice(`${parts.join(" · ")}.`);
            refreshView();
          }}
        />
      )}

      {bulkLocationOpen && (
        <GalleryLocationModal
          itemIds={[...selectedIds]}
          onClose={() => setBulkLocationOpen(false)}
          onApplied={(updated, forbidden) => {
            setBulkLocationOpen(false);
            exitSelection();
            const parts = [`Placed ${updated} item${updated === 1 ? "" : "s"} on the map`];
            if (forbidden > 0) parts.push(`${forbidden} skipped (no permission)`);
            setNotice(`${parts.join(" · ")}.`);
            refreshView();
          }}
        />
      )}

      {/* Suggested-slideshow preview: look at the photos first, then create a slideshow
          from them. Closing without creating = nothing happens. */}
      {previewSuggestion && (
        <Modal
          variant="panel"
          title={previewSuggestion.title}
          icon={<Sparkles size={20} />}
          className="add-to-album-modal"
          onClose={() => setPreviewSuggestion(null)}
        >
          <div className="add-to-album-head suggestion-preview-head">
            <p className="muted">{previewSuggestion.subtitle}</p>
            <div className="suggestion-preview-actions">
              <button
                type="button"
                className="primary-button compact-button"
                onClick={() => { const suggestion = previewSuggestion; setPreviewSuggestion(null); void createFromMemory(suggestion); }}
              >
                <Film size={15} aria-hidden="true" /> Create slideshow
              </button>
            </div>
          </div>
          <div className="modal-tab-content add-to-album-body">
            {previewAssets === null ? (
              <p className="management-empty">Loading photos…</p>
            ) : previewAssets.length === 0 ? (
              <p className="management-empty">None of these photos are available right now.</p>
            ) : (
              <div className="gallery-folder-grid suggestion-preview-grid">
                {previewAssets.map((asset) => (
                  <div key={asset.id} className="gallery-folder-tile suggestion-preview-tile">
                    <span className="gallery-folder-thumb">
                      {asset.coverUrl ? <img src={asset.coverUrl} alt={asset.title} loading="lazy" /> : <ImageIcon size={26} aria-hidden="true" />}
                      {asset.kind === "video" && <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {movieDeleteOpen && selectedSlideshow && (
        <ConfirmDialog
          title="Delete this movie?"
          confirmLabel="Delete movie"
          danger
          busy={movieDeleteBusy}
          onConfirm={() => void deleteSlideshowMovie()}
          onCancel={() => { if (!movieDeleteBusy) setMovieDeleteOpen(false); }}
        >
          This removes the rendered MP4 and any leftover temporary files. You can re-render it anytime.
          {selectedSlideshow.movieSavedToLibrary && " The copy already saved to your gallery is kept."}
        </ConfirmDialog>
      )}

      {browseOpen && selectedSlideshow && (
        <GalleryFolderPicker
          title={`Add photos to “${selectedSlideshow.name}”`}
          endpoint={`/api/library/gallery/slideshows/${selectedSlideshow.id}/items`}
          libraries={libraries}
          existingIds={slideshowAssets.map((asset) => asset.id)}
          onClose={() => setBrowseOpen(false)}
          onAdded={(added) => {
            if (added > 0) {
              setNotice(`Added ${added} photo${added === 1 ? "" : "s"} to "${selectedSlideshow.name}".`);
              void openSlideshow(selectedSlideshow.id);
            }
          }}
        />
      )}

      {albumBrowseOpen && selectedAlbum && (
        <GalleryFolderPicker
          title={`Add photos to “${selectedAlbum.name}”`}
          endpoint={`/api/library/gallery/albums/${selectedAlbum.id}/items`}
          libraries={libraries}
          existingIds={albumAssets.map((asset) => asset.id)}
          onClose={() => setAlbumBrowseOpen(false)}
          onAdded={(added) => {
            if (added > 0) {
              setNotice(`Added ${added} photo${added === 1 ? "" : "s"} to "${selectedAlbum.name}".`);
              void openAlbum(selectedAlbum.id);
            }
          }}
        />
      )}

      {slideshowCreateOpen && (
        <Modal
          variant="card"
          title="Create slideshow"
          onClose={() => { if (!slideshowBusy) setSlideshowCreateOpen(false); }}
        >
          <form onSubmit={(event) => { event.preventDefault(); void createSlideshowSubmit(); }}>
            <label className="field">
              <span>Name</span>
              <input value={slideshowNewName} onChange={(event) => setSlideshowNewName(event.target.value)} placeholder="e.g. Summer 2026" autoFocus maxLength={120} />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setSlideshowCreateOpen(false)} disabled={slideshowBusy}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!slideshowNewName.trim() || slideshowBusy}>
                {slideshowBusy ? "Creating…" : "Create slideshow"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {movieLibraryOpen && slideshowSettings && (
        <Modal
          variant="card"
          title="Save rendered movies to"
          icon={<LibraryBig size={20} />}
          onClose={() => setMovieLibraryOpen(false)}
        >
          <p className="muted">
            When a slideshow is rendered into a movie, it can also be saved into one of your
            gallery libraries so it shows up alongside your photos.
          </p>
          <ChoiceGroup
            legend="Movie library"
            value={slideshowSettings.renderLibraryId ?? ""}
            onChange={(value) => void setRenderLibrary(value)}
            options={[
              { value: "", label: "Don’t save to a library" },
              ...slideshowSettings.libraries.map((lib) => ({ value: lib.id, label: lib.name }))
            ]}
          />
          <div className="modal-actions">
            <button type="button" className="primary-button" onClick={() => setMovieLibraryOpen(false)}>Done</button>
          </div>
        </Modal>
      )}

      {slideshowDeleteOpen && selectedSlideshow && (
        <ConfirmDialog
          title={`Delete "${selectedSlideshow.name}"?`}
          confirmLabel="Delete slideshow"
          danger
          busy={slideshowBusy}
          onConfirm={confirmDeleteSlideshow}
          onCancel={() => { if (!slideshowBusy) setSlideshowDeleteOpen(false); }}
        >
          This removes the slideshow and its order and settings. The photos themselves stay in the gallery.
          {selectedSlideshow.movieSavedToLibrary && " The rendered movie already saved to your gallery is kept."}
        </ConfirmDialog>
      )}

      {albumCreateOpen && (
        <Modal
          variant="card"
          title="Create album"
          onClose={() => { if (!albumBusy) setAlbumCreateOpen(false); }}
        >
          <form onSubmit={(event) => { event.preventDefault(); void createAlbumSubmit(); }}>
            <label className="field">
              <span>Name</span>
              <input value={albumNewName} onChange={(event) => setAlbumNewName(event.target.value)} placeholder="e.g. Summer 2026" autoFocus maxLength={120} />
            </label>
            <label className="field">
              <span>Description (optional)</span>
              <input value={albumNewDesc} onChange={(event) => setAlbumNewDesc(event.target.value)} placeholder="What's in this album?" maxLength={2000} />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setAlbumCreateOpen(false)} disabled={albumBusy}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!albumNewName.trim() || albumBusy}>
                {albumBusy ? "Creating…" : "Create album"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {coverPickerOpen && selectedAlbum && (
        <Modal
          variant="panel"
          title="Set cover photo"
          icon={<ImageIcon size={20} />}
          className="gallery-cover-modal"
          onClose={() => setCoverPickerOpen(false)}
        >
          <div className="modal-tab-content">
            <p className="muted">Choose a photo to use as this album’s cover.</p>
            {albumAssets.length === 0 ? (
              <p className="management-empty">This album has no photos yet.</p>
            ) : (
              <div className="gallery-grid gallery-cover-grid">
                {albumAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className={`gallery-tile${asset.id === selectedAlbum.coverItemId ? " selected" : ""}`}
                    onClick={() => void setAlbumCover(selectedAlbum.id, asset.id)}
                    aria-label={`Use ${asset.title} as the cover`}
                    title={`Use ${asset.title} as the cover`}
                  >
                    {asset.coverUrl ? (
                      <img src={asset.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                    )}
                    {asset.id === selectedAlbum.coverItemId && (
                      <span className="gallery-tile-check" aria-hidden="true"><CheckCircle2 size={22} /></span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {slideshowCoverPickerOpen && selectedSlideshow && (
        <Modal
          variant="panel"
          title="Set cover photo"
          icon={<ImageIcon size={20} />}
          className="gallery-cover-modal"
          onClose={() => setSlideshowCoverPickerOpen(false)}
        >
          <div className="modal-tab-content">
            <p className="muted">Choose a photo to use as this slideshow’s cover.</p>
            {slideshowAssets.length === 0 ? (
              <p className="management-empty">This slideshow has no photos yet.</p>
            ) : (
              <div className="gallery-grid gallery-cover-grid">
                {slideshowAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className={`gallery-tile${asset.id === selectedSlideshow.coverItemId ? " selected" : ""}`}
                    onClick={() => void setSlideshowCover(selectedSlideshow.id, asset.id)}
                    aria-label={`Use ${asset.title} as the cover`}
                    title={`Use ${asset.title} as the cover`}
                  >
                    {asset.coverUrl ? (
                      <img src={asset.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                    )}
                    {asset.id === selectedSlideshow.coverItemId && (
                      <span className="gallery-tile-check" aria-hidden="true"><CheckCircle2 size={22} /></span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {personCoverPickerOpen && selectedPerson && (
        <Modal
          variant="panel"
          title="Set cover photo"
          icon={<ImageIcon size={20} />}
          className="gallery-cover-modal"
          onClose={() => setPersonCoverPickerOpen(false)}
        >
          <div className="modal-tab-content">
            <p className="muted">Choose a photo to use as {selectedPerson.name ? `${selectedPerson.name}’s` : "this person’s"} cover.</p>
            {personAssets.length === 0 ? (
              <p className="management-empty">No photos yet.</p>
            ) : (
              <div className="gallery-grid gallery-cover-grid">
                {personAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className={`gallery-tile${asset.id === selectedPerson.coverItemId ? " selected" : ""}`}
                    onClick={() => void setPersonCover(selectedPerson.id, asset.id)}
                    aria-label={`Use ${asset.title} as the cover`}
                    title={`Use ${asset.title} as the cover`}
                  >
                    {asset.coverUrl ? (
                      <img src={asset.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                    )}
                    {asset.id === selectedPerson.coverItemId && (
                      <span className="gallery-tile-check" aria-hidden="true"><CheckCircle2 size={22} /></span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {albumDeleteOpen && selectedAlbum && (
        <ConfirmDialog
          title={`Delete "${selectedAlbum.name}"?`}
          confirmLabel="Delete album"
          busyLabel="Deleting…"
          busy={albumBusy}
          danger
          onConfirm={() => void confirmDeleteAlbum()}
          onCancel={() => { if (!albumBusy) setAlbumDeleteOpen(false); }}
        >
          This removes the album only. The photos inside stay in the gallery and in any
          other albums or collections.
        </ConfirmDialog>
      )}

      {bulkCollectionOpen && (
        <AddToCollectionModal
          entityType="gallery"
          entityIds={[...selectedIds]}
          title={`${selectedIds.size} selected ${selectedIds.size === 1 ? "item" : "items"}`}
          onClose={() => setBulkCollectionOpen(false)}
          onAdded={(collectionName, added) => {
            setBulkCollectionOpen(false);
            exitSelection();
            setNotice(`Added ${added} item${added === 1 ? "" : "s"} to "${collectionName}".`);
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
