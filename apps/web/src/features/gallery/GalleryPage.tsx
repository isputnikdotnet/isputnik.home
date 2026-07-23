import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Album, ArrowLeft, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Circle, Combine, Download, Film, FolderOpen, Image as ImageIcon, ImagePlus, Images, ListMusic, MapPin, MoreHorizontal, Pencil, Play, Plus, Heart, Folder, RefreshCw, ScanFace, Share2, Sparkles, SquareCheck, Trash2, UploadCloud, Users, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader, AudiobookHeaderSort, formatCount } from "../audiobooks/AudiobooksPage";
import type { SortKey } from "../audiobooks/BookFilter";
import { GalleryLightbox } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryFaceSettingsModal } from "./GalleryFaceSettingsModal";
import { GalleryFilterButton, GalleryFilterChips, EMPTY_GALLERY_FILTERS, activeGalleryFilterCount, type GalleryFilters } from "./GalleryFilter";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { AddToAlbumModal } from "./AddToAlbumModal";
import { AddToSlideshowModal } from "./AddToSlideshowModal";
import { GallerySlideshowEditor } from "./GallerySlideshowEditor";
import { ShareSetModal } from "../share/ShareSetModal";
import { ShareAlbumModal } from "./ShareAlbumModal";
import { Modal } from "../../shared/Modal";
import type { GalleryAlbum, GalleryAlbumDetail, GalleryAsset, GalleryFaceSettings, GalleryFacets, GalleryFolder, GalleryLibrary, GalleryMapPoint, GalleryMemories, GalleryMemorySuggestion, GalleryPerson, GallerySlideshow, GallerySlideshowDetail, SlideshowTransition } from "./types";

const PAGE_SIZE = 80;
// The People grid can hold thousands of clusters; render them a page at a time so a
// wall of avatar thumbnails doesn't flood the cover route (and trip its rate limit).
const PEOPLE_PAGE = 120;

// Leaflet (~140 KB) is only needed for the Map view, so it loads on demand — keeping
// it off the initial bundle for the common Timeline/Folder browsing.
const GalleryMap = lazy(() => import("./GalleryMap").then((m) => ({ default: m.GalleryMap })));

type GalleryView = "timeline" | "folder" | "map" | "people" | "memories" | "albums" | "slideshows";
type TimelineSort = "taken" | "added";

// Timeline sort, presented through the same compact dropdown the audiobooks/ebooks
// header uses, so the controls line up visually. The media-type (photo/video)
// filter lives in the Filter panel with the other facets.
const SORT_OPTIONS = [
  { value: "taken" as const, label: "Date taken" },
  { value: "added" as const, label: "Date uploaded" }
];

