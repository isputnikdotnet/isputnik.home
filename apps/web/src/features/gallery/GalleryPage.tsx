import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronDown, ChevronRight, FolderOpen, Image as ImageIcon, Images, Play, Heart, Folder, UploadCloud } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader, AudiobookHeaderSort, formatCount } from "../audiobooks/AudiobooksPage";
import type { SortKey } from "../audiobooks/BookFilter";
import { GalleryLightbox } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import type { GalleryAsset, GalleryFolder, GalleryLibrary } from "./types";

const PAGE_SIZE = 80;

type GalleryView = "timeline" | "folder";
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

function AssetTile({ asset, onOpen }: { asset: GalleryAsset; onOpen: () => void }) {
  return (
    <button type="button" className="gallery-tile" onClick={onOpen} aria-label={`Open ${asset.title}`}>
      {asset.coverUrl ? (
        <img src={asset.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
      )}
      {asset.saved && <Heart size={14} className="gallery-fav-dot" fill="currentColor" aria-hidden="true" />}
      {asset.kind === "video" && (
        <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
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

  // Library selector dropdown (mirrors the audiobooks/ebooks main page chip).
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<{ source: "timeline" | "folder" | "single"; index: number } | null>(null);
  const [singleAsset, setSingleAsset] = useState<GalleryAsset | null>(null);

  // Upload (source-writing, policy-gated): the modal is offered when any library
  // accepts uploads. A notice confirms the batch after the modal closes.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState("");

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

  // Reload the active view when scope/kind/query/view changes.
  useEffect(() => {
    if (view === "timeline") void loadTimeline(0);
    else void loadFolder("");
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
      if (view === "timeline") void loadTimeline(0); else void loadFolder(parent);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [libraries, view, parent, loadLibraries, loadTimeline, loadFolder]);

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
    : lightbox?.source === "folder" ? folderAssets : assets;

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
    if (view === "timeline") void loadTimeline(0); else void loadFolder(parent);
    void loadLibraries();
  }, [view, parent, loadTimeline, loadFolder, loadLibraries]);

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
  const subtitle = view === "timeline"
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
              {uploadLibraries.length > 0 && (
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
                </nav>
              </div>
            </div>

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">Thumbnails appear as the scan finishes.</MessageBox>
            )}

            {view === "timeline" ? (
              <>
                {months.map((month) => (
                  <div key={month.label}>
                    <h2 className="gallery-month-label">{month.label}</h2>
                    <div className="gallery-grid">
                      {month.items.map(({ asset, index }) => (
                        <AssetTile key={asset.id} asset={asset} onOpen={() => setLightbox({ source: "timeline", index })} />
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
                        <AssetTile key={asset.id} asset={asset} onOpen={() => setLightbox({ source: "folder", index })} />
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
    </DashboardShell>
  );
}
