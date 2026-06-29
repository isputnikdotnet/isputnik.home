import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Circle, Combine, FolderOpen, Image as ImageIcon, Images, MapPin, Pencil, Play, Heart, Folder, ScanFace, SquareCheck, Trash2, UploadCloud, Users, UserRound, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader, AudiobookHeaderSort, formatCount } from "../audiobooks/AudiobooksPage";
import type { SortKey } from "../audiobooks/BookFilter";
import { GalleryLightbox } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import type { GalleryAsset, GalleryFaceSettings, GalleryFacets, GalleryFolder, GalleryLibrary, GalleryMapPoint, GalleryPerson } from "./types";

const PAGE_SIZE = 80;

// Leaflet (~140 KB) is only needed for the Map view, so it loads on demand — keeping
// it off the initial bundle for the common Timeline/Folder browsing.
const GalleryMap = lazy(() => import("./GalleryMap").then((m) => ({ default: m.GalleryMap })));

type GalleryView = "timeline" | "folder" | "map" | "people";
type KindFilter = "all" | "photo" | "video";

// The media-type filter is presented through the same compact dropdown the
// audiobooks/ebooks header uses for sorting, so the controls line up visually.
const KIND_OPTIONS = [
  { value: "all" as const, label: "All media" },
  { value: "photo" as const, label: "Photos" },
  { value: "video" as const, label: "Videos" }
];

// Month label for the timeline header from an asset's takenAt.
function monthLabel(takenAt: string | null): string {
  if (!takenAt) return "Undated";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Undated";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function AssetTile({
  asset,
  onOpen,
  selectionMode,
  selected,
  onToggleSelect
}: {
  asset: GalleryAsset;
  onOpen: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  return (
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
      {selectionMode && (
        <span className="gallery-tile-check" aria-hidden="true">
          {selected ? <CheckCircle2 size={22} /> : <Circle size={22} />}
        </span>
      )}
    </button>
  );
}

