import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Folder, FolderOpen, Image as ImageIcon, Play } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { FileUpload } from "../../shared/FileUpload";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset, GalleryFolder, GalleryLibrary } from "../gallery/types";

// Where family-tree uploads land, and whether this viewer may put files there.
export interface FamilyUploadSettings {
  galleryLibrary: { id: string; name: string } | null;
  canUpload: boolean;
  isAdmin: boolean;
}

type PickerTab = "browse" | "face" | "upload";

const FACE_PAGE = 120;

// Browse the galleries by folder and pick photos/videos for a family member —
// the slideshow photo browser's flow (breadcrumbs, cross-folder multi-select,
// "Added" badges) pointed at the family-tree attach endpoint. `single` turns it
// into a one-click chooser (used to pick a portrait).
export function FamilyPhotoPicker({
  title,
  existingIds = [],
  single = false,
  facePerson = null,
  onPickSingle,
  onAttach,
  onClose
}: {
  title: string;
  /** Item ids already attached — shown as "Added", not re-selectable. */
  existingIds?: string[];
  /** One-click mode: pick a single asset and close (portrait choice). */
  single?: boolean;
  /** The linked gallery person, when there is one: adds a tab listing every
      photo the face scan matched to them, which beats hunting through folders. */
  facePerson?: { id: string; name: string } | null;
  onPickSingle?: (asset: GalleryAsset) => void;
  /** Multi mode: attach the selection (ids + their asset objects, so callers
      can stage thumbnails without refetching); resolves when accepted. */
  onAttach?: (itemIds: string[], assets: GalleryAsset[]) => Promise<void>;
  onClose: () => void;
}) {
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [scope, setScope] = useState<string>("all"); // "all" or a gallery library id
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(() => new Set(existingIds));
  const [adding, setAdding] = useState(false);
  // Browse picks from what the gallery already holds, Face lists what the scan
  // matched to the linked person, and Upload adds new files to the library the
  // family tree is configured to use, then attaches them.
  const [tab, setTab] = useState<PickerTab>(facePerson ? "face" : "browse");
  const [uploadSettings, setUploadSettings] = useState<FamilyUploadSettings | null>(null);
  const [uploadNotice, setUploadNotice] = useState("");
  const [faceAssets, setFaceAssets] = useState<GalleryAsset[]>([]);
  const [faceTotal, setFaceTotal] = useState(0);
  const [faceLoading, setFaceLoading] = useState(false);

  useEffect(() => {
    api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch(() => {}); // scope select just stays on "All libraries"
    // Both modes need this: it decides whether an Upload tab exists at all.
    api<FamilyUploadSettings>("/api/family-tree/settings")
      .then(setUploadSettings)
      .catch(() => {}); // no settings, no Upload tab
  }, []);

  const load = useCallback(async (nextScope: string, nextParent: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ parent: nextParent, limit: "300" });
      if (nextScope === "all") params.set("scope", "all");
      else { params.set("scope", "library"); params.set("libraryId", nextScope); }
      const payload = await api<{ parent: string; folders: GalleryFolder[]; assets: GalleryAsset[] }>(
        `/api/library/gallery/folders?${params}`
      );
      setFolders(payload.folders);
      setAssets(payload.assets);
      setParent(payload.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(scope, ""); }, [scope, load]);

  // The linked person's matches, paged like the gallery's own person view — a
  // well-photographed relative can have thousands.
  const loadFaces = useCallback(async (offset: number) => {
    if (!facePerson) return;
    setFaceLoading(true);
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/people/${facePerson.id}?limit=${FACE_PAGE}&offset=${offset}`
      );
      setFaceAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setFaceTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this person's photos");
    } finally {
      setFaceLoading(false);
    }
  }, [facePerson]);

  useEffect(() => { if (facePerson) void loadFaces(0); }, [facePerson, loadFaces]);

  const breadcrumbParts = useMemo(() => (parent ? parent.split("/") : []), [parent]);

  // Selection can span folders, so remember each selected asset object — the
  // current folder's `assets` alone can't resolve ids picked elsewhere.
  const [selectedAssets, setSelectedAssets] = useState<Map<string, GalleryAsset>>(new Map());

  const toggle = (asset: GalleryAsset) => {
    if (single) {
      onPickSingle?.(asset);
      return;
    }
    if (added.has(asset.id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
      return next;
    });
    setSelectedAssets((prev) => {
      const next = new Map(prev);
      if (next.has(asset.id)) next.delete(asset.id); else next.set(asset.id, asset);
      return next;
    });
  };

  const attachSelected = async () => {
    const ids = [...selected].filter((id) => !added.has(id));
    if (ids.length === 0 || !onAttach) return;
    setAdding(true);
    setError("");
    try {
      await onAttach(ids, ids.map((id) => selectedAssets.get(id)).filter((a): a is GalleryAsset => a != null));
      setAdded((prev) => new Set([...prev, ...ids]));
      setSelected(new Set());
      setSelectedAssets(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the photos");
    } finally {
      setAdding(false);
    }
  };

  // Uploading needs a destination, which an admin nominates once in the family
  // tree's settings — browsing works across every gallery, but a new file has
  // to land somewhere specific. No destination (or no permission to write to
  // it) means no Upload tab at all: a tab that can only apologise is worse than
  // no tab, and attaching what the gallery already holds still works.
  const uploadTarget = uploadSettings?.galleryLibrary ?? null;
  const uploadLibrary = uploadTarget ? libraries.find((l) => l.id === uploadTarget.id) : undefined;
  const canUploadHere = Boolean(uploadTarget && uploadSettings?.canUpload && uploadLibrary);
  const activeTab: PickerTab = tab === "upload" && !canUploadHere ? "browse" : tab;

  const uploadFinished = async (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    setAdding(true);
    setError("");
    try {
      // Fetch what was just uploaded so callers that stage thumbnails locally
      // (the event editor) get real assets, not bare ids.
      const assets = (await Promise.all(itemIds.map((id) =>
        api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${id}`).then((p) => p.asset).catch(() => null)
      ))).filter((a): a is GalleryAsset => a != null);
      // Portrait mode: the file is now a gallery item like any other, so the
      // caller sets it the same way it sets a browsed one.
      if (single) {
        if (assets[0]) onPickSingle?.(assets[0]);
        else setError("Uploaded, but the picture couldn't be read back to set as the portrait.");
        return;
      }
      if (!onAttach) return;
      await onAttach(itemIds, assets);
      setAdded((prev) => new Set([...prev, ...itemIds]));
      setUploadNotice(`${itemIds.length} ${itemIds.length === 1 ? "file" : "files"} uploaded and attached.`);
      void load(scope, parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uploaded, but attaching failed");
    } finally {
      setAdding(false);
    }
  };

  // One tile grid for both picking surfaces (folder browse and face matches).
  const assetGrid = (list: GalleryAsset[]) => (
    <div className="gallery-grid">
      {list.map((asset) => {
        const isAdded = !single && added.has(asset.id);
        const isSelected = !single && selected.has(asset.id);
        return (
          <button
            key={asset.id}
            type="button"
            className={`gallery-tile slideshow-browse-tile${isAdded ? " is-added" : isSelected ? " is-selected" : ""}`}
            onClick={() => toggle(asset)}
            disabled={isAdded || adding}
            aria-pressed={isSelected}
            title={isAdded ? "Already added" : asset.title}
          >
            {asset.coverUrl ? <img src={asset.coverUrl} alt="" loading="lazy" /> : (
              <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
            )}
            {asset.kind === "video" && <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>}
            {isAdded ? (
              <span className="slideshow-browse-badge added">Added</span>
            ) : isSelected ? (
              <span className="slideshow-browse-badge selected"><Check size={16} aria-hidden="true" /></span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const librarySelect = activeTab === "browse" ? (
    <label className="slideshow-browse-scope">
      <span className="sr-only">Gallery library</span>
      <select value={scope} onChange={(e) => { setScope(e.target.value); }} disabled={adding}>
        <option value="all">All libraries</option>
        {libraries.map((library) => (
          <option key={library.id} value={library.id}>{library.name}</option>
        ))}
      </select>
    </label>
  ) : undefined;

  return (
    <Modal
      variant="panel"
      title={title}
      icon={<FolderOpen size={20} />}
      className="add-to-album-modal slideshow-browse-modal"
      busy={adding}
      headerAction={librarySelect}
      onClose={onClose}
    >
      <div className="modal-tabs">
        {facePerson && (
          <button
            type="button"
            className={`modal-tab${activeTab === "face" ? " active" : ""}`}
            onClick={() => setTab("face")}
          >
            Face matches{faceTotal > 0 ? ` · ${faceTotal}` : ""}
          </button>
        )}
        <button
          type="button"
          className={`modal-tab${activeTab === "browse" ? " active" : ""}`}
          onClick={() => setTab("browse")}
        >
          Browse gallery
        </button>
        {canUploadHere && (
          <button
            type="button"
            className={`modal-tab${activeTab === "upload" ? " active" : ""}`}
            onClick={() => { setTab("upload"); setUploadNotice(""); }}
          >
            Upload
          </button>
        )}
      </div>
      {/* Only an admin can fix a missing destination, so only an admin is told
          why the Upload tab isn't there. */}
      {!canUploadHere && uploadSettings?.isAdmin && (
        <p className="ft-modal-hint ft-upload-off-hint">
          Uploading new files is off until a photo library is chosen in Family tree → Settings → Photo library.
        </p>
      )}

      {activeTab === "upload" && uploadLibrary && uploadTarget ? (
        <div className="modal-tab-content ft-upload-panel">
          {error && <MessageBox tone="error" title="Upload problem">{error}</MessageBox>}
          {uploadNotice && <MessageBox tone="success" title="Added">{uploadNotice}</MessageBox>}
          <p className="ft-modal-hint">
            {single
              ? `The picture is added to “${uploadTarget.name}” and set as the portrait in one step — it lives in the gallery like any other photo.`
              : `Files are added to “${uploadTarget.name}” and attached here in one step. They appear in the gallery too, filed by the date they were taken.`}
          </p>
          <FileUpload
            endpoint={`/api/library/gallery-libraries/${uploadLibrary.id}/assets/upload`}
            accept={uploadLibrary.uploadExtensions}
            maxBytes={uploadLibrary.maxUploadMB != null ? uploadLibrary.maxUploadMB * 1024 * 1024 : null}
            multiple={!single}
            maxFiles={single ? 1 : 100}
            hint={`Accepted: ${uploadLibrary.uploadExtensions.map((ext) => `.${ext}`).join(", ")}${uploadLibrary.maxUploadMB != null ? ` · up to ${uploadLibrary.maxUploadMB} MB per file` : ""}`}
            onUploaded={(response) => {
              const payload = response as { itemIds?: string[] };
              void uploadFinished(payload.itemIds ?? []);
            }}
            onBusyChange={setAdding}
          />
        </div>
      ) : activeTab === "face" && facePerson ? (
        <div className="modal-tab-content add-to-album-body">
          {error && <MessageBox tone="error" title="Unable to add photos">{error}</MessageBox>}
          <p className="ft-modal-hint">
            {single
              ? `Every photo the face scan matched to “${facePerson.name}” — pick one to use as the portrait.`
              : `Every photo the face scan matched to “${facePerson.name}”. Adding one attaches it here for good, so it stays even if the match is later corrected.`}
          </p>
          {faceAssets.length === 0 ? (
            <p className="management-empty">
              {faceLoading ? "Loading…" : "No photos have been matched to this person yet."}
            </p>
          ) : (
            <>
              {assetGrid(faceAssets)}
              {faceAssets.length < faceTotal && (
                <div className="ft-face-more">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={faceLoading || adding}
                    onClick={() => void loadFaces(faceAssets.length)}
                  >
                    {faceLoading ? "Loading…" : `Load more (${faceTotal - faceAssets.length} left)`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
      <>
      <div className="add-to-album-head">
        {error && <MessageBox tone="error" title="Unable to add photos">{error}</MessageBox>}
        <div className="gallery-breadcrumb slideshow-browse-crumbs">
          <button type="button" onClick={() => void load(scope, "")} disabled={adding}>All folders</button>
          {breadcrumbParts.map((part, i) => {
            const target = breadcrumbParts.slice(0, i + 1).join("/");
            return (
              <span key={target} className="slideshow-browse-crumb">
                <ChevronRight size={14} aria-hidden="true" />
                <button type="button" onClick={() => void load(scope, target)} disabled={adding}>{part}</button>
              </span>
            );
          })}
        </div>
      </div>

      <div className="modal-tab-content add-to-album-body">
        {folders.length > 0 && (
          <>
            <p className="gallery-section-label">Folders</p>
            <div className="gallery-folder-grid">
              {folders.map((folder) => (
                <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void load(scope, folder.path)} disabled={adding}>
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

        {assets.length > 0 && (
          <>
            <p className="gallery-section-label">Photos &amp; videos</p>
            {assetGrid(assets)}
          </>
        )}

        {loading && folders.length === 0 && assets.length === 0 && <p className="management-empty">Loading…</p>}
        {!loading && folders.length === 0 && assets.length === 0 && <p className="management-empty">This folder is empty.</p>}
      </div>
      </>
      )}

      {!single && activeTab !== "upload" && (
        <div className="modal-actions slideshow-browse-actions">
          <span className="muted">{selected.size > 0 ? `${selected.size} selected` : "Select photos to add"}</span>
          <div className="row-actions">
            <button type="button" className="secondary-button compact-button" onClick={onClose} disabled={adding}>Done</button>
            <button type="button" className="primary-button compact-button" onClick={() => void attachSelected()} disabled={selected.size === 0 || adding}>
              {adding ? "Adding…" : selected.size === 1 ? "Add 1 photo" : `Add ${selected.size} photos`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
