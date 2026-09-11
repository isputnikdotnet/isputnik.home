import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Album, ArrowLeft, CalendarDays, ChevronDown, Compass, Film, FolderOpen, Image as ImageIcon, Inbox, LayoutGrid, LibraryBig, MapPin, Plus, Sparkles, SquareCheck, UploadCloud, Users } from "lucide-react";
import { api } from "../../api";
import { sendInBatches } from "../../shared/bulk";
import { DashboardShell } from "../../app/DashboardShell";
import { useSession } from "../../app/SessionContext";
import { followRoute, galleryHref, galleryInboxHref, galleryReviewAlbumHref, navigate, type GalleryView } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SortMenu } from "../../shared/SortMenu";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { useIsMobile } from "../../shared/useIsMobile";
import { useAnchoredMenu } from "../../shared/useAnchoredMenu";
import { SectionNav, type SectionNavItem } from "../../shared/SectionNav";
import type { LightboxSource } from "./AssetTile";
import { useGalleryAlbums } from "./useGalleryAlbums";
import { useGallerySlideshows } from "./useGallerySlideshows";
import { useGalleryPeople } from "./useGalleryPeople";
import { GalleryLightbox, type GalleryAssetChange } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryFilterButton, GalleryFilterChips, EMPTY_GALLERY_FILTERS, type GalleryFilters } from "./GalleryFilter";
import { getGroupingOptions, getTileSizeOptions, type GalleryGrouping, type GalleryTileSize } from "./gallery-view";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { AddToAlbumModal } from "./AddToAlbumModal";
import { AskSomeoneModal, type AskSomeoneSource } from "./AskSomeoneModal";
import { AddToSlideshowModal } from "./AddToSlideshowModal";
import { GalleryDateModal } from "./GalleryDateModal";
import { GalleryLocationModal } from "./GalleryLocationModal";
import { GalleryTagsModal } from "./GalleryTagsModal";
import { SlideshowMovieLibraryModal } from "./SlideshowMovieLibraryModal";
import { PhotoPicker } from "./PhotoPicker";
import { ShareSetModal } from "../share/ShareSetModal";
import { SendToSheet, type SendToSubject } from "../social/SendToSheet";
import type { GalleryAsset, GalleryLibrary, GalleryMapPoint } from "./types";
import { getSortOptions, getViewTitles, type LightboxState } from "./page/gallery-page-model";
import { useGalleryScope } from "./page/useGalleryScope";
import { useGalleryScanPoll, useTimeline } from "./page/useTimeline";
import { useFolderBrowse } from "./page/useFolderBrowse";
import { useFolderAdmin } from "./page/useFolderAdmin";
import { useMemories } from "./page/useMemories";
import { TimelineView } from "./page/TimelineView";
import { MemoriesView } from "./page/MemoriesView";
import { AlbumsView } from "./page/AlbumsView";
import { SlideshowsView } from "./page/SlideshowsView";
import { PeopleView } from "./page/PeopleView";
import { FoldersView } from "./page/FoldersView";
import { GallerySelectionActions } from "./page/GallerySelectionActions";
import { SuggestionPreviewModal } from "./page/SuggestionPreviewModal";
import { CreateAlbumModal, CreateSlideshowModal } from "./page/CreateSetModals";
import { CoverPickerModal } from "./page/CoverPickerModal";
import { BulkDeleteDialog, DeleteAlbumDialog, DeleteMovieDialog, DeletePersonDialog, DeleteSlideshowDialog } from "./page/GalleryConfirmDialogs";

// Leaflet (~140 KB) is only needed for the Map view, so it loads on demand — keeping
// it off the initial bundle for the common Timeline/Folder browsing.
const GalleryMap = lazy(() => import("./GalleryMap").then((m) => ({ default: m.GalleryMap })));

