import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api";
import type { GalleryView } from "../../../router";
import { EMPTY_GALLERY_FILTERS, activeGalleryFilterCount, type GalleryFilters } from "../GalleryFilter";
import { galleryGridClass, readGalleryView, writeGalleryView, type GalleryViewPrefs } from "../gallery-view";
import type { GalleryFacets } from "../types";
import type { TimelineSort } from "./gallery-page-model";

// What the gallery is looking at, whichever view is open: the order, how the grid
// looks, the search box and what it means in this view, the filters (the first of
// which is which libraries), and the facets that fill the Filter panel.
export function useGalleryScope({
  view,
  initialLibraryId,
  goToView
}: {
  view: GalleryView;
  initialLibraryId?: string | null;
  goToView: (next: GalleryView) => void;
}) {
  // Seeded from the address so a deep link can ask for a particular order — the
  // home's "New photos" card links to /gallery?sort=added, and the page it opens
  // is then the set that card was advertising. Anything else means the default.
  const [sort, setSort] = useState<TimelineSort>(
    () => (new URLSearchParams(window.location.search).get("sort") === "added" ? "added" : "taken")
  );

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
  // "?library=") seeds it with that one library chosen — for as long as the
  // Folders view is open (see seededLibrary below).
  const [filters, setFilters] = useState<GalleryFilters>(() => ({
    ...EMPTY_GALLERY_FILTERS,
    libraries: initialLibraryId ? [initialLibraryId] : []
  }));
  // Whether the People facet means "any of them" (default, OR — like every other
  // facet) or "all of them together" (AND). Kept outside GalleryFilters/EMPTY_GALLERY_FILTERS
  // since every other facet's value is a plain string[] — FacetFilterButton/Chips
  // are generic over that shape — so this rides along as its own bit of state and
  // is merged into the request's `filters.peopleMatch` at fetch time.
  const [peopleMatchAll, setPeopleMatchAll] = useState(false);
  // That "?library=" seed is the page's own doing, not a choice the visitor made:
  // it exists so the folder tree a deep link points at can be shown at all (folder
  // paths repeat across libraries, and Folders' rescan needs a single one). It must
  // therefore not follow them OUT of the Folders view and quietly narrow the
  // timeline — which is what it did when arriving from the home page's memory
  // viewer or the duplicate-cleanup report. Held until the visitor touches the
  // filter panel (from then on the choice is theirs — see changeFilters) or leaves
  // Folders, whichever comes first.
  const [seededLibrary, setSeededLibrary] = useState<string | null>(initialLibraryId ?? null);
  if (seededLibrary && view !== "folder") {
    // Adjusted during render rather than from an effect on purpose: the view loader
    // keys on `filters`, so clearing afterwards would fire a second timeline fetch
    // racing the first — and the filtered page could be the one that lands last.
    setSeededLibrary(null);
    setFilters((current) => (
      current.libraries.length === 1 && current.libraries[0] === seededLibrary
        ? { ...current, libraries: [] }
        : current
    ));
  }
  // Every filter control goes through this rather than setFilters: the moment the
  // visitor picks anything, the seeded library stops being ours to take away.
  const changeFilters = useCallback((next: GalleryFilters) => {
    setSeededLibrary(null);
    setFilters(next);
  }, []);
  const [facets, setFacets] = useState<GalleryFacets | null>(null);
  // A few actions — rescanning a folder, Folders' own scope — only make sense
  // against exactly one library, the same way Audiobooks only offers "Add to
  // series" once its library filter narrows to one.
  const soleLibraryId = filters.libraries.length === 1 ? filters.libraries[0] : null;

  // Omitted entirely when no library is chosen — every accessible one, same as before.
  const scopeParams = useCallback(() => (
    filters.libraries.length > 0 ? { libraryIds: filters.libraries.join(",") } : {}
  ), [filters.libraries]);

  // The Folders view's own term: the same box searches folder NAMES there.
  const [folderQuery, setFolderQuery] = useState("");

  // Debounce the search box into the query that hits the API — but only where the
  // box means "search the photos". In the Folders view the SAME box searches folder
  // names instead (folderQuery above) — typing there used to yank the page into the
  // Timeline and search the photos, which answered a question nobody standing in a
  // folder tree was asking. On the list views the box is a name filter applied in
  // memory (see nameTerm in the page), and letting it reach `query` would refetch
  // that list on every keystroke, since query is a dependency of the view loader.
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

  // The box means something different in each view — photos here, album names
  // there — so a term does not follow you between them. Cleared on every change
  // of view, including back onto the timeline.
  useEffect(() => {
    setSearchText("");
    setQuery("");
  }, [view]);

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

  return {
    sort, setSort,
    viewPrefs, setViewPrefs, gridClass,
    searchText, setSearchText,
    query, setQuery, folderQuery,
    filters, setFilters, changeFilters,
    peopleMatchAll, setPeopleMatchAll,
    soleLibraryId, scopeParams, facets
  };
}
