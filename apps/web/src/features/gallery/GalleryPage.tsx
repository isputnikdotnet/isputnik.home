import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronRight, FolderOpen, Image as ImageIcon, Play, Heart, Folder } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { GalleryLightbox } from "./GalleryLightbox";
import type { GalleryAsset, GalleryFolder, GalleryLibrary } from "./types";

const PAGE_SIZE = 80;

type GalleryView = "timeline" | "folder";
type KindFilter = "all" | "photo" | "video";

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

  // Timeline state.
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Folder state.
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);

  // Lightbox: which array + index is open. A deep-linked asset opens standalone.
  const [lightbox, setLightbox] = useState<{ source: "timeline" | "folder" | "single"; index: number } | null>(null);
  const [singleAsset, setSingleAsset] = useState<GalleryAsset | null>(null);

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

  const loadTimeline = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
        method: "POST",
        body: JSON.stringify({ ...scopeParams(), kinds: kind === "all" ? [] : [kind], limit: PAGE_SIZE, offset })
      });
      setAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load photos");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, kind]);

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

  // Reload the active view when scope/kind/view changes.
  useEffect(() => {
    if (view === "timeline") void loadTimeline(0);
    else void loadFolder("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scopeId, kind]);

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

  const activeAssets = lightbox?.source === "single" && singleAsset
    ? [singleAsset]
    : lightbox?.source === "folder" ? folderAssets : assets;

  const libraryFor = (libraryId: string) => libraries.find((library) => library.id === libraryId);
  const canDeleteCurrent = lightbox != null && activeAssets[lightbox.index]
    ? libraryFor(activeAssets[lightbox.index].libraryId)?.canDelete ?? false
    : false;

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

  return (
    <DashboardShell active="gallery" user={user} logout={logout}>
      <section className="gallery-page">
        <div className="gallery-header">
          <div>
            <h1>Gallery</h1>
            <p className="gallery-subtitle">
              {view === "timeline" ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}` : "Browsing by folder"}
            </p>
          </div>
          <div className="gallery-toolbar">
            <div className="gallery-viewtoggle" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "timeline"} className={view === "timeline" ? "is-active" : ""} onClick={() => setView("timeline")}>
                <CalendarDays size={16} aria-hidden="true" /> Timeline
              </button>
              <button type="button" role="tab" aria-selected={view === "folder"} className={view === "folder" ? "is-active" : ""} onClick={() => setView("folder")}>
                <FolderOpen size={16} aria-hidden="true" /> Folders
              </button>
            </div>
            {view === "timeline" && (
              <select className="gallery-select" value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} aria-label="Filter by type">
                <option value="all">All media</option>
                <option value="photo">Photos</option>
                <option value="video">Videos</option>
              </select>
            )}
            {libraries.length > 1 && (
              <select className="gallery-select" value={scopeId} onChange={(event) => setScopeId(event.target.value)} aria-label="Select library">
                <option value="all">All libraries</option>
                {libraries.map((library) => (
                  <option key={library.id} value={library.id}>{library.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {error && <MessageBox tone="error" title="Gallery error">{error}</MessageBox>}

        {loaded && libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <ImageIcon size={58} aria-hidden="true" />
            <h2>No gallery libraries yet</h2>
            <p className="muted">An administrator can add a gallery library from the control panel.</p>
          </div>
        ) : libraries.some((library) => library.scanStatus === "scanning") ? (
          <MessageBox tone="info" title="Scanning">Thumbnails appear as the scan finishes.</MessageBox>
        ) : null}

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
            {!loading && assets.length === 0 && <p className="management-empty">No photos or videos to show.</p>}
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
      </section>

      {lightbox && activeAssets[lightbox.index] && (
        <GalleryLightbox
          assets={activeAssets}
          index={lightbox.index}
          canDelete={canDeleteCurrent}
          onClose={closeLightbox}
          onIndexChange={(next) => setLightbox((current) => (current ? { ...current, index: next } : current))}
          onChanged={() => {
            if (view === "timeline") void loadTimeline(0); else void loadFolder(parent);
            void loadLibraries();
          }}
        />
      )}
    </DashboardShell>
  );
}