// Album sort, shown through the same compact icon dropdown as the timeline sort.
const ALBUM_SORT_OPTIONS = [
  { value: "taken_at" as const, label: "Date taken" },
  { value: "manual" as const, label: "Order added" }
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
  onRemove,
  removeTitle = "Not this person — remove from here"
}: {
  asset: GalleryAsset;
  onOpen: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  // When set (person page / album detail), a corner button detaches this photo
  // from the containing set. removeTitle names what it detaches from.
  onRemove?: () => void;
  removeTitle?: string;
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
        asset.playable === false ? (
          <span className="gallery-video-badge unplayable" title="Can’t play in browser — download to view">
            <Download size={11} aria-hidden="true" />Video
          </span>
        ) : (
          <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
        )
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
        aria-label={`Remove ${asset.title}`}
        title={removeTitle}
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
  const [memorySuggestions, setMemorySuggestions] = useState<GalleryMemorySuggestion[]>([]);
  const [pendingYear, setPendingYear] = useState<number | null>(null);

  // Folder state.
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);

  // Albums state: the card list, and the open album (detail + paged items).
  const [albums, setAlbums] = useState<GalleryAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<GalleryAlbumDetail | null>(null);
  const [albumAssets, setAlbumAssets] = useState<GalleryAsset[]>([]);
  const [albumTotal, setAlbumTotal] = useState(0);
  const [albumCreateOpen, setAlbumCreateOpen] = useState(false);
  const [albumNewName, setAlbumNewName] = useState("");
  const [albumNewDesc, setAlbumNewDesc] = useState("");
  const [albumRename, setAlbumRename] = useState<string | null>(null);
  const [albumDeleteOpen, setAlbumDeleteOpen] = useState(false);
  const [albumBusy, setAlbumBusy] = useState(false);
  // Live "Share album" dialog (guest link + per-user access), for the open album.
  const [shareAlbumOpen, setShareAlbumOpen] = useState(false);
  const [bulkAlbumOpen, setBulkAlbumOpen] = useState(false);
  // Open album's overflow (…) menu, and the "pick a cover" mode where clicking a
  // tile sets it as the album cover instead of opening the lightbox.
  const [albumMenuOpen, setAlbumMenuOpen] = useState(false);
  const [albumMenuPos, setAlbumMenuPos] = useState<{ top: number; left: number } | null>(null);
  const albumMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const albumMenuRef = useRef<HTMLDivElement>(null);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  // Slideshows state: the card list, and the open slideshow (detail + paged items
  // in presentation order). Mirrors albums; the editor lives in a child component.
  const [slideshows, setSlideshows] = useState<GallerySlideshow[]>([]);
  const [selectedSlideshow, setSelectedSlideshow] = useState<GallerySlideshowDetail | null>(null);
  const [slideshowAssets, setSlideshowAssets] = useState<GalleryAsset[]>([]);
  const [slideshowTotal, setSlideshowTotal] = useState(0);
  const [slideshowCreateOpen, setSlideshowCreateOpen] = useState(false);
  const [slideshowNewName, setSlideshowNewName] = useState("");
  const [slideshowRename, setSlideshowRename] = useState<string | null>(null);
  const [slideshowDeleteOpen, setSlideshowDeleteOpen] = useState(false);
  const [slideshowBusy, setSlideshowBusy] = useState(false);
  const [bulkSlideshowOpen, setBulkSlideshowOpen] = useState(false);
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
  const [lightbox, setLightbox] = useState<{ source: "timeline" | "folder" | "single" | "person" | "memory" | "album" | "slideshow"; index: number; autoPlay?: boolean } | null>(null);
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
  const [bulkCollectionOpen, setBulkCollectionOpen] = useState(false);
  // Share is opened over an explicit id set — the bulk bar passes the current
  // selection, a day/year header passes just that group. null = closed.
  const [shareIds, setShareIds] = useState<string[] | null>(null);
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

  // Admin: rescan just the folder currently open (a single library must be in
  // scope — a folder path can exist under several libraries otherwise). The scan
  // runs on the server; progress shows on Control panel → Libraries → Tasks.
  const [folderRescanBusy, setFolderRescanBusy] = useState(false);
  const rescanFolder = useCallback(async () => {
    if (scopeId === "all" || !parent) return;
    setFolderRescanBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/library/gallery-libraries/${scopeId}/rescan`, {
        method: "POST",
        body: JSON.stringify({ folder: parent })
      });
      setNotice(`Rescanning "${parent}" — new, changed, and removed files there update shortly. Follow progress under Control panel → Libraries → Tasks.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the folder rescan");
    } finally {
      setFolderRescanBusy(false);
    }
  }, [scopeId, parent]);

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

  // Albums list + one album's items (paged like the timeline). Albums are
  // global, not scope-filtered — the server already trims items per viewer.
  const loadAlbums = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ albums: GalleryAlbum[] }>("/api/library/gallery/albums");
      setAlbums(payload.albums);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load albums");
    } finally {
      setLoading(false);
    }
  }, []);

  const openAlbum = useCallback(async (albumId: string, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ album: GalleryAlbumDetail; assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/albums/${albumId}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      setSelectedAlbum(payload.album);
      setAlbumAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setAlbumTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the album");
    } finally {
      setLoading(false);
    }
  }, []);

  // Album edits (rename / sort mode / cover). Reloads the header + list so cards
  // stay fresh (loadAlbums refreshes the list-card cover thumbnail after a change).
  const patchAlbum = useCallback(async (albumId: string, fields: { name?: string; sortMode?: "taken_at" | "manual"; coverItemId?: string | null }) => {
    try {
      await api(`/api/library/gallery/albums/${albumId}`, { method: "PATCH", body: JSON.stringify(fields) });
      setAlbumRename(null);
      void openAlbum(albumId);
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the album");
    }
  }, [openAlbum, loadAlbums]);

  // Set the album cover (chosen in the cover-picker popup).
  const setAlbumCover = useCallback(async (albumId: string, itemId: string) => {
    setCoverPickerOpen(false);
    setNotice("");
    await patchAlbum(albumId, { coverItemId: itemId });
    setNotice("Album cover updated.");
  }, [patchAlbum]);

  const removeFromAlbum = useCallback(async (albumId: string, assetId: string) => {
    try {
      await api(`/api/library/gallery/albums/${albumId}/items/remove`, {
        method: "POST",
        body: JSON.stringify({ itemIds: [assetId] })
      });
      setAlbumAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setAlbumTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the photo");
    }
  }, []);

  const createAlbumSubmit = useCallback(async () => {
    const name = albumNewName.trim();
    if (!name) return;
    setAlbumBusy(true);
    try {
      await api("/api/library/gallery/albums", {
        method: "POST",
        body: JSON.stringify({ name, description: albumNewDesc.trim() || null })
      });
      setAlbumCreateOpen(false);
      setAlbumNewName("");
      setAlbumNewDesc("");
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the album");
    } finally {
      setAlbumBusy(false);
    }
  }, [albumNewName, albumNewDesc, loadAlbums]);

  const confirmDeleteAlbum = useCallback(async () => {
    if (!selectedAlbum) return;
    setAlbumBusy(true);
    try {
      await api(`/api/library/gallery/albums/${selectedAlbum.id}`, { method: "DELETE" });
      setAlbumDeleteOpen(false);
      setSelectedAlbum(null);
      void loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete the album");
    } finally {
      setAlbumBusy(false);
    }
  }, [selectedAlbum, loadAlbums]);

  // Slideshows list + one slideshow's items (paged like albums, but in
  // presentation order). A larger page keeps a whole slideshow in one request.
  const loadSlideshows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ slideshows: GallerySlideshow[] }>("/api/library/gallery/slideshows");
      setSlideshows(payload.slideshows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load slideshows");
    } finally {
      setLoading(false);
    }
  }, []);

  const openSlideshow = useCallback(async (slideshowId: string, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ slideshow: GallerySlideshowDetail; assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/slideshows/${slideshowId}?limit=200&offset=${offset}`
      );
      setSelectedSlideshow(payload.slideshow);
      setSlideshowAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setSlideshowTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the slideshow");
    } finally {
      setLoading(false);
    }
  }, []);

  // Presentation settings (transition / seconds per photo). Optimistic: the child
  // renders from selectedSlideshow, so patch it locally, then persist.
  const patchSlideshow = useCallback(async (slideshowId: string, fields: { name?: string; transition?: SlideshowTransition; slideSeconds?: number; musicTrackId?: string | null }) => {
    setSelectedSlideshow((prev) => (prev && prev.id === slideshowId ? { ...prev, ...fields } : prev));
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}`, { method: "PATCH", body: JSON.stringify(fields) });
      if (fields.name !== undefined) { setSlideshowRename(null); void loadSlideshows(); }
      // A music change alters derived fields (musicTitle/musicUrl) the server resolves,
      // so re-fetch the detail to pick them up (the optimistic patch only set the id).
      if (fields.musicTrackId !== undefined) void openSlideshow(slideshowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the slideshow");
      void openSlideshow(slideshowId); // resync on failure
    }
  }, [loadSlideshows, openSlideshow]);

  // Kick off (or re-run) an MP4 render. The poll effect below tracks it to completion.
  const renderSlideshowMovie = useCallback(async (slideshowId: string) => {
    setError("");
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/render`, { method: "POST" });
      setSelectedSlideshow((prev) => (prev && prev.id === slideshowId ? { ...prev, renderStatus: "queued", renderError: null, renderPercent: null } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the render");
    }
  }, []);

  // While a render is queued/rendering, poll the detail (cheaply — limit=1) and merge
  // the fresh render fields so the editor shows live progress, then the finished movie.
  useEffect(() => {
    const status = selectedSlideshow?.renderStatus;
    if (status !== "queued" && status !== "rendering") return;
    const id = selectedSlideshow!.id;
    let alive = true;
    const timer = window.setInterval(() => {
      api<{ slideshow: GallerySlideshowDetail }>(`/api/library/gallery/slideshows/${id}?limit=1`)
        .then((payload) => { if (alive) setSelectedSlideshow((prev) => (prev && prev.id === id ? { ...prev, ...payload.slideshow } : prev)); })
        .catch(() => { /* keep polling */ });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selectedSlideshow?.renderStatus, selectedSlideshow?.id]);

  // Persist a drag/‹›-reorder. The child already shows the new order optimistically,
  // so mirror it into slideshowAssets (keeps the lightbox preview order in step).
  const reorderSlideshow = useCallback(async (slideshowId: string, orderedIds: string[]) => {
    setSlideshowAssets((prev) => {
      const byId = new Map(prev.map((a) => [a.id, a]));
      const next = orderedIds.map((id) => byId.get(id)).filter((a): a is GalleryAsset => Boolean(a));
      const extra = prev.filter((a) => !orderedIds.includes(a.id));
      return [...next, ...extra];
    });
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/reorder`, {
        method: "POST",
        body: JSON.stringify({ itemIds: orderedIds })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reorder the slideshow");
      void openSlideshow(slideshowId);
    }
  }, [openSlideshow]);

  const removeFromSlideshow = useCallback(async (slideshowId: string, assetId: string) => {
    try {
      await api(`/api/library/gallery/slideshows/${slideshowId}/items/remove`, {
        method: "POST",
        body: JSON.stringify({ itemIds: [assetId] })
      });
      setSlideshowAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setSlideshowTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the photo");
    }
  }, []);

  const createSlideshowSubmit = useCallback(async () => {
    const name = slideshowNewName.trim();
    if (!name) return;
    setSlideshowBusy(true);
    try {
      await api("/api/library/gallery/slideshows", { method: "POST", body: JSON.stringify({ name }) });
      setSlideshowCreateOpen(false);
      setSlideshowNewName("");
      void loadSlideshows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the slideshow");
    } finally {
      setSlideshowBusy(false);
    }
  }, [slideshowNewName, loadSlideshows]);

  const confirmDeleteSlideshow = useCallback(async () => {
    if (!selectedSlideshow) return;
    setSlideshowBusy(true);
    try {
      await api(`/api/library/gallery/slideshows/${selectedSlideshow.id}`, { method: "DELETE" });
      setSlideshowDeleteOpen(false);
      setSelectedSlideshow(null);
      void loadSlideshows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete the slideshow");
    } finally {
      setSlideshowBusy(false);
    }
  }, [selectedSlideshow, loadSlideshows]);

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

  // Suggested memories (event/trip clusters). Loaded on mount too, so the Memories
  // tab can appear even when there are no "On this day" anniversaries today.
  const loadMemorySuggestions = useCallback(async () => {
    const params = new URLSearchParams({ ...scopeParams(), limit: "12" } as Record<string, string>);
    try {
      const payload = await api<{ suggestions: GalleryMemorySuggestion[] }>(`/api/library/gallery/memories/suggestions?${params}`);
      setMemorySuggestions(payload.suggestions);
    } catch { /* advisory; the section just stays empty */ }
  }, [scopeParams]);

  useEffect(() => { void loadMemorySuggestions(); }, [loadMemorySuggestions]);

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
      setView("slideshows");
      await openSlideshow(slideshow.id);
      setNotice(`Created slideshow “${slideshow.name}” from a memory.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the slideshow");
    }
  }, [openSlideshow]);

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
    else if (view === "albums") { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); }
    else if (view === "slideshows") { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); }
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

  // Album overflow (…) menu — right-aligned under its trigger, same dismissal.
  const toggleAlbumMenu = () => {
    setAlbumMenuOpen((open) => {
      if (!open && albumMenuTriggerRef.current) {
        const rect = albumMenuTriggerRef.current.getBoundingClientRect();
        setAlbumMenuPos({ top: rect.bottom + 8, left: rect.left });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!albumMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (albumMenuTriggerRef.current?.contains(target)) return;
      if (albumMenuRef.current?.contains(target)) return;
      setAlbumMenuOpen(false);
    };
    const dismiss = () => setAlbumMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [albumMenuOpen]);

  // Opening a different album (or closing) drops the cover picker / menu and any
  // selection carried over from the previous album.
  useEffect(() => {
    setCoverPickerOpen(false);
    setAlbumMenuOpen(false);
    setShareAlbumOpen(false);
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
  const selectedLibraryLabel = scopeId === "all" ? "All Libraries" : libraryFor(scopeId)?.name ?? "All Libraries";

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
            ? { label: "Back to gallery", onClick: () => setView("timeline") }
            : null;
  const canDeleteAny = libraries.some((library) => library.canDelete);
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

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkError("");
  };

  // Changing the dataset (view / scope / search / filters) clears any selection so
  // a stale id from a no-longer-visible asset can't linger. Sorting only reorders
  // the same assets, so it keeps the selection.
  useEffect(() => { setSelectionMode(false); setSelectedIds(new Set()); }, [view, scopeId, query, filters]);

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
        : view === "albums"
          ? (selectedAlbum ? `${formatCount(albumTotal)} ${albumTotal === 1 ? "item" : "items"}` : `${formatCount(albums.length)} ${albums.length === 1 ? "album" : "albums"}`)
          : view === "slideshows"
            ? (selectedSlideshow ? `${formatCount(slideshowTotal)} ${slideshowTotal === 1 ? "photo" : "photos"}` : `${formatCount(slideshows.length)} ${slideshows.length === 1 ? "slideshow" : "slideshows"}`)
          : view === "timeline"
            ? `${formatCount(total)} ${total === 1 ? "item" : "items"}`
            : "Browsing by folder";

  return (
    <DashboardShell active="gallery" user={user} logout={logout}>
      <section className={`audiobook-main-page gallery-page${selectionMode ? " is-selecting" : ""}`}>
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
              {!selectionMode && slideshow && slideshow.list.length > 1 && (
                <button
                  type="button"
                  className="audiobook-page-action-icon"
                  onClick={startSlideshow}
                  aria-label="Play slideshow"
                  title="Play slideshow"
                >
                  <Play size={18} aria-hidden="true" />
                </button>
              )}
              {/* Selection is no longer delete-gated: favoriting and adding to a
                  collection are for every member. Delete inside the bar still is. */}
              {!selectionMode && view !== "map" && view !== "people" && view !== "albums" && view !== "slideshows" && (
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
        {notice && <MessageBox tone="success" title="Gallery updated">{notice}</MessageBox>}
        {/* Favorite/collection failures surface here — the delete flow shows its
            own error inside the confirm dialog. */}
        {bulkError && !bulkDeleteOpen && <MessageBox tone="error" title="Unable to update">{bulkError}</MessageBox>}

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
                    className={view === "albums" ? "active" : ""}
                    onClick={(event) => { event.preventDefault(); setSearchText(""); setView("albums"); }}
                  >
                    <Album size={19} aria-hidden="true" />
                    <span>Albums</span>
                  </a>
                  <a
                    href="/gallery"
                    className={view === "slideshows" ? "active" : ""}
                    onClick={(event) => { event.preventDefault(); setSearchText(""); setView("slideshows"); }}
                  >
                    <Film size={19} aria-hidden="true" />
                    <span>Slideshows</span>
                  </a>
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

            {/* One-click "up" out of any sub-view. Context-aware: from a detail level
                it steps back to the parent list (Back to albums/people/folders),
                otherwise back to the main Timeline (Back to gallery). */}
            {backTarget && (
              <div className="gallery-back-row">
                <button type="button" className="gallery-back-button" onClick={backTarget.onClick}>
                  <ArrowLeft size={16} aria-hidden="true" /> {backTarget.label}
                </button>
              </div>
            )}

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
                    className="secondary-button compact-button"
                    onClick={() => void bulkFavorite()}
                    disabled={selectedIds.size === 0 || bulkBusy}
                  >
                    <Heart size={15} aria-hidden="true" /> {bulkBusy ? "Adding…" : "Favorite"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => { setBulkError(""); setBulkAlbumOpen(true); }}
                    disabled={selectedIds.size === 0 || bulkBusy}
                  >
                    <ImagePlus size={15} aria-hidden="true" /> Add to album
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => { setBulkError(""); setBulkSlideshowOpen(true); }}
                    disabled={selectedIds.size === 0 || bulkBusy}
                  >
                    <Film size={15} aria-hidden="true" /> Add to slideshow
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => { setBulkError(""); setBulkCollectionOpen(true); }}
                    disabled={selectedIds.size === 0 || bulkBusy}
                  >
                    <ListMusic size={15} aria-hidden="true" /> Add to collection
                  </button>
                  {canShareAny && (
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      onClick={() => { setBulkError(""); setShareIds([...selectedIds]); }}
                      disabled={selectedIds.size === 0 || bulkBusy}
                    >
                      <Share2 size={15} aria-hidden="true" /> Share
                    </button>
                  )}
                  {canDeleteAny && (
                    <button
                      type="button"
                      className="danger-button compact-button"
                      onClick={() => { setBulkError(""); setBulkDeleteOpen(true); }}
                      disabled={selectedIds.size === 0 || bulkBusy}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Delete
                    </button>
                  )}
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
            ) : view === "albums" ? (
              selectedAlbum ? (() => {
                const albumCoverUrl = albums.find((al) => al.id === selectedAlbum.id)?.coverUrl ?? albumAssets[0]?.coverUrl ?? null;
                return (
                <>
                  <div className="gallery-breadcrumb">
                    <button type="button" onClick={() => { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); }}>All albums</button>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <ChevronRight size={14} aria-hidden="true" />
                      <strong>{selectedAlbum.name}</strong>
                    </span>
                  </div>

                  <div className="gallery-album-header">
                    <span className="gallery-album-cover">
                      {albumCoverUrl ? <img src={albumCoverUrl} alt="" /> : <Album size={30} aria-hidden="true" />}
                    </span>
                    <div className="gallery-album-heading">
                      {albumRename == null ? (
                        <h2>{selectedAlbum.name}</h2>
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
                    <div className="gallery-album-actions">
                      <button
                        ref={albumMenuTriggerRef}
                        type="button"
                        className="audiobook-page-action-icon"
                        onClick={toggleAlbumMenu}
                        aria-haspopup="menu"
                        aria-expanded={albumMenuOpen}
                        aria-label="More album actions"
                        title="More"
                      >
                        <MoreHorizontal size={18} aria-hidden="true" />
                      </button>
                      {selectedAlbum.canEdit && (
                        <AudiobookHeaderSort
                          value={selectedAlbum.sortMode as unknown as SortKey}
                          onChange={(value) => void patchAlbum(selectedAlbum.id, { sortMode: value as unknown as "taken_at" | "manual" })}
                          options={ALBUM_SORT_OPTIONS as unknown as { value: SortKey; label: string }[]}
                          ariaLabel="Sort album"
                          compact
                        />
                      )}
                      {!selectionMode && (
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
                      {albumMenuOpen && albumMenuPos && createPortal(
                        <div
                          ref={albumMenuRef}
                          className="gallery-album-menu"
                          role="menu"
                          aria-label="Album actions"
                          style={{ position: "fixed", top: albumMenuPos.top, left: albumMenuPos.left }}
                        >
                          {selectedAlbum.canEdit && (
                            <button type="button" role="menuitem" onClick={() => { setAlbumMenuOpen(false); setAlbumRename(selectedAlbum.name); }}>
                              <Pencil size={15} aria-hidden="true" /><span>Rename album</span>
                            </button>
                          )}
                          {selectedAlbum.canEdit && (
                            <button type="button" role="menuitem" onClick={() => { setAlbumMenuOpen(false); setNotice(""); setCoverPickerOpen(true); }}>
                              <ImageIcon size={15} aria-hidden="true" /><span>Set cover photo</span>
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            disabled={albumAssets.length < 2}
                            title={albumAssets.length < 2 ? "Add more photos to play a slideshow" : "Play this album as a slideshow"}
                            onClick={() => { setAlbumMenuOpen(false); startSlideshow(); }}
                          >
                            <Play size={15} aria-hidden="true" /><span>Play slideshow</span>
                          </button>
                          <a
                            role="menuitem"
                            href={`/api/library/gallery/albums/${selectedAlbum.id}/download`}
                            download
                            onClick={() => setAlbumMenuOpen(false)}
                          >
                            <Download size={15} aria-hidden="true" /><span>Download album</span>
                          </a>
                          {selectedAlbum.canEdit && (
                            <button type="button" role="menuitem" onClick={() => { setAlbumMenuOpen(false); setShareAlbumOpen(true); }}>
                              <Share2 size={15} aria-hidden="true" /><span>Share album</span>
                            </button>
                          )}
                          {selectedAlbum.canEdit && (
                            <button type="button" role="menuitem" className="danger" onClick={() => { setAlbumMenuOpen(false); setAlbumDeleteOpen(true); }}>
                              <Trash2 size={15} aria-hidden="true" /><span>Delete album</span>
                            </button>
                          )}
                        </div>,
                        document.body
                      )}
                    </div>
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
                      This album is empty. Select photos in the Timeline and use “Add to album”.
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
                  <div className="gallery-person-toolbar">
                    <button type="button" className="secondary-button compact-button" onClick={() => setAlbumCreateOpen(true)}>
                      <Plus size={14} aria-hidden="true" /> New album
                    </button>
                    <span className="muted gallery-face-hint">
                      Albums organize photos across libraries. Anyone can view; only the creator and admins can change one.
                    </span>
                  </div>

                  {albums.length > 0 && (
                    <div className="gallery-folder-grid">
                      {albums.map((album) => (
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
                    <div className="gallery-breadcrumb">
                      <button type="button" onClick={() => { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); }}>All slideshows</button>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <ChevronRight size={14} aria-hidden="true" />
                        <strong>{selectedSlideshow.name}</strong>
                      </span>
                    </div>

                    <div className="gallery-album-header">
                      <span className="gallery-album-cover">
                        {cover ? <img src={cover} alt="" /> : <Film size={30} aria-hidden="true" />}
                      </span>
                      <div className="gallery-album-heading">
                        {slideshowRename == null ? (
                          <h2>{selectedSlideshow.name}</h2>
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
                        <div className="gallery-album-actions">
                          <button
                            type="button"
                            className="primary-button compact-button"
                            disabled={slideshowAssets.length === 0}
                            title={slideshowAssets.length < 2 ? "Add more photos to play a slideshow" : "Play this slideshow"}
                            onClick={startSlideshow}
                          >
                            <Play size={15} aria-hidden="true" /> Play
                          </button>
                          {selectedSlideshow.canEdit && (
                            <button type="button" className="secondary-button compact-button" onClick={() => setSlideshowRename(selectedSlideshow.name)}>
                              <Pencil size={15} aria-hidden="true" /> Rename
                            </button>
                          )}
                          {selectedSlideshow.canEdit && (
                            <button type="button" className="danger-button compact-button" onClick={() => setSlideshowDeleteOpen(true)}>
                              <Trash2 size={15} aria-hidden="true" /> Delete
                            </button>
                          )}
                        </div>
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
                      onPatch={(fields) => void patchSlideshow(selectedSlideshow.id, fields)}
                      onRender={() => void renderSlideshowMovie(selectedSlideshow.id)}
                    />
                  </>
                );
              })() : (
                <>
                  <div className="gallery-person-toolbar">
                    <button type="button" className="secondary-button compact-button" onClick={() => setSlideshowCreateOpen(true)}>
                      <Plus size={14} aria-hidden="true" /> New slideshow
                    </button>
                    <span className="muted gallery-face-hint">
                      Slideshows present photos in a set order with a transition and timing. Anyone can view; only the creator and admins can change one.
                    </span>
                  </div>

                  {slideshows.length > 0 && (
                    <div className="gallery-folder-grid">
                      {slideshows.map((slideshow) => (
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
                  )}

                  {memorySuggestions.length > 0 && (
                    <section className="gallery-memory-suggestions" aria-label="Suggested slideshows">
                      <div className="gallery-memory-suggestions-head">
                        <h2>Suggested slideshows</h2>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => { const pick = memorySuggestions[Math.floor(Math.random() * memorySuggestions.length)]; if (pick) void createFromMemory(pick); }}
                        >
                          <Sparkles size={15} aria-hidden="true" /> Surprise me
                        </button>
                      </div>
                      <p className="muted gallery-face-hint">
                        Photos we’ve gathered into events and trips. Tap one to turn it into a slideshow you can play, set to music, reorder, and customize.
                      </p>
                      <div className="gallery-folder-grid">
                        {memorySuggestions.map((memory) => (
                          <button
                            key={memory.id}
                            type="button"
                            className="gallery-folder-tile gallery-memory-tile"
                            onClick={() => void createFromMemory(memory)}
                            title={`Create a slideshow from “${memory.title}”`}
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
                            aria-label={`Select all from ${memoryDateLabel(memories!.precision, group.year)}`}
                            title={allSelected ? "Deselect these photos" : "Select these photos"}
                          >
                            {allSelected ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                          </button>
                          {canShareAny && (
                            <button
                              type="button"
                              className="gallery-day-share"
                              onClick={() => setShareIds(ids)}
                              aria-label={`Share photos from ${memoryDateLabel(memories!.precision, group.year)}`}
                              title="Share these photos"
                            >
                              Share
                            </button>
                          )}
                          <h2>{memoryDateLabel(memories!.precision, group.year)}</h2>
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
                {days.map((day) => {
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
                  {isAdmin && scopeId !== "all" && parent !== "" && (
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
          autoPlay={lightbox.autoPlay}
          transition={lightbox.source === "slideshow" ? selectedSlideshow?.transition : undefined}
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
