import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Folder, FolderOpen, Image as ImageIcon, Play, Search, Tag, User, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { EMPTY_GALLERY_FILTERS } from "./GalleryFilter";
import type { GalleryAsset, GalleryFolder, GalleryLibrary, GalleryPerson } from "./types";
import { faceFocusStyle } from "./types";

// The standard photo picker: one modal for choosing gallery photos/videos from
// anywhere in the app. Four ways in — browse by folder, by person (face
// clusters), by tag, or straight through all photos — with one search box and
// one selection that persists across all of them, gathered in a tray along the
// bottom. Successor to GalleryFolderPicker (folders only), built to absorb the
// family tree's FamilyPhotoPicker next.
//
// Everything rides existing endpoints: /folders + /folders/search for the tree,
// /people + /people/:id for the clusters, /facets for the tag list, and the
// timeline query (POST /timeline) for tags, all-photos and text search.
//
// `pick: "video"` turns it into a single-choice VIDEO picker (the slideshow's
// opening/closing clips): photos dim, tapping a video hands it to `onPick` and
// the caller closes — no POST endpoint, no tray.

type PickerTab = "folders" | "people" | "tags" | "all";

/** Page size for the photo grids — matches the gallery's own views. */
const PAGE = 80;

const SEARCH_PLACEHOLDER: Record<PickerTab, string> = {
  folders: "Search folders",
  people: "Search people",
  tags: "Search tags",
  all: "Search photos"
};

