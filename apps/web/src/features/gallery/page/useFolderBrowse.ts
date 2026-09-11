import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import type { GalleryView } from "../../../router";
import type { GalleryAsset, GalleryFolder } from "../types";
import { MAX_PAGE_SIZE } from "./gallery-page-model";

// The Folders view's data: the open folder, its subfolders and photos, and the
// folder-NAME search the header's box runs while this view is open.
export function useFolderBrowse({
  view,
  folderQuery,
  scopeParams,
  initialFolder,
  setLoading,
  setError
}: {
  view: GalleryView;
  folderQuery: string;
  scopeParams: () => { libraryIds?: string };
  /** Deep link (/gallery/folders/…): open the Folders view straight into this folder. */
  initialFolder?: string;
  setLoading: (busy: boolean) => void;
  setError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [parent, setParent] = useState("");
  // Whether the folder currently open is itself locked (deletion refused inside).
  const [parentLocked, setParentLocked] = useState(false);
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);
  // Photos/videos sitting DIRECTLY in the open folder (subfolders excluded) — the
  // grid below only holds a page of them, so the count comes from the server.
  const [folderTotal, setFolderTotal] = useState(0);

  // Folder to open on the next switch into the Folders view (set by the lightbox's
  // Folder link); the view-change effect consumes it instead of loading the root.
  const pendingFolderRef = useRef<string | null>(null);
  // A /gallery/folders/… deep link can't use the ref above: the view effect already
  // holds "folder" on mount, and StrictMode invokes it twice — the first pass would
  // consume the ref and the second would fall through to the library root. State
  // survives both passes, and is dropped as soon as the folder view is navigated.
  const [deepLinkFolder, setDeepLinkFolder] = useState<string | null>(initialFolder ?? null);

  // Folder-name search results, replacing the folder browse while a term is typed.
  // null = not searching; the browse state underneath is left alone, so clearing
  // the box lands back exactly where you were.
  const [folderMatches, setFolderMatches] = useState<{ folders: GalleryFolder[]; total: number } | null>(null);

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
        if (!cancelled) setError(err instanceof Error ? err.message : t("gallery:page.errors.searchFolders"));
      }
    })();
    return () => { cancelled = true; };
  }, [view, folderQuery, scopeParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFolderPage = useCallback((nextParent: string, offset: number) => {
    const params = new URLSearchParams({ ...scopeParams(), parent: nextParent, limit: String(MAX_PAGE_SIZE), offset: String(offset) } as Record<string, string>);
    return api<{ parent: string; parentLocked: boolean; folders: GalleryFolder[]; assets: GalleryAsset[]; total: number }>(
      `/api/library/gallery/folders?${params}`
    );
  }, [scopeParams]);

  // `offset` > 0 is the "Load more" path: keep what is on screen and append the
  // next page (the folder list itself is identical, so it is simply re-set).
  // `keep` is the refresh path — re-fetch every page that was loaded, for the
  // same reason the timeline's reload does.
  const loadFolder = useCallback(async (nextParent: string, offset = 0, keep = 0) => {
    // The deep link has served its purpose once a folder is being loaded; from here
    // browsing (and any scope change) starts from the root like a normal visit.
    setDeepLinkFolder((current) => (current === null ? current : null));
    setLoading(true);
    setError("");
    try {
      const payload = await fetchFolderPage(nextParent, offset);
      const collected = [...payload.assets];
      while (collected.length < keep && collected.length < payload.total && payload.assets.length === MAX_PAGE_SIZE) {
        const page = await fetchFolderPage(payload.parent, collected.length);
        if (page.assets.length === 0) break;
        collected.push(...page.assets);
      }
      setFolders(payload.folders);
      setFolderAssets((current) => (offset > 0 ? [...current, ...payload.assets] : collected));
      setFolderTotal(payload.total);
      setParent(payload.parent);
      setParentLocked(payload.parentLocked);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:page.errors.loadFolder"));
    } finally {
      setLoading(false);
    }
  }, [fetchFolderPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Folder counts: what sits directly here, and — when there are subfolders — the
  // whole subtree, so the number matches what the folder's tile advertised.
  const folderSubtreeTotal = folderTotal + folders.reduce((sum, folder) => sum + folder.assetCount, 0);

  return {
    parent, parentLocked, setParentLocked,
    folders, folderAssets, setFolderAssets, folderTotal, setFolderTotal, folderSubtreeTotal,
    pendingFolderRef, deepLinkFolder,
    folderMatches, loadFolder
  };
}
