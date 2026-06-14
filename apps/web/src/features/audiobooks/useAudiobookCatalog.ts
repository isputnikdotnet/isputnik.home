import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { EMPTY_FILTERS, EMPTY_FACETS, type BookFilters, type FacetOptions, type SortKey } from "./BookFilter";
import type { AudiobookBook } from "./types";

const PAGE_SIZE = 48;

// Per-view catalog UI state kept for the session, so navigating into a book and
// back doesn't reset the chosen library / search / sort / filters. In-memory
// (cleared on a full page reload) — swap to sessionStorage for reload-resilience.
export interface CatalogView {
  selectedLibraryId: string;
  sort: SortKey;
  search: string;
  filters: BookFilters;
}

const DEFAULT_VIEW: CatalogView = { selectedLibraryId: "all", sort: "title", search: "", filters: EMPTY_FILTERS };
const viewStore = new Map<string, CatalogView>();

export function readCatalogView(key: string): CatalogView {
  return viewStore.get(key) ?? DEFAULT_VIEW;
}

export function writeCatalogView(key: string, patch: Partial<CatalogView>) {
  viewStore.set(key, { ...readCatalogView(key), ...patch });
}

export type CatalogScope =
  | { kind: "all" }
  | { kind: "library"; libraryId: string };

interface CatalogResponse<T> {
  books: T[];
  total: number;
}

// The catalog + facets endpoints a media type exposes. Any library type that
// serves a server-side catalog (audiobooks, ebooks, …) supplies its own pair.
export interface CatalogEndpoints {
  catalog: string;
  facets: string;
}

const AUDIOBOOK_ENDPOINTS: CatalogEndpoints = {
  catalog: "/api/library/audiobooks/catalog",
  facets: "/api/library/audiobooks/facets"
};

// Drives the server-side paged catalog: owns search/filters, fetches a page on
// any query change, appends pages for infinite scroll, and loads the scope's
// filter facets. Generic over the book row shape and parameterised by the type's
// endpoints, so every media type reuses it (see useAudiobookCatalog alias).
export function useMediaCatalog<T = AudiobookBook>(
  scope: CatalogScope,
  sort: SortKey,
  persistKey: string,
  endpoints: CatalogEndpoints = AUDIOBOOK_ENDPOINTS
) {
  const [search, setSearch] = useState(() => readCatalogView(persistKey).search);
  const [debounced, setDebounced] = useState(() => readCatalogView(persistKey).search.trim());
  const [filters, setFilters] = useState<BookFilters>(() => readCatalogView(persistKey).filters);

  // Persist the bits this hook owns so they survive a remount within the session.
  useEffect(() => {
    writeCatalogView(persistKey, { search, filters });
  }, [persistKey, search, filters]);
  const [books, setBooks] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<FacetOptions>(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const reqId = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const scopeKey = JSON.stringify(scope);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Filter options for the scope (the panel can't derive them from one page).
  useEffect(() => {
    const params = new URLSearchParams({ scope: scope.kind });
    if (scope.kind === "library") params.set("libraryId", scope.libraryId);
    api<FacetOptions>(`${endpoints.facets}?${params.toString()}`)
      .then(setFacets)
      .catch(() => setFacets(EMPTY_FACETS));
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestBody = useCallback((offset: number) => ({
    scope: scope.kind,
    libraryId: scope.kind === "library" ? scope.libraryId : undefined,
    q: debounced,
    sort,
    limit: PAGE_SIZE,
    offset,
    filters
  }), [scopeKey, debounced, sort, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryKey = JSON.stringify({ scopeKey, debounced, sort, filters, tick });

  // Reset to page 1 whenever the query changes. A request id guards against
  // out-of-order responses (a slow page-1 landing after a newer query).
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError("");
    api<CatalogResponse<T>>(endpoints.catalog, { method: "POST", body: JSON.stringify(requestBody(0)) })
      .then((res) => {
        if (reqId.current !== id) return;
        setBooks(res.books);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err) => {
        if (reqId.current !== id) return;
        setError(err instanceof Error ? err.message : "Unable to load audiobooks");
        setLoading(false);
      });
  }, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMore = books.length < total;

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const id = reqId.current; // tie to the current query
    setLoadingMore(true);
    api<CatalogResponse<T>>(endpoints.catalog, { method: "POST", body: JSON.stringify(requestBody(books.length)) })
      .then((res) => {
        if (reqId.current !== id) return;
        setBooks((prev) => [...prev, ...res.books]);
        setTotal(res.total);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [loading, loadingMore, hasMore, books.length, requestBody]);

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return {
    search, setSearch,
    filters, setFilters,
    books, total, facets,
    loading, loadingMore, hasMore, loadMore,
    sentinelRef, error, refresh
  };
}

// Audiobook-bound alias kept for the audiobooks page (defaults to the audiobook
// endpoints + AudiobookBook row shape).
export const useAudiobookCatalog = useMediaCatalog;