export function PhotoPicker({
  title,
  endpoint,
  existingIds,
  pick,
  onPick,
  onClose,
  onAdded
}: {
  title: string;
  /** POST endpoint accepting { itemIds: string[] } and returning { added, skipped }. Unused with `pick`. */
  endpoint?: string;
  /** Item ids already attached — shown as "Added", not re-selectable. Unused with `pick`. */
  existingIds?: string[];
  /** Single-choice mode: which kind can be picked. */
  pick?: "video";
  onPick?: (asset: GalleryAsset) => void;
  onClose: () => void;
  onAdded?: (added: number) => void;
}) {
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [scope, setScope] = useState<string>("all"); // "all" or a gallery library id
  const [tab, setTab] = useState<PickerTab>("folders");
  const [search, setSearch] = useState("");
  // The debounced form the server queries use; chip filtering uses `search` live.
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [addedAny, setAddedAny] = useState(false);

  // Folder browse (+ folder-name search results while a term is typed).
  const [parent, setParent] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [folderAssets, setFolderAssets] = useState<GalleryAsset[]>([]);
  const [folderResults, setFolderResults] = useState<GalleryFolder[] | null>(null);

  // People: the chip row, and the open person's paged grid.
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [person, setPerson] = useState<GalleryPerson | null>(null);
  const [personAssets, setPersonAssets] = useState<GalleryAsset[]>([]);
  const [personTotal, setPersonTotal] = useState(0);

  // Tags: the chip list, and the open tag's paged grid (a timeline query).
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  const [tagAssets, setTagAssets] = useState<GalleryAsset[]>([]);
  const [tagTotal, setTagTotal] = useState(0);

  // All photos: the timeline, newest first, searched by `query`.
  const [allAssets, setAllAssets] = useState<GalleryAsset[]>([]);
  const [allTotal, setAllTotal] = useState(0);

  // The selection carries the full assets (the tray renders their thumbnails)
  // and persists across tabs, folders, people and tags — gather from anywhere,
  // add once. Already-attached ids show as "Added" and can't be re-selected.
  const [selected, setSelected] = useState<Map<string, GalleryAsset>>(new Map());
  const [added, setAdded] = useState<Set<string>>(() => new Set(existingIds ?? []));

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setQuery(search.trim()), 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  useEffect(() => {
    api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch(() => undefined);
  }, []);

  const scopeParam = useCallback(() => (scope === "all" ? "" : `&libraryIds=${encodeURIComponent(scope)}`), [scope]);
  const scopeFilters = useCallback(
    () => ({ ...EMPTY_GALLERY_FILTERS, libraries: scope === "all" ? [] : [scope] }),
    [scope]
  );

  // ── Folders ────────────────────────────────────────────────────────────────
  const loadFolder = useCallback(async (nextParent: string) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ parent: string; folders: GalleryFolder[]; assets: GalleryAsset[] }>(
        `/api/library/gallery/folders?parent=${encodeURIComponent(nextParent)}&limit=300${scopeParam()}`
      );
      setFolders(payload.folders);
      setFolderAssets(payload.assets);
      setParent(payload.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this folder");
    } finally {
      setLoading(false);
    }
  }, [scopeParam]);

  useEffect(() => {
    if (tab !== "folders") return;
    if (query) {
      setLoading(true);
      api<{ folders: GalleryFolder[] }>(`/api/library/gallery/folders/search?q=${encodeURIComponent(query)}${scopeParam()}`)
        .then((payload) => setFolderResults(payload.folders))
        .catch((err) => setError(err instanceof Error ? err.message : "Unable to search folders"))
        .finally(() => setLoading(false));
    } else {
      setFolderResults(null);
      void loadFolder("");
    }
  }, [tab, query, scope, loadFolder, scopeParam]);

  // ── People ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== "people") return;
    setLoading(true);
    setError("");
    api<{ people: GalleryPerson[] }>(`/api/library/gallery/people?${scopeParam().replace(/^&/, "")}`)
      .then((payload) => {
        // Named people lead (largest first); unnamed clusters trail behind them.
        const sorted = [...payload.people].sort(
          (a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || b.faceCount - a.faceCount
        );
        setPeople(sorted);
        setPerson((current) => current ?? sorted[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load people"))
      .finally(() => setLoading(false));
  }, [tab, scope, scopeParam]);

  const loadPerson = useCallback(async (who: GalleryPerson, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/people/${who.id}?limit=${PAGE}&offset=${offset}`
      );
      setPersonAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setPersonTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this person's photos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "people" || !person) return;
    void loadPerson(person, 0);
  }, [tab, person, loadPerson]);

  // ── Tags & All photos (both are timeline queries) ──────────────────────────
  useEffect(() => {
    if (tab !== "tags") return;
    api<{ tags: string[] }>(`/api/library/gallery/facets?${scopeParam().replace(/^&/, "")}`)
      .then((payload) => {
        setTags(payload.tags);
        setTag((current) => current ?? payload.tags[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tags"));
  }, [tab, scope, scopeParam]);

  const queryTimeline = useCallback(async (body: object) => {
    return api<{ assets: GalleryAsset[]; total: number }>("/api/library/gallery/timeline", {
      method: "POST",
      body: JSON.stringify({ q: "", kinds: [], sort: "taken", limit: PAGE, offset: 0, ...body })
    });
  }, []);

  const loadTag = useCallback(async (name: string, offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await queryTimeline({ filters: { ...scopeFilters(), tags: [name] }, offset });
      setTagAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setTagTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load these photos");
    } finally {
      setLoading(false);
    }
  }, [queryTimeline, scopeFilters]);

  useEffect(() => {
    if (tab !== "tags" || !tag) return;
    void loadTag(tag, 0);
  }, [tab, tag, loadTag]);

  const loadAll = useCallback(async (offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const payload = await queryTimeline({ q: query, filters: scopeFilters(), offset });
      setAllAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setAllTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load photos");
    } finally {
      setLoading(false);
    }
  }, [queryTimeline, scopeFilters, query]);

  useEffect(() => {
    if (tab !== "all") return;
    void loadAll(0);
  }, [tab, loadAll]);

  // ── Selection ──────────────────────────────────────────────────────────────
  const toggle = (asset: GalleryAsset) => {
    if (added.has(asset.id)) return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(asset.id)) next.delete(asset.id); else next.set(asset.id, asset);
      return next;
    });
  };

  const addSelected = async () => {
    const ids = [...selected.keys()].filter((id) => !added.has(id));
    if (ids.length === 0 || !endpoint) return;
    setAdding(true);
    setError("");
    try {
      const result = await api<{ added: number; skipped: number }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ itemIds: ids })
      });
      setAdded((prev) => new Set([...prev, ...ids]));
      setSelected(new Map());
      setAddedAny(true);
      onAdded?.(result.added);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the photos");
    } finally {
      setAdding(false);
    }
  };

  // ── Rendering ──────────────────────────────────────────────────────────────
  const breadcrumbParts = useMemo(() => (parent ? parent.split("/") : []), [parent]);
  const chipFilter = search.trim().toLocaleLowerCase();
  const visiblePeople = chipFilter
    ? people.filter((p) => (p.name || "Unnamed").toLocaleLowerCase().includes(chipFilter))
    : people;
  const visibleTags = chipFilter
    ? tags.filter((t) => t.toLocaleLowerCase().includes(chipFilter))
    : tags;

  const grid = (assets: GalleryAsset[]) => (
    <div className="gallery-grid">
      {assets.map((asset) => {
        const isAdded = added.has(asset.id);
        const isSelected = selected.has(asset.id);
        // Pick mode: only the pickable kind is clickable, and a click chooses.
        const unpickable = pick !== undefined && asset.kind !== pick;
        return (
          <button
            key={asset.id}
            type="button"
            className={`gallery-tile slideshow-browse-tile${isAdded ? " is-added" : isSelected ? " is-selected" : ""}${unpickable ? " is-unpickable" : ""}`}
            onClick={() => (pick ? onPick?.(asset) : toggle(asset))}
            disabled={isAdded || adding || unpickable}
            aria-pressed={pick ? undefined : isSelected}
            title={unpickable ? "Only a video can be chosen here" : isAdded ? "Already added" : asset.title}
          >
            {asset.coverUrl ? <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} /> : (
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

  const loadMore = (shown: number, total: number, more: () => void) =>
    shown < total && (
      <div className="photo-picker-more">
        <Button variant="secondary" compact disabled={loading} onClick={more}>
          {loading ? "Loading…" : `Load more (${(total - shown).toLocaleString()} left)`}
        </Button>
      </div>
    );

  const librarySelect = (
    <label className="slideshow-browse-scope">
      <span className="sr-only">Gallery library</span>
      <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={adding}>
        <option value="all">All libraries</option>
        {libraries.map((library) => (
          <option key={library.id} value={library.id}>{library.name}</option>
        ))}
      </select>
    </label>
  );

  const trayEntries = [...selected.values()];

  return (
    <Modal
      variant="panel"
      title={title}
      icon={<FolderOpen size={20} />}
      className="add-to-album-modal slideshow-browse-modal photo-picker-modal"
      busy={adding}
      headerAction={librarySelect}
      onClose={onClose}
    >
      <div className="photo-picker-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          value={search}
          placeholder={SEARCH_PLACEHOLDER[tab]}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={SEARCH_PLACEHOLDER[tab]}
        />
      </div>

      <div className="modal-tabs">
        {([
          ["folders", "Folders"],
          ["people", "People"],
          ["tags", "Tags"],
          ["all", "All photos"]
        ] as [PickerTab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`modal-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="modal-tab-content add-to-album-body">
        {error && <MessageBox tone="error" title="Couldn’t load photos">{error}</MessageBox>}

        {tab === "folders" && (folderResults !== null ? (
          <>
            <p className="gallery-section-label">{folderResults.length === 0 ? "No folders match" : "Matching folders"}</p>
            <div className="gallery-folder-grid">
              {folderResults.map((folder) => (
                <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => { setSearch(""); void loadFolder(folder.path); }} disabled={adding}>
                  <span className="gallery-folder-thumb">
                    {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                  </span>
                  <strong>{folder.name}</strong>
                  <small>{folder.assetCount.toLocaleString()} {folder.assetCount === 1 ? "item" : "items"}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="gallery-breadcrumb slideshow-browse-crumbs">
              <button type="button" onClick={() => void loadFolder("")} disabled={adding}>All folders</button>
              {breadcrumbParts.map((part, i) => {
                const target = breadcrumbParts.slice(0, i + 1).join("/");
                return (
                  <span key={target} className="slideshow-browse-crumb">
                    <ChevronRight size={14} aria-hidden="true" />
                    <button type="button" onClick={() => void loadFolder(target)} disabled={adding}>{part}</button>
                  </span>
                );
              })}
            </div>
            {folders.length > 0 && (
              <>
                <p className="gallery-section-label">Folders</p>
                <div className="gallery-folder-grid">
                  {folders.map((folder) => (
                    <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void loadFolder(folder.path)} disabled={adding}>
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
                {grid(folderAssets)}
              </>
            )}
            {!loading && folders.length === 0 && folderAssets.length === 0 && <p className="management-empty">This folder is empty.</p>}
          </>
        ))}

        {tab === "people" && (
          <>
            {visiblePeople.length > 0 ? (
              <div className="photo-picker-chips" role="tablist" aria-label="People">
                {visiblePeople.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`photo-picker-chip${person?.id === p.id ? " is-active" : ""}`}
                    onClick={() => { setPersonAssets([]); setPerson(p); }}
                  >
                    <span className="photo-picker-chip-avatar">
                      {p.coverUrl ? <img src={p.coverUrl} alt="" loading="lazy" /> : <User size={16} aria-hidden="true" />}
                    </span>
                    <span className="photo-picker-chip-copy">
                      <strong>{p.name || "Unnamed"}</strong>
                      <small>{p.faceCount.toLocaleString()} {p.faceCount === 1 ? "photo" : "photos"}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              !loading && <p className="management-empty">{chipFilter ? "Nobody matches that." : "No people yet — face scanning builds this list."}</p>
            )}
            {person && (
              <>
                <p className="gallery-section-label">Showing photos of <strong>{person.name || "an unnamed person"}</strong></p>
                {grid(personAssets)}
                {loadMore(personAssets.length, personTotal, () => void loadPerson(person, personAssets.length))}
              </>
            )}
          </>
        )}

        {tab === "tags" && (
          <>
            {visibleTags.length > 0 ? (
              <div className="photo-picker-chips" role="tablist" aria-label="Tags">
                {visibleTags.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`photo-picker-chip photo-picker-chip-tag${tag === name ? " is-active" : ""}`}
                    onClick={() => { setTagAssets([]); setTag(name); }}
                  >
                    <Tag size={13} aria-hidden="true" />
                    <span>{name}</span>
                  </button>
                ))}
              </div>
            ) : (
              !loading && <p className="management-empty">{chipFilter ? "No tags match that." : "No tags on gallery photos yet."}</p>
            )}
            {tag && (
              <>
                <p className="gallery-section-label">Tagged <strong>{tag}</strong></p>
                {grid(tagAssets)}
                {loadMore(tagAssets.length, tagTotal, () => void loadTag(tag, tagAssets.length))}
              </>
            )}
          </>
        )}

        {tab === "all" && (
          <>
            {grid(allAssets)}
            {loadMore(allAssets.length, allTotal, () => void loadAll(allAssets.length))}
            {!loading && allAssets.length === 0 && (
              <p className="management-empty">{query ? "No photos match that." : "No photos in scope."}</p>
            )}
          </>
        )}

        {loading && <p className="management-empty">Loading…</p>}
      </div>

      <div className="modal-actions photo-picker-actions">
        {pick ? (
          <>
            <span className="muted">Tap a video to choose it.</span>
            <div className="row-actions">
              <Button variant="secondary" compact onClick={onClose}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div className="photo-picker-tray">
              <span className="photo-picker-tray-count">
                {selected.size > 0
                  ? `${selected.size} ${selected.size === 1 ? "photo" : "photos"} selected`
                  : "Select photos to add"}
              </span>
              {trayEntries.slice(0, 8).map((asset) => (
                <span key={asset.id} className="photo-picker-tray-thumb">
                  {asset.coverUrl
                    ? <img src={asset.coverUrl} alt="" loading="lazy" />
                    : <ImageIcon size={14} aria-hidden="true" />}
                  <button
                    type="button"
                    className="photo-picker-tray-remove"
                    onClick={() => toggle(asset)}
                    aria-label={`Remove ${asset.title} from the selection`}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {trayEntries.length > 8 && <span className="photo-picker-tray-overflow">+{trayEntries.length - 8}</span>}
            </div>
            <div className="row-actions">
              <Button variant="secondary" compact disabled={adding} onClick={onClose}>
                {addedAny ? "Done" : "Cancel"}
              </Button>
              <Button variant="primary" compact disabled={selected.size === 0 || adding} onClick={() => void addSelected()}>
                {adding ? "Adding…" : selected.size === 0 ? "Add photos" : selected.size === 1 ? "Add 1 photo" : `Add ${selected.size} photos`}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