// The gallery's route shell: every /gallery address lands here. It owns what the
// views share — the libraries, the one loading flag / error box / notice line,
// the header and toolbar, the selection and its bulk dialogs, the lightbox — and
// hands the view named by the address to its component in ./page/. Each view's
// data lives in its own hook (useTimeline, useFolderBrowse, useMemories, and the
// album / slideshow / people hooks beside this file).
export function GalleryPage({
  view,
  initialAssetId,
  initialAlbumId,
  initialSlideshowId,
  initialFolder,
  initialLibraryId
}: {
  /** Which browse view the address names. Not state — the URL is the view, so
   *  every one of them can be linked to, opened in a new tab and stepped back
   *  out of; switching views goes through goToView() below. */
  view: GalleryView;
  initialAssetId?: string;
  /** Deep link (/gallery/albums/<id>): open that album rather than the list. */
  initialAlbumId?: string;
  /** Deep link (/gallery/slideshows/<id>): open that slideshow rather than the list. */
  initialSlideshowId?: string;
  /** Deep link (/gallery/folders/…): open the Folders view straight into this folder. */
  initialFolder?: string;
  initialLibraryId?: string | null;
}) {
  const { user } = useSession();
  const { t } = useTranslation(["common", "gallery"]);
  const VIEW_TITLES = getViewTitles();
  const SORT_OPTIONS = getSortOptions();
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  // The libraries facet names a Photo Inbox as one, and a library inside App
  // storage as that, so choosing either is a deliberate act: both are left out of
  // every scope that isn't explicit (the server's scope resolver), and this is
  // the one place they can be asked for.
  const filterLibraries = useMemo(() => libraries.map((library) => (
    library.inbox
      ? { ...library, name: t("gallery:inbox.libraryLabel", { name: library.name }) }
      : library.appStorage
        ? { ...library, name: t("gallery:inbox.appStorageLabel", { name: library.name }) }
        : library
  )), [libraries, t]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = user.role === "admin";
  // Declared up here with error/loading because the view hooks below report into
  // all three — one loading flag, one error box, one notice line for the page.
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  // Switching view is a navigation. The page itself is not remounted — App hands
  // every gallery address to this same component — so the scope, sort and loaded
  // libraries survive the move, exactly as they did when view was useState.
  const goToView = useCallback((next: GalleryView) => navigate(galleryHref(next)), []);
  // Only one detail view is ever open, so one bit of state serves the album and
  // the slideshow topbars.
  const [sendToSubject, setSendToSubject] = useState<SendToSubject | null>(null);
  // "Ask someone": a selection or a folder becomes an album, then Send to opens
  // on it with the question ticked (docs/for-you-plan.md).
  const [askSomeone, setAskSomeone] = useState<AskSomeoneSource | null>(null);

  const {
    sort, setSort, viewPrefs, setViewPrefs, gridClass,
    searchText, setSearchText, query, setQuery, folderQuery,
    filters, setFilters, changeFilters, peopleMatchAll, setPeopleMatchAll,
    soleLibraryId, scopeParams, facets
  } = useGalleryScope({ view, initialLibraryId, goToView });

  const { assets, setAssets, total, setTotal, loadTimeline, reloadTimeline } =
    useTimeline({ sort, query, filters, peopleMatchAll, setLoading, setError });

  const folderBrowse = useFolderBrowse({ view, folderQuery, scopeParams, initialFolder, setLoading, setError });
  const {
    parent, parentLocked, setParentLocked, folders, folderAssets, setFolderAssets, folderTotal, setFolderTotal,
    folderSubtreeTotal, pendingFolderRef, deepLinkFolder, loadFolder
  } = folderBrowse;

  // The Albums and Slideshows views own their own state and loaders. Destructured
  // back into the names the rest of this file already uses, so the seam is the
  // state and not a rewrite of the markup.
  const status = { setLoading, setError, setNotice };
  const albumsState = useGalleryAlbums(status);
  const {
    albums, selectedAlbum, setSelectedAlbum, albumAssets, setAlbumAssets,
    albumCreateOpen, setAlbumCreateOpen, albumNewName, setAlbumNewName, albumNewDesc, setAlbumNewDesc,
    setAlbumRename, albumDeleteOpen, setAlbumDeleteOpen, albumBusy,
    bulkAlbumOpen, setBulkAlbumOpen, coverPickerOpen, setCoverPickerOpen,
    albumBrowseOpen, setAlbumBrowseOpen,
    loadAlbums, openAlbum, setAlbumCover, createAlbumSubmit, confirmDeleteAlbum
  } = albumsState;
  const slideshowsState = useGallerySlideshows(status);
  const {
    slideshows, selectedSlideshow, setSelectedSlideshow,
    slideshowAssets, setSlideshowAssets, setSlideshowTotal,
    slideshowCreateOpen, setSlideshowCreateOpen,
    slideshowNewName, setSlideshowNewName, setSlideshowRename,
    slideshowDeleteOpen, setSlideshowDeleteOpen, slideshowBusy,
    bulkSlideshowOpen, setBulkSlideshowOpen, browseOpen, setBrowseOpen,
    slideshowCoverPickerOpen, setSlideshowCoverPickerOpen,
    movieDeleteOpen, setMovieDeleteOpen, movieDeleteBusy,
    slideshowSettings, loadSlideshowSettings,
    loadSlideshows, openSlideshow, patchSlideshow, setSlideshowCover,
    deleteSlideshowMovie, createSlideshowSubmit, confirmDeleteSlideshow
  } = slideshowsState;
  // Above the view hooks because People is scope-filtered and takes scopeParams.
  const peopleState = useGalleryPeople({ ...status, scopeParams, isAdmin });
  const {
    people, selectedPerson, setSelectedPerson, personAssets, setPersonAssets,
    setRenameValue, setMergeOpen, personCoverPickerOpen, setPersonCoverPickerOpen, setPersonCover,
    personDeleteOpen, setPersonDeleteOpen,
    loadPeople, openPerson, loadFaceSettings, confirmDeletePerson
  } = peopleState;

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
  // People's own toolbar held Filter (libraries-only) and Upload. Upload still
  // doesn't pull its weight on a page about who's in your photos, but the filter
  // does: which libraries the faces are gathered from is the one thing that
  // narrows this page, and with no control for it the scope could only ever be
  // undone (through the chips row) and never set. So the row comes back holding
  // that alone — and only where it means something: one library is no choice at
  // all, and People goes back to having no toolbar rather than a row carrying
  // nothing but Back. An open person keeps its compact icon topbar either way
  // (showBrowseChrome already covers that).
  const showToolbar = showBrowseChrome && (view !== "people" || libraries.length > 1);
  // Which facets are narrowing what is on screen right now, and whether the chip
  // row is offered at all (Albums and Slideshows are lists of named things — no
  // filter reaches them). `fields` undefined means every facet: the timeline is
  // the one view that applies the lot.
  const chipFields: { shown: boolean; fields?: (keyof GalleryFilters)[] } =
    view === "timeline" ? { shown: true }
      : view === "map" ? { shown: true, fields: ["libraries", "kinds"] }
        : { shown: view === "folder" || view === "memories" || (view === "people" && !selectedPerson), fields: ["libraries"] };
  const searchPlaceholder = view === "timeline"
    ? t("gallery:page.search.photos")
    : view === "folder" ? t("gallery:page.search.folders")
      : view === "albums" ? t("gallery:page.search.albums")
        : view === "slideshows" ? t("gallery:page.search.slideshows")
          : t("gallery:page.search.people");

  // Map state. `mapCount` (geotagged assets in scope, from the facets) gates whether
  // the Map tab is offered at all; `mapPoints` are the markers for the active scope/kind.
  const [mapPoints, setMapPoints] = useState<GalleryMapPoint[]>([]);
  const mapCount = facets?.withGps ?? 0;

  const isMobile = useIsMobile();

  // Mobile / PWA: "Browse" dropdown that collapses the view tabs (Timeline,
  // Memories, Albums, …), matching the audiobooks/ebooks compact header.
  // ("viewMenu" rather than "browse" — browseOpen is the slideshow photo browser.)
  const viewMenu = useAnchoredMenu({ closeOnEscape: false });

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [singleAsset, setSingleAsset] = useState<GalleryAsset | null>(null);
  const openLightbox = (source: LightboxSource, index: number) => setLightbox({ source, index });

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
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
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
      setError(err instanceof Error ? err.message : t("gallery:page.errors.loadLibraries"));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  const folderAdmin = useFolderAdmin({ soleLibraryId, parent, parentLocked, setParentLocked, libraries, setError, setNotice, loadFolder });

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ ...scopeParams(), kinds: filters.kinds.join(",") } as Record<string, string>);
      const payload = await api<{ points: GalleryMapPoint[] }>(`/api/library/gallery/map?${params}`);
      setMapPoints(payload.points);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:mapView.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [scopeParams, filters.kinds]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCuratePeople = libraries.some((library) => library.canWrite);

  const {
    memories, setMemories, memorySuggestions, previewSuggestion, setPreviewSuggestion, previewAssets,
    loadMemories, openSuggestionPreview, createFromMemory, memoryItems, openMemoryYear
  } = useMemories({
    scopeParams, setError, setNotice, goToView, openSlideshow, setLightbox,
    resetSlideshow: () => { setSlideshowAssets([]); setSlideshowTotal(0); }
  });

  // Fetch one asset and open it standalone in the lightbox (used by map markers).
  const openAssetById = useCallback((id: string) => {
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${id}`)
      .then((payload) => { setSingleAsset(payload.asset); setLightbox({ source: "single", index: 0 }); })
      .catch(() => { /* asset gone / no access */ });
  }, []);

  // Reload the active view when scope/sort/query/filters/view changes.
  // (Memories loads through its own scope-keyed effect in useMemories.)
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
  }, [view, sort, query, filters, peopleMatchAll]);

  // Deep link: open the named album / slideshow instead of its list. Runs once
  // per id — after that the URL follows the selection (below), not the reverse,
  // so paging and Back keep working exactly as they did.
  useEffect(() => {
    if (initialAlbumId) void openAlbum(initialAlbumId);
  }, [initialAlbumId, openAlbum]);

  useEffect(() => {
    if (initialSlideshowId) void openSlideshow(initialSlideshowId);
  }, [initialSlideshowId, openSlideshow]);

  // Keep the address in step with what is open, without adding a history entry
  // per click — replaceState, the same treatment the A–Z strip's ?letter gets.
  // Opening an album and pressing Back should leave the gallery, not walk back
  // through every album looked at on the way.
  useEffect(() => {
    if (view !== "albums") return;
    const want = selectedAlbum ? `/gallery/albums/${selectedAlbum.id}` : "/gallery/albums";
    if (window.location.pathname !== want) window.history.replaceState(window.history.state, "", want);
  }, [view, selectedAlbum]);

  useEffect(() => {
    if (view !== "slideshows") return;
    const want = selectedSlideshow ? `/gallery/slideshows/${selectedSlideshow.id}` : "/gallery/slideshows";
    if (window.location.pathname !== want) window.history.replaceState(window.history.state, "", want);
  }, [view, selectedSlideshow]);

  // Deep link: fetch the asset and open a standalone lightbox.
  useEffect(() => {
    if (!initialAssetId) return;
    let alive = true;
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${initialAssetId}`)
      .then((payload) => { if (alive) { setSingleAsset(payload.asset); setLightbox({ source: "single", index: 0 }); } })
      .catch(() => { /* asset gone / no access — fall back to the timeline */ });
    return () => { alive = false; };
  }, [initialAssetId]);

  useGalleryScanPoll({
    libraries, view, parent,
    timelineLoaded: assets.length, folderLoaded: folderAssets.length,
    loadLibraries, reloadTimeline, loadFolder, loadMemories, loadMap
  });

  // Opening a different album (or closing) drops the cover picker, the folder
  // browser, and any selection carried over from the previous album.
  useEffect(() => {
    setCoverPickerOpen(false);
    setAlbumBrowseOpen(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [selectedAlbum?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The movie-target libraries are needed by the slideshow editor as well as the list,
  // and a deep link opens the editor without ever passing through the list — so load them
  // whenever the Slideshows view is active rather than only on the way in.
  useEffect(() => { if (view === "slideshows") void loadSlideshowSettings(); }, [view, loadSlideshowSettings]);

  const uploadLibraries = libraries.filter((library) => library.canUpload);

  // Reload whichever view is active plus the library list (counts / scan badges).
  const refreshView = useCallback(() => {
    if (view === "timeline") void reloadTimeline(assets.length);
    else if (view === "folder") void loadFolder(parent, 0, folderAssets.length);
    else if (view === "people") { void loadPeople(); if (selectedPerson) void openPerson(selectedPerson); }
    else if (view === "albums") { if (selectedAlbum) void openAlbum(selectedAlbum.id); else void loadAlbums(); }
    else if (view === "slideshows") { if (selectedSlideshow) void openSlideshow(selectedSlideshow.id); else void loadSlideshows(); }
    else if (view === "memories") void loadMemories();
    else if (view === "map") void loadMap();
    void loadLibraries();
  }, [view, parent, assets.length, folderAssets.length, selectedPerson, selectedAlbum, selectedSlideshow, reloadTimeline, loadFolder, loadPeople, openPerson, openAlbum, loadAlbums, openSlideshow, loadSlideshows, loadMemories, loadMap, loadLibraries]);

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
      ? { label: t("gallery:page.back.albums"), onClick: () => { setSelectedAlbum(null); setAlbumRename(null); void loadAlbums(); } }
      : view === "slideshows" && selectedSlideshow
        ? { label: t("gallery:page.back.slideshows"), onClick: () => { setSelectedSlideshow(null); setSlideshowRename(null); void loadSlideshows(); } }
      : view === "people" && selectedPerson
        ? { label: t("gallery:page.back.people"), onClick: () => { setSelectedPerson(null); setRenameValue(null); setMergeOpen(false); void loadPeople(); } }
        : view === "folder" && parent
          ? { label: t("gallery:page.back.folders"), onClick: () => void loadFolder("") }
          : view !== "timeline"
            ? { label: t("gallery:page.back.gallery"), onClick: () => goToView("timeline") }
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
  useEffect(() => { if (!selectedSlideshow) { setBrowseOpen(false); setSlideshowCoverPickerOpen(false); setMovieDeleteOpen(false); } }, [selectedSlideshow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set `saved` on one asset wherever it is currently loaded. A photo can sit in
  // several lists at once (the timeline, a folder, a person, an album, an "on this
  // day" group), and the lightbox reads `saved` off these same objects — so
  // patching them all is what makes a like set on a tile already filled when the
  // photo is opened, with no refetch.
  const setAssetSaved = useCallback((assetId: string, saved: boolean) => {
    const patch = (list: GalleryAsset[]) =>
      (list.some((a) => a.id === assetId) ? list.map((a) => (a.id === assetId ? { ...a, saved } : a)) : list);
    setAssets(patch);
    setFolderAssets(patch);
    setPersonAssets(patch);
    setAlbumAssets(patch);
    setMemories((current) => (current ? { ...current, groups: current.groups.map((g) => ({ ...g, items: patch(g.items) })) } : current));
  }, [setPersonAssets, setAlbumAssets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop one asset from every list it is loaded in, and take it off the counts
  // the "Load more" buttons read. The photo really is gone, so this is the whole
  // truth of it — and it costs nothing, where re-fetching the view would throw
  // away the pages the visitor had loaded to reach it.
  const removeAsset = useCallback((assetId: string) => {
    const drop = (list: GalleryAsset[]) =>
      (list.some((a) => a.id === assetId) ? list.filter((a) => a.id !== assetId) : list);
    setAssets((current) => {
      if (current.some((a) => a.id === assetId)) setTotal((n) => Math.max(0, n - 1));
      return drop(current);
    });
    setFolderAssets((current) => {
      if (current.some((a) => a.id === assetId)) setFolderTotal((n) => Math.max(0, n - 1));
      return drop(current);
    });
    setPersonAssets(drop);
    setAlbumAssets(drop);
    setMemories((current) => (current
      ? { ...current, groups: current.groups.map((g) => ({ ...g, items: drop(g.items) })) }
      : current));
    setSelectedIds((current) => {
      if (!current.has(assetId)) return current;
      const next = new Set(current);
      next.delete(assetId);
      return next;
    });
  }, [setPersonAssets, setAlbumAssets]); // eslint-disable-line react-hooks/exhaustive-deps

  // What a change made inside the viewer costs the page. A like moves nothing,
  // so it is patched where the photo already sits — reloading the view for it
  // threw away every "Load more" page and, when the photo lived on one of them,
  // closed the viewer under the visitor. A delete takes that one row out.
  // Anything that can reorder or redraw the grid (a rotate, an edited date, a
  // person tagged) still reloads, now keeping the pages that were loaded.
  const handleAssetChange = useCallback((change: GalleryAssetChange) => {
    if (change.kind === "like") { setAssetSaved(change.id, change.saved); return; }
    if (change.kind === "deleted") { removeAsset(change.id); void loadLibraries(); return; }
    refreshView();
  }, [setAssetSaved, removeAsset, loadLibraries, refreshView]);

  // The tile heart. Optimistic — the point of the control is that it costs one tap
  // and no waiting — and rolled back with a message if the request fails.
  const toggleAssetLike = useCallback(async (asset: GalleryAsset, next: boolean) => {
    setAssetSaved(asset.id, next);
    try {
      await api(`/api/library/books/${asset.id}/save`, next
        ? { method: "PUT", body: JSON.stringify({ note: null }) }
        : { method: "DELETE" });
    } catch (err) {
      setAssetSaved(asset.id, !next);
      setError(err instanceof Error ? err.message : t("gallery:page.errors.updateLikes"));
    }
  }, [setAssetSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bulk like: one request for the whole selection. Items in libraries the
  // user can't like (shouldn't happen from this UI) come back as skipped.
  const bulkLike = async () => {
    setBulkBusy(true);
    setBulkError("");
    try {
      const result = await api<{ saved: number; forbidden: number }>(
        "/api/library/books/bulk-save",
        { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
      );
      exitSelection();
      const parts = [t("gallery:bulk.likedNotice", { count: result.saved })];
      if (result.forbidden > 0) parts.push(t("gallery:bulk.skippedNotice", { count: result.forbidden }));
      setNotice(`${parts.join(" · ")}.`);
      refreshView();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : t("gallery:bulk.errors.like"));
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmBulkDelete = async () => {
    setBulkBusy(true);
    setBulkError("");
    try {
      const result = await sendInBatches<{ deleted: number; forbidden: number; locked: number; failed: number }>(
        [...selectedIds],
        (bookIds) => api("/api/library/books/bulk-delete", {
          method: "POST",
          body: JSON.stringify({ bookIds })
        })
      );
      setBulkDeleteOpen(false);
      exitSelection();
      const parts: string[] = [t("gallery:bulk.movedNotice", { count: result.deleted })];
      if (result.forbidden > 0) parts.push(t("gallery:bulk.skippedPermissionNotice", { count: result.forbidden }));
      if (result.locked > 0) parts.push(t("gallery:bulk.lockedFoldersNotice", { count: result.locked }));
      if (result.failed > 0) parts.push(t("gallery:bulk.failedNotice", { count: result.failed }));
      setNotice(`${parts.join(" · ")}.`);
      refreshView();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : t("gallery:bulk.errors.delete"));
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

  const folderCountLabel = t("gallery:common.counts.item", { count: folderTotal });
  const folderSubtitle = loading && folders.length === 0 && folderTotal === 0
    ? t("gallery:folders.browsing")
    : folders.length === 0
      ? folderCountLabel
      // Loose files at this level are worth calling out separately; with none (the
      // usual shape of a library root) the subtree count alone reads better.
      : folderTotal === 0
        ? t("gallery:folders.itemsInFoldersTemplate", {
            items: t("gallery:common.counts.item", { count: folderSubtreeTotal }),
            folders: t("gallery:common.counts.folder", { count: folders.length })
          })
        : t("gallery:folders.hereWithSubTemplate", {
            here: folderCountLabel,
            subtree: t("gallery:common.counts.item", { count: folderSubtreeTotal })
          });
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
    ? t("gallery:mapView.subtitleOnMap", { count: mapPoints.length })
    : view === "people"
      // An open person shows its own count under its cover title too — see
      // the album/slideshow cases below.
      ? (selectedPerson ? undefined : t("gallery:common.counts.person", { count: shownPeople.length }))
      : view === "memories"
        ? t("gallery:memories.subtitle", { count: memoriesTotal })
        : view === "albums"
          // An open album shows its own count under its cover title too — see
          // the slideshow case below.
          ? (selectedAlbum ? undefined : t("gallery:common.counts.album", { count: shownAlbums.length }))
          : view === "slideshows"
            // An open slideshow shows its own count under its cover title — the
            // page-level subtitle would just be saying it a second time.
            ? (selectedSlideshow ? undefined : t("gallery:common.counts.slideshow", { count: shownSlideshows.length }))
          : view === "timeline"
            ? t("gallery:common.counts.item", { count: total })
            : folderSubtitle;

  // Ordinary links to ordinary addresses. Memories and Map only appear when there
  // is something behind them — no memories on file, nothing geotagged in scope —
  // which is why they are the two conditional entries.
  const galleryNavItems: SectionNavItem[] = [
    { key: "timeline", label: VIEW_TITLES.timeline, href: galleryHref("timeline"), icon: CalendarDays },
    ...((memories?.groups.length ?? 0) > 0
      ? [{ key: "memories", label: VIEW_TITLES.memories, href: galleryHref("memories"), icon: Sparkles }]
      : []),
    { key: "albums", label: VIEW_TITLES.albums, href: galleryHref("albums"), icon: Album },
    { key: "slideshows", label: VIEW_TITLES.slideshows, href: galleryHref("slideshows"), icon: Film },
    { key: "folder", label: VIEW_TITLES.folder, href: galleryHref("folder"), icon: FolderOpen },
    { key: "people", label: VIEW_TITLES.people, href: galleryHref("people"), icon: Users },
    ...(mapCount > 0
      ? [{ key: "map", label: VIEW_TITLES.map, href: galleryHref("map"), icon: MapPin }]
      : []),
    // The Photo Inbox review page, only when there is an Inbox to review — its
    // library is flagged, and the page is the one place its photos are shown.
    ...(libraries.some((library) => library.inbox)
      ? [{ key: "inbox", label: t("gallery:inbox.title"), href: galleryInboxHref(null), icon: Inbox }]
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
        ref={viewMenu.triggerRef}
        type="button"
        className="audiobook-library-tab"
        onClick={viewMenu.toggle}
        aria-haspopup="menu"
        aria-expanded={viewMenu.open}
        aria-label={t("gallery:page.toolbar.browseViewsAria")}
      >
        <Compass size={19} aria-hidden="true" />
        <span>{t("common:common.browse")}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {viewMenu.open && viewMenu.pos && createPortal(
        <div
          ref={viewMenu.menuRef}
          className="book-detail-action-menu audiobook-library-menu"
          role="menu"
          aria-label={t("common:common.browse")}
          style={{ position: "fixed", top: viewMenu.pos.top, left: viewMenu.pos.left ?? undefined, right: viewMenu.pos.right ?? undefined }}
        >
          {/* The phone's version of the left nav, off the same list, so a view
              added there appears here too. */}
          {galleryNavItems.map((item) => {
            // Every gallery view names an icon; the type allows one without
            // (a reorderable nav group draws a grip there instead).
            const Icon = item.icon;
            if (!Icon) return null;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={view === item.key ? "active" : ""}
                onClick={() => { viewMenu.close(); navigate(item.href); }}
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
      <span>{t("gallery:page.toolbar.newAlbum")}</span>
    </Button>
  ) : view === "slideshows" && !selectedSlideshow ? (
    <Button variant="primary" onClick={() => setSlideshowCreateOpen(true)}>
      <Plus size={16} aria-hidden="true" />
      <span>{t("gallery:page.toolbar.newSlideshow")}</span>
    </Button>
  ) : null;

  // Everything a grid of selectable photos needs from the page.
  const tiles = { selectionMode, selectedIds, toggleSelect, toggleAssetLike, openLightbox };
  // What the bulk verbs open: each clears the last bulk error first.
  const openBulk = (open: () => void) => () => { setBulkError(""); open(); };

  return (
    <DashboardShell
      active="gallery"
      sideNav={<SectionNav ariaLabel={t("common:nav.gallery")} groupLabel={t("common:nav.gallery")} items={galleryNavItems} activeKey={view} />}
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

        {error && <MessageBox tone="error" title={t("gallery:page.errors.galleryErrorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("gallery:page.notices.galleryUpdatedTitle")}>{notice}</MessageBox>}
        {/* Like/collection failures surface here — the delete flow shows its
            own error inside the confirm dialog. */}
        {bulkError && !bulkDeleteOpen && <MessageBox tone="error" title={t("gallery:page.errors.unableToUpdateTitle")}>{bulkError}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <ImageIcon size={58} aria-hidden="true" />
            <h2>{t("gallery:page.empty.noLibrariesTitle")}</h2>
            {isAdmin ? (
              <>
                <p className="muted">
                  {t("gallery:page.empty.noLibrariesBodyAdmin")}
                </p>
                <a
                  className="primary-button"
                  href="/control/libraries"
                  onClick={(event) => followRoute(event, "/control/libraries")}
                >
                  <LibraryBig size={16} aria-hidden="true" />
                  {t("gallery:page.empty.createLibraryButton")}
                </a>
              </>
            ) : (
              <p className="muted">{t("gallery:page.empty.noLibrariesBodyUser")}</p>
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
                      <GalleryFilterButton facets={facets} value={filters} onChange={changeFilters} libraries={filterLibraries} />
                      <SortMenu
                        value={sort}
                        onChange={setSort}
                        options={SORT_OPTIONS}
                        ariaLabel={t("gallery:page.toolbar.sortTimelineAria")}
                        presentation="labelled"
                      />
                      {/* One menu, two settings — how big the tiles are, and (on
                          the timeline) whether they come in dated sections. Both
                          are visible on screen already, so the trigger says
                          "View" rather than printing back what you can see.
                          Folders has no dates to group by, so it gets the size
                          section alone. */}
                      <SortMenu
                        ariaLabel={t("gallery:page.toolbar.viewLabel")}
                        label={t("gallery:page.toolbar.viewLabel")}
                        presentation="labelled"
                        icon={<LayoutGrid size={18} aria-hidden="true" />}
                        groups={[
                          {
                            heading: t("gallery:page.toolbar.tileSizeHeading"),
                            value: viewPrefs.tileSize,
                            options: getTileSizeOptions(),
                            onChange: (value) => setViewPrefs((prefs) => ({ ...prefs, tileSize: value as GalleryTileSize }))
                          },
                          ...(view === "timeline" ? [{
                            heading: t("gallery:page.toolbar.datesHeading"),
                            value: viewPrefs.grouping,
                            options: getGroupingOptions(),
                            onChange: (value: string) => setViewPrefs((prefs) => ({ ...prefs, grouping: value as GalleryGrouping }))
                          }] : [])
                        ]}
                      />
                    </>
                  )}
                  {/* Memories, Map and People have nothing to narrow but which
                      libraries they draw from — Filter renders just that one
                      section, and only once there's more than one library to
                      choose between (GalleryFilterButton hides it otherwise,
                      which would leave the button with nothing behind it; on
                      People the whole row goes with it, see showToolbar). */}
                  {(view === "memories" || view === "map" || view === "people") && libraries.length > 1 && (
                    <GalleryFilterButton facets={null} value={filters} onChange={changeFilters} fields={["libraries"]} libraries={filterLibraries} />
                  )}
                  {/* Nothing narrows the other list views, so there is nothing to
                      divide the acting controls from. */}
                  {browsingPhotos && <span className="library-toolbar-divider" aria-hidden="true" />}
                  {/* Selection is not delete-gated: liking and adding to a
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
                      <span className="toolbar-label">{t("gallery:common.select")}</span>
                    </button>
                  )}
                  {/* Everywhere but People, which is a page about faces: the
                      photos they were found in are uploaded from the views that
                      show photos. */}
                  {uploadLibraries.length > 0 && view !== "people" && (
                    <button
                      type="button"
                      // The view's own Create outranks it when there is one, so
                      // only one control in the row is filled.
                      className={`library-toolbar-button${primaryAction ? "" : " primary"}`}
                      onClick={() => { setNotice(""); setUploadOpen(true); }}
                    >
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:page.toolbar.upload")}</span>
                    </button>
                  )}
                  {primaryAction}
                </>
              }
              selection={selectionMode ? {
                count: selectedIds.size,
                actions: (
                  <GallerySelectionActions
                    selectedCount={selectedIds.size}
                    selectableCount={displayedAssets.length}
                    busy={bulkBusy}
                    canShareAny={canShareAny}
                    canWriteAny={canWriteAny}
                    canDeleteAny={canDeleteAny}
                    onSelectAll={() => setSelectedIds(new Set(displayedAssets.map((asset) => asset.id)))}
                    onLike={() => void bulkLike()}
                    onAddToAlbum={openBulk(() => setBulkAlbumOpen(true))}
                    onAddToSlideshow={openBulk(() => setBulkSlideshowOpen(true))}
                    onAddToCollection={openBulk(() => setBulkCollectionOpen(true))}
                    onShare={openBulk(() => setShareIds([...selectedIds]))}
                    onTag={openBulk(() => setBulkTagsOpen(true))}
                    onDate={openBulk(() => setBulkDateOpen(true))}
                    onPlace={openBulk(() => setBulkLocationOpen(true))}
                    onAskSomeone={openBulk(() => setAskSomeone({ kind: "items", itemIds: [...selectedIds] }))}
                    onDelete={openBulk(() => setBulkDeleteOpen(true))}
                    onDone={exitSelection}
                  />
                )
              } : null}
            />
            )}

            {/* An active filter has to be legible wherever it is in force, not only
                on the timeline: a library carried over from there (or seeded by a
                "?library=" deep link) narrowed Folders and People with nothing on
                screen to say so, and People has no toolbar to show a count either.
                Each view lists the facets it actually applies — Folders, Memories
                and People are scoped by library alone, the Map by library and media
                type — so the row never claims a filter the view is ignoring. An
                open person is left out: their photo grid is the whole person, not
                the current scope. */}
            {chipFields.shown && (
              <GalleryFilterChips value={filters} onChange={changeFilters} fields={chipFields.fields} libraries={filterLibraries} />
            )}

            {view === "timeline" && filters.people.length >= 2 && (
              <div className="gallery-people-match">
                <ToggleSwitch checked={peopleMatchAll} onChange={setPeopleMatchAll} label={t("gallery:filter.peopleMatchAllToggle")} />
              </div>
            )}

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title={t("gallery:page.notices.scanningTitle")}>{t("gallery:page.notices.scanningBody")}</MessageBox>
            )}

            {view === "map" ? (
              <>
                <Suspense fallback={<p className="management-empty">{t("gallery:common.loading")}</p>}>
                  <GalleryMap points={mapPoints} onOpen={openAssetById} />
                </Suspense>
                {!loading && mapPoints.length === 0 && (
                  <p className="management-empty">{filters.kinds.length > 0 ? t("gallery:mapView.emptyNoLocationOfType") : t("gallery:mapView.emptyNoLocation")}</p>
                )}
              </>
            ) : view === "people" ? (
              <PeopleView
                peopleState={peopleState}
                shownPeople={shownPeople}
                nameTerm={nameTerm}
                loading={loading}
                isAdmin={isAdmin}
                canCuratePeople={canCuratePeople}
                setNotice={setNotice}
                toggleAssetLike={toggleAssetLike}
                openLightbox={openLightbox}
              />
            ) : view === "albums" ? (
              <AlbumsView
                albumsState={albumsState}
                shownAlbums={shownAlbums}
                loading={loading}
                isMobile={isMobile}
                setSelectionMode={setSelectionMode}
                startSlideshow={startSlideshow}
                setSendToSubject={setSendToSubject}
                setNotice={setNotice}
                {...tiles}
              />
            ) : view === "slideshows" ? (
              <SlideshowsView
                slideshowsState={slideshowsState}
                shownSlideshows={shownSlideshows}
                memorySuggestions={memorySuggestions}
                openSuggestionPreview={openSuggestionPreview}
                nameTerm={nameTerm}
                loading={loading}
                openLightbox={openLightbox}
                startSlideshow={startSlideshow}
                setSendToSubject={setSendToSubject}
                setNotice={setNotice}
                onOpenMovieLibrary={() => setMovieLibraryOpen(true)}
              />
            ) : view === "memories" ? (
              <MemoriesView
                memories={memories}
                toggleDaySelect={toggleDaySelect}
                canShareAny={canShareAny}
                onShare={setShareIds}
                {...tiles}
              />
            ) : view === "timeline" ? (
              <TimelineView
                assets={assets}
                total={total}
                loading={loading}
                sort={sort}
                grouping={viewPrefs.grouping}
                gridClass={gridClass}
                query={query}
                filters={filters}
                memories={memories}
                openMemoryYear={openMemoryYear}
                toggleDaySelect={toggleDaySelect}
                canShareAny={canShareAny}
                onShare={setShareIds}
                onLoadMore={() => void loadTimeline(assets.length)}
                {...tiles}
              />
            ) : (
              <FoldersView
                browse={folderBrowse}
                admin={folderAdmin}
                folderQuery={folderQuery}
                setSearchText={setSearchText}
                soleLibraryId={soleLibraryId}
                isAdmin={isAdmin}
                setAskSomeone={setAskSomeone}
                gridClass={gridClass}
                loading={loading}
                {...tiles}
              />
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
          autoPlay={lightbox.autoPlay}
          transition={lightbox.source === "slideshow" ? selectedSlideshow?.transition : undefined}
          transitionSeconds={lightbox.source === "slideshow" ? selectedSlideshow?.transitionSeconds : undefined}
          initialInterval={lightbox.source === "slideshow" ? selectedSlideshow?.slideSeconds : undefined}
          musicUrl={lightbox.source === "slideshow" ? selectedSlideshow?.musicUrl ?? undefined : undefined}
          onClose={closeLightbox}
          onIndexChange={(next) => setLightbox((current) => (current ? { ...current, index: next } : current))}
          onChanged={handleAssetChange}
          onOpenFolder={openAssetFolder}
        />
      )}

      {uploadOpen && uploadLibraries.length > 0 && (
        <GalleryUploadModal
          libraries={uploadLibraries}
          onClose={() => setUploadOpen(false)}
          onUploaded={(count, libraryName) => {
            setUploadOpen(false);
            setNotice(t("gallery:page.notices.uploadedNotice", { count, library: libraryName }));
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

      {sendToSubject && (
        <SendToSheet
          subject={sendToSubject}
          onClose={() => setSendToSubject(null)}
        />
      )}

      {askSomeone && (
        <AskSomeoneModal
          source={askSomeone}
          defaultName={askSomeone.kind === "folder"
            ? (askSomeone.path.split("/").pop() || askSomeone.path || t("gallery:albums.askDefaultName", { count: folderTotal }))
            : t("gallery:albums.askDefaultName", { count: askSomeone.itemIds.length })}
          onClose={() => setAskSomeone(null)}
          onAsk={(album) => {
            setAskSomeone(null);
            exitSelection();
            void loadAlbums();
            setSendToSubject({ entityType: "gallery_album", entityId: album.id, askNotes: true });
          }}
          onMyself={(album) => {
            setAskSomeone(null);
            exitSelection();
            navigate(galleryReviewAlbumHref(album.id));
          }}
        />
      )}

      {bulkAlbumOpen && (
        <AddToAlbumModal
          itemIds={[...selectedIds]}
          title={t("gallery:bulk.selectedItemsTitle", { count: selectedIds.size })}
          onClose={() => setBulkAlbumOpen(false)}
          onAdded={(albumName, added) => {
            setBulkAlbumOpen(false);
            exitSelection();
            setNotice(t("gallery:albums.addedNotice", { count: added, name: albumName }));
          }}
        />
      )}

      {bulkSlideshowOpen && (
        <AddToSlideshowModal
          itemIds={[...selectedIds]}
          title={t("gallery:bulk.selectedItemsTitle", { count: selectedIds.size })}
          onClose={() => setBulkSlideshowOpen(false)}
          onAdded={(slideshowName, added) => {
            setBulkSlideshowOpen(false);
            exitSelection();
            setNotice(t("gallery:slideshows.addedPhotosNotice", { count: added, name: slideshowName }));
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
            const parts = [t("gallery:bulk.datedNotice", { count: updated })];
            if (noDate > 0) parts.push(t("gallery:bulk.noDateNotice", { count: noDate }));
            if (forbidden > 0) parts.push(t("gallery:bulk.skippedPermissionNotice", { count: forbidden }));
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
            const parts = [t("gallery:bulk.placedNotice", { count: updated })];
            if (forbidden > 0) parts.push(t("gallery:bulk.skippedPermissionNotice", { count: forbidden }));
            setNotice(`${parts.join(" · ")}.`);
            refreshView();
          }}
        />
      )}

      {bulkTagsOpen && (
        <GalleryTagsModal
          itemIds={[...selectedIds]}
          suggestions={facets?.tags ?? []}
          onClose={() => setBulkTagsOpen(false)}
          onApplied={(updated, forbidden, mode, tags) => {
            setBulkTagsOpen(false);
            exitSelection();
            const parts = [
              mode === "add"
                ? t("gallery:bulk.taggedNotice", { count: updated, tags: tags.join(", ") })
                : t("gallery:bulk.untaggedNotice", { count: updated, tags: tags.join(", ") })
            ];
            if (forbidden > 0) parts.push(t("gallery:bulk.skippedPermissionNotice", { count: forbidden }));
            setNotice(`${parts.join(" · ")}.`);
            refreshView();
          }}
        />
      )}

      {previewSuggestion && (
        <SuggestionPreviewModal
          suggestion={previewSuggestion}
          assets={previewAssets}
          onCreate={() => { const suggestion = previewSuggestion; setPreviewSuggestion(null); void createFromMemory(suggestion); }}
          onClose={() => setPreviewSuggestion(null)}
        />
      )}

      {movieDeleteOpen && selectedSlideshow && (
        <DeleteMovieDialog
          savedToLibrary={Boolean(selectedSlideshow.movieSavedToLibrary)}
          busy={movieDeleteBusy}
          onConfirm={() => void deleteSlideshowMovie()}
          onCancel={() => setMovieDeleteOpen(false)}
        />
      )}

      {browseOpen && selectedSlideshow && (
        <PhotoPicker
          title={t("gallery:page.dialogs.addPhotosToTitle", { name: selectedSlideshow.name })}
          endpoint={`/api/library/gallery/slideshows/${selectedSlideshow.id}/items`}
          existingIds={slideshowAssets.map((asset) => asset.id)}
          onClose={() => setBrowseOpen(false)}
          onAdded={(added) => {
            if (added > 0) {
              setNotice(t("gallery:page.dialogs.addedPhotosNotice", { count: added, name: selectedSlideshow.name }));
              void openSlideshow(selectedSlideshow.id);
            }
          }}
        />
      )}

      {albumBrowseOpen && selectedAlbum && (
        <PhotoPicker
          title={t("gallery:page.dialogs.addPhotosToTitle", { name: selectedAlbum.name })}
          endpoint={`/api/library/gallery/albums/${selectedAlbum.id}/items`}
          existingIds={albumAssets.map((asset) => asset.id)}
          onClose={() => setAlbumBrowseOpen(false)}
          onAdded={(added) => {
            if (added > 0) {
              setNotice(t("gallery:page.dialogs.addedPhotosNotice", { count: added, name: selectedAlbum.name }));
              void openAlbum(selectedAlbum.id);
            }
          }}
        />
      )}

      {slideshowCreateOpen && (
        <CreateSlideshowModal
          name={slideshowNewName}
          busy={slideshowBusy}
          onNameChange={setSlideshowNewName}
          onSubmit={() => void createSlideshowSubmit()}
          onClose={() => setSlideshowCreateOpen(false)}
        />
      )}

      {movieLibraryOpen && selectedSlideshow && slideshowSettings && (
        <SlideshowMovieLibraryModal
          slideshow={selectedSlideshow}
          libraries={slideshowSettings.libraries}
          defaultLibraryId={slideshowSettings.defaultLibraryId}
          onClose={() => setMovieLibraryOpen(false)}
          onPatch={async (fields) => { await patchSlideshow(selectedSlideshow.id, fields); }}
          onSaved={(message) => setNotice(message)}
        />
      )}

      {slideshowDeleteOpen && selectedSlideshow && (
        <DeleteSlideshowDialog
          name={selectedSlideshow.name}
          savedToLibrary={Boolean(selectedSlideshow.movieSavedToLibrary)}
          busy={slideshowBusy}
          onConfirm={confirmDeleteSlideshow}
          onCancel={() => setSlideshowDeleteOpen(false)}
        />
      )}

      {albumCreateOpen && (
        <CreateAlbumModal
          name={albumNewName}
          description={albumNewDesc}
          busy={albumBusy}
          onNameChange={setAlbumNewName}
          onDescriptionChange={setAlbumNewDesc}
          onSubmit={() => void createAlbumSubmit()}
          onClose={() => setAlbumCreateOpen(false)}
        />
      )}

      {coverPickerOpen && selectedAlbum && (
        <CoverPickerModal
          hint={t("gallery:albums.coverPickerHint")}
          emptyText={t("gallery:albums.coverPickerEmpty")}
          assets={albumAssets}
          coverItemId={selectedAlbum.coverItemId}
          onPick={(assetId) => void setAlbumCover(selectedAlbum.id, assetId)}
          onClose={() => setCoverPickerOpen(false)}
        />
      )}

      {slideshowCoverPickerOpen && selectedSlideshow && (
        <CoverPickerModal
          hint={t("gallery:slideshows.coverPickerHint")}
          emptyText={t("gallery:slideshows.coverPickerEmpty")}
          assets={slideshowAssets}
          coverItemId={selectedSlideshow.coverItemId}
          onPick={(assetId) => void setSlideshowCover(selectedSlideshow.id, assetId)}
          onClose={() => setSlideshowCoverPickerOpen(false)}
        />
      )}

      {personCoverPickerOpen && selectedPerson && (
        <CoverPickerModal
          hint={selectedPerson.name ? t("gallery:people.coverPickerHintNamed", { name: selectedPerson.name }) : t("gallery:people.coverPickerHintGeneric")}
          emptyText={t("gallery:people.coverPickerEmpty")}
          assets={personAssets}
          coverItemId={selectedPerson.coverItemId}
          onPick={(assetId) => void setPersonCover(selectedPerson.id, assetId)}
          onClose={() => setPersonCoverPickerOpen(false)}
        />
      )}

      {albumDeleteOpen && selectedAlbum && (
        <DeleteAlbumDialog
          name={selectedAlbum.name}
          busy={albumBusy}
          onConfirm={() => void confirmDeleteAlbum()}
          onCancel={() => setAlbumDeleteOpen(false)}
        />
      )}

      {bulkCollectionOpen && (
        <AddToCollectionModal
          entityType="gallery"
          entityIds={[...selectedIds]}
          title={t("gallery:bulk.selectedItemsTitle", { count: selectedIds.size })}
          onClose={() => setBulkCollectionOpen(false)}
          onAdded={(collectionName, added) => {
            setBulkCollectionOpen(false);
            exitSelection();
            setNotice(t("gallery:bulk.addedToCollectionNotice", { count: added, name: collectionName }));
          }}
        />
      )}

      {bulkDeleteOpen && (
        <BulkDeleteDialog
          count={selectedIds.size}
          busy={bulkBusy}
          error={bulkError}
          onConfirm={() => void confirmBulkDelete()}
          onCancel={() => setBulkDeleteOpen(false)}
        />
      )}

      {personDeleteOpen && selectedPerson && (
        <DeletePersonDialog
          name={selectedPerson.name}
          onConfirm={() => void confirmDeletePerson()}
          onCancel={() => setPersonDeleteOpen(false)}
        />
      )}
    </DashboardShell>
  );
}
