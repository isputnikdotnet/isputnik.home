import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import type { GalleryView } from "../../../router";
import type { GalleryFilters } from "../GalleryFilter";
import type { GalleryAsset, GalleryLibrary } from "../types";
import { MAX_PAGE_SIZE, PAGE_SIZE, type TimelineSort } from "./gallery-page-model";

// The Timeline's photos: a page at a time for "Load more", or every page already
// loaded at once when something changed underneath them.
export function useTimeline({
  sort,
  query,
  filters,
  peopleMatchAll,
  setLoading,
  setError
}: {
  sort: TimelineSort;
  query: string;
  filters: GalleryFilters;
  peopleMatchAll: boolean;
  setLoading: (busy: boolean) => void;
  setError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);

  // Which libraries this draws from is already inside `filters.libraries` — the
  // POST body's JSON carries it natively, unlike the GET views which need
  // scopeParams()'s query-string form.
  const fetchTimelinePage = useCallback((offset: number, limit: number) =>
    api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
      method: "POST",
      body: JSON.stringify({
        q: query, kinds: filters.kinds,
        filters: { ...filters, peopleMatch: peopleMatchAll ? "all" : "any" },
        sort, limit, offset
      })
    }), [sort, query, filters, peopleMatchAll]);

  const loadTimeline = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const payload = await fetchTimelinePage(offset, PAGE_SIZE);
      setAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:page.errors.loadTimeline"));
    } finally {
      setLoading(false);
    }
  }, [fetchTimelinePage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch everything currently on screen rather than only the first page: a
  // visitor who pressed "Load more" four times should not have those pages
  // silently thrown away by a rotate or an edit — and with the viewer open on a
  // later page, a shrinking list closed it under them. Pages come back in
  // sequence and swap in as one, so the grid never flashes a short list.
  const reloadTimeline = useCallback(async (keep: number) => {
    setLoading(true);
    setError("");
    try {
      const collected: GalleryAsset[] = [];
      let total = 0;
      do {
        const page = await fetchTimelinePage(collected.length, MAX_PAGE_SIZE);
        total = page.total;
        collected.push(...page.assets);
        if (page.assets.length < MAX_PAGE_SIZE) break;
      } while (collected.length < keep);
      setAssets(collected);
      setTotal(total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:page.errors.loadTimeline"));
    } finally {
      setLoading(false);
    }
  }, [fetchTimelinePage]); // eslint-disable-line react-hooks/exhaustive-deps

  return { assets, setAssets, total, setTotal, loadTimeline, reloadTimeline };
}

// While a library is scanning, refresh so new assets/thumbnails appear. Uses
// the "keep loaded pages" reloaders (the same ones the page's refreshView uses)
// rather than resetting to page 1 — otherwise a visitor paging through "Load more"
// during a long scan gets truncated back to the first page every 3.5s.
export function useGalleryScanPoll({
  libraries,
  view,
  parent,
  timelineLoaded,
  folderLoaded,
  loadLibraries,
  reloadTimeline,
  loadFolder,
  loadMemories,
  loadMap
}: {
  libraries: GalleryLibrary[];
  view: GalleryView;
  parent: string;
  /** How many timeline / folder assets are on screen — the pages to keep. */
  timelineLoaded: number;
  folderLoaded: number;
  loadLibraries: () => Promise<void>;
  reloadTimeline: (keep: number) => Promise<void>;
  loadFolder: (parent: string, offset?: number, keep?: number) => Promise<void>;
  loadMemories: () => Promise<void>;
  loadMap: () => Promise<void>;
}) {
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      void loadLibraries();
      if (view === "timeline") void reloadTimeline(timelineLoaded);
      else if (view === "folder") void loadFolder(parent, 0, folderLoaded);
      else if (view === "memories") void loadMemories();
      else if (view === "map") void loadMap();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [libraries, view, parent, timelineLoaded, folderLoaded, loadLibraries, reloadTimeline, loadFolder, loadMemories, loadMap]);
}