export function GalleryPage({
  user,
  logout,
  initialAssetId
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  initialAssetId?: string;
}) {
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const [view, setView] = useState<GalleryView>("timeline");
  const [scopeId, setScopeId] = useState<string>("all");
  const [kind, setKind] = useState<KindFilter>("all");

  // Search box drives the timeline `q`; a debounce keeps typing from spamming the API.
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");

  // Timeline state.
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Folder state.
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);

  // Map state. `mapCount` (geotagged assets in scope) gates whether the Map tab is
  // offered at all; `mapPoints` are the markers for the active scope/kind.
  const [mapPoints, setMapPoints] = useState<GalleryMapPoint[]>([]);
  const [mapCount, setMapCount] = useState(0);

  // People state. The People view shows person chips; picking one drills into that
  // person's photos (`personAssets`), which open in the lightbox like any other list.
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<{ id: string; name: string } | null>(null);
  const [personAssets, setPersonAssets] = useState<GalleryAsset[]>([]);
  // Face recognition (admin): settings + a busy flag for enable/scan actions.
  const [faceSettings, setFaceSettings] = useState<GalleryFaceSettings | null>(null);
  const [faceBusy, setFaceBusy] = useState(false);
  // Inline rename of the open person.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [personDeleteOpen, setPersonDeleteOpen] = useState(false);

  // Library selector dropdown (mirrors the audiobooks/ebooks main page chip).
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<{ source: "timeline" | "folder" | "single" | "person"; index: number } | null>(null);
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

  // Searching is a timeline operation (folder view is structural); a query pulls
  // the user into the timeline so results are visible.
  useEffect(() => { if (query && view === "folder") setView("timeline"); }, [query, view]);

  const loadTimeline = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
        method: "POST",
        body: JSON.stringify({ ...scopeParams(), q: query, kinds: kind === "all" ? [] : [kind], limit: PAGE_SIZE, offset })
      });
      setAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load photos");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, kind, query]);

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
      const params = new URLSearchParams({ ...scopeParams(), kinds: kind === "all" ? "" : kind } as Record<string, string>);
      const payload = await api<{ points: GalleryMapPoint[] }>(`/api/library/gallery/map?${params}`);
      setMapPoints(payload.points);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the map");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, kind]);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    setError("");
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

  // Drill into one person's photos (opened from a person chip).
  const openPerson = useCallback(async (person: { id: string; name: string }) => {
    setLoading(true);
    setError("");
    setSelectedPerson(person);
    try {
      const payload = await api<{ assets: GalleryAsset[] }>(`/api/library/gallery/people/${person.id}?limit=200`);
      setPersonAssets(payload.assets);
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
      const payload = await api<{ settings: GalleryFaceSettings }>("/api/library/gallery/faces/settings");
      setFaceSettings(payload.settings);
    } catch { /* non-admins / errors just hide the controls */ }
  }, [isAdmin]);

  const toggleFaceRecognition = useCallback(async (enabled: boolean) => {
    setFaceBusy(true);
    try {
      const payload = await api<{ settings: GalleryFaceSettings }>("/api/library/gallery/faces/settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      setFaceSettings(payload.settings);
      setNotice(enabled ? "Face recognition enabled. Scan a library to find people." : "Face recognition disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update face recognition");
    } finally {
      setFaceBusy(false);
    }
  }, []);

  const triggerFaceScan = useCallback(async () => {
    setFaceBusy(true);
    setNotice("");
    try {
      await api("/api/library/gallery/faces/scan", {
        method: "POST",
        body: JSON.stringify(scopeId === "all" ? {} : { libraryId: scopeId })
      });
      setNotice("Face scan started. People will appear here as photos are processed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the face scan");
    } finally {
      setFaceBusy(false);
    }
  }, [scopeId]);

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

  // How many assets in scope carry GPS — decides whether the Map tab appears.
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(scopeParams() as Record<string, string>);
    api<GalleryFacets>(`/api/library/gallery/facets?${params}`)
      .then((facets) => { if (alive) setMapCount(facets.withGps); })
      .catch(() => { /* facets are advisory; the tab just stays hidden */ });
    return () => { alive = false; };
  }, [scopeParams]);

  // Fetch one asset and open it standalone in the lightbox (used by map markers).
  const openAssetById = useCallback((id: string) => {
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${id}`)
      .then((payload) => { setSingleAsset(payload.asset); setLightbox({ source: "single", index: 0 }); })
      .catch(() => { /* asset gone / no access */ });
  }, []);

  // Reload the active view when scope/kind/query/view changes.
  useEffect(() => {
    if (view === "timeline") void loadTimeline(0);
    else if (view === "folder") void loadFolder("");
    else if (view === "people") { setSelectedPerson(null); void loadPeople(); void loadFaceSettings(); }
    else void loadMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scopeId, kind, query]);

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
      else void loadMap();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [libraries, view, parent, loadLibraries, loadTimeline, loadFolder, loadMap]);

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
      : lightbox?.source === "person" ? personAssets : assets;

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
    else void loadMap();
    void loadLibraries();
  }, [view, parent, selectedPerson, loadTimeline, loadFolder, loadPeople, openPerson, loadMap, loadLibraries]);

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

  // Changing the dataset (view / scope / kind / search) clears any selection so a
  // stale id from a no-longer-visible asset can't linger.
  useEffect(() => { setSelectionMode(false); setSelectedIds(new Set()); }, [view, scopeId, kind, query]);

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

  // Group timeline assets into month buckets for the date headers.
  const months = useMemo(() => {
    const out: { label: string; items: { asset: GalleryAsset; index: number }[] }[] = [];
    assets.forEach((asset, index) => {
      const label = monthLabel(asset.takenAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ asset, index });
      else out.push({ label, items: [{ asset, index }] });
    });
    return out;
  }, [assets]);

  const breadcrumbParts = parent ? parent.split("/") : [];
  const subtitle = view === "map"
    ? `${formatCount(mapPoints.length)} on the map`
    : view === "people"
      ? (selectedPerson ? `${formatCount(personAssets.length)} ${personAssets.length === 1 ? "photo" : "photos"}` : `${formatCount(people.length)} ${people.length === 1 ? "person" : "people"}`)
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
              <AudiobookHeaderSort
                value={kind as unknown as SortKey}
                onChange={(value) => setKind(value as unknown as KindFilter)}
                options={KIND_OPTIONS as unknown as { value: SortKey; label: string }[]}
                ariaLabel="Filter by media type"
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
              {canDeleteAny && !selectionMode && view !== "map" && view !== "people" && (
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
                  <p className="management-empty">No photos or videos with location data{kind !== "all" ? ` of this type` : ""} in this library.</p>
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
                      />
                    ))}
                  </div>
                  {!loading && personAssets.length === 0 && (
                    <p className="management-empty">No photos for this person yet.</p>
                  )}
                </>
              ) : (
                <>
                  {isAdmin && faceSettings && (
                    <div className="gallery-face-admin">
                      <label className="gallery-face-toggle">
                        <input
                          type="checkbox"
                          checked={faceSettings.enabled}
                          disabled={faceBusy}
                          onChange={(event) => void toggleFaceRecognition(event.target.checked)}
                        />
                        <span>Face recognition</span>
                      </label>
                      {faceSettings.enabled && (
                        <button type="button" className="secondary-button compact-button" onClick={() => void triggerFaceScan()} disabled={faceBusy}>
                          <ScanFace size={14} aria-hidden="true" /> {faceBusy ? "Working…" : "Scan for faces"}
                        </button>
                      )}
                      <span className="muted gallery-face-hint">
                        {faceSettings.enabled
                          ? "Detects faces in photos and groups them into people automatically."
                          : "Off — turn on to auto-detect people across your photos."}
                      </span>
                    </div>
                  )}

                  {people.length > 0 && (
                    <div className="gallery-people-grid">
                      {people.map((person) => (
                        <button key={person.id} type="button" className="gallery-person-card" onClick={() => void openPerson(person)}>
                          <span className="gallery-person-avatar">
                            {person.coverUrl ? <img src={person.coverUrl} alt="" loading="lazy" /> : <UserRound size={28} aria-hidden="true" />}
                          </span>
                          <strong className={person.name ? undefined : "gallery-person-unnamed"}>{person.name || "Unnamed"}</strong>
                          <small>{person.faceCount.toLocaleString()} {person.faceCount === 1 ? "photo" : "photos"}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {!loading && people.length === 0 && (
                    <div className="empty-state library-empty">
                      <Users size={48} aria-hidden="true" />
                      <h2>No people yet</h2>
                      <p className="muted">
                        {isAdmin && faceSettings && !faceSettings.enabled
                          ? "Turn on face recognition above to auto-detect people — or open a photo's details to tag someone by hand."
                          : "Open a photo, show its details, and add a person to start grouping by who's in them."}
                      </p>
                    </div>
                  )}
                </>
              )
            ) : view === "timeline" ? (
              <>
                {months.map((month) => (
                  <div key={month.label}>
                    <h2 className="gallery-month-label">{month.label}</h2>
                    <div className="gallery-grid">
                      {month.items.map(({ asset, index }) => (
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
                ))}
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
