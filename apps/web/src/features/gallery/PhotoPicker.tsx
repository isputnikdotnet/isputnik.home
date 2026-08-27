import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, FolderOpen, Image as ImageIcon, Play, Search, Tag, User, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { FileUpload } from "../../shared/FileUpload";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { EMPTY_GALLERY_FILTERS } from "./GalleryFilter";
import type { GalleryAsset, GalleryFolder, GalleryLibrary, GalleryPerson } from "./types";
import { faceFocusStyle } from "./types";

// The standard photo picker: one modal for choosing gallery photos/videos from
// anywhere in the app. Four ways in — browse by folder, by person (face
// clusters), by tag, or straight through all photos — with one search box and
// one selection that persists across all of them, gathered in a tray along the
// bottom. Successor to both GalleryFolderPicker (folders only) and the family
// tree's FamilyPhotoPicker (whose face-matches, upload and portrait modes fold
// in here as props).
//
// Everything rides existing endpoints: /folders + /folders/search for the tree,
// /people + /people/:id for the clusters, /facets for the tag list, and the
// timeline query (POST /timeline) for tags, all-photos and text search.
//
// Single-choice modes: `pick: "video"` (the slideshow's opening/closing clips —
// photos dim, tapping a video hands it to `onPick`) and `pick: "any"` (a
// portrait choice — tapping anything hands it over). No POST, no tray.

type PickerTab = "folders" | "people" | "tags" | "all" | "upload";

/** Page size for the photo grids — matches the gallery's own views. */
const PAGE = 80;

export function PhotoPicker({
  title,
  endpoint,
  existingIds,
  pick,
  facePerson,
  uploadTo,
  onPick,
  onAttach,
  onClose,
  onAdded
}: {
  title: string;
  /** POST endpoint accepting { itemIds: string[] } and returning { added, skipped }. Unused with `pick`. */
  endpoint?: string;
  /** Item ids already attached — shown as "Added", not re-selectable. Unused with `pick`. */
  existingIds?: string[];
  /** Single-choice mode: which kind can be picked ("any" = one tap picks anything). */
  pick?: "video" | "any";
  /** A linked gallery person: the picker opens on People with them selected —
      their face matches beat hunting through folders (the family tree). */
  facePerson?: { id: string; name: string } | null;
  /** Offer an Upload tab landing new files in this gallery library, then
      picking/attaching them in the same step. The tab only appears when the
      caller may actually upload there (the library's own canUpload). */
  uploadTo?: { id: string; name: string } | null;
  onPick?: (asset: GalleryAsset) => void;
  /** Multi mode without a server endpoint: the caller attaches the selection
      (ids + their asset objects, so it can stage thumbnails without refetching). */
  onAttach?: (itemIds: string[], assets: GalleryAsset[]) => Promise<void>;
  onClose: () => void;
  onAdded?: (added: number) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const SEARCH_PLACEHOLDER: Record<Exclude<PickerTab, "upload">, string> = {
    folders: t("gallery:photoPicker.searchFolders"),
    people: t("gallery:photoPicker.searchPeople"),
    tags: t("gallery:photoPicker.searchTags"),
    all: t("gallery:photoPicker.searchPhotos")
  };
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [scope, setScope] = useState<string>("all"); // "all" or a gallery library id
  // A linked person means their matches are almost certainly what's wanted.
  const [tab, setTab] = useState<PickerTab>(facePerson ? "people" : "folders");
  const [uploadNotice, setUploadNotice] = useState("");
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
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadFolder"));
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
        .catch((err) => setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.searchFolders")))
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
        // The linked person opens selected; a person the list doesn't carry
        // (hidden, or freshly linked) still loads through a synthesized entry.
        const linked = facePerson
          ? sorted.find((p) => p.id === facePerson.id)
            ?? { id: facePerson.id, name: facePerson.name, faceCount: 0, coverUrl: null }
          : null;
        setPerson((current) => current ?? linked ?? sorted[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadPeople")))
      .finally(() => setLoading(false));
  }, [tab, scope, scopeParam, facePerson]);

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
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadPersonPhotos"));
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
      .catch((err) => setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadTags")));
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
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadTaggedPhotos"));
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
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.loadPhotos"));
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

  // Hand a batch over — to the POST endpoint (albums, slideshows) or to the
  // caller's own attach handler (the family tree). One path for the tray's Add
  // button and for freshly uploaded files.
  const attachIds = useCallback(async (ids: string[], assets: GalleryAsset[]) => {
    if (endpoint) {
      const result = await api<{ added: number; skipped: number }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ itemIds: ids })
      });
      onAdded?.(result.added);
    } else if (onAttach) {
      await onAttach(ids, assets);
      onAdded?.(ids.length);
    }
    setAdded((prev) => new Set([...prev, ...ids]));
    setAddedAny(true);
  }, [endpoint, onAttach, onAdded]);

  const addSelected = async () => {
    const ids = [...selected.keys()].filter((id) => !added.has(id));
    if (ids.length === 0 || (!endpoint && !onAttach)) return;
    setAdding(true);
    setError("");
    try {
      await attachIds(ids, ids.map((id) => selected.get(id)).filter((a): a is GalleryAsset => a != null));
      setSelected(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.addPhotos"));
    } finally {
      setAdding(false);
    }
  };

  // Uploading needs a destination the caller nominates; the tab only exists
  // when that library is in the viewer's list AND lets them upload — a tab
  // that can only apologise is worse than no tab.
  const uploadLibrary = uploadTo ? libraries.find((l) => l.id === uploadTo.id) : undefined;
  const canUploadHere = Boolean(uploadLibrary?.canUpload);
  const activeTab: PickerTab = tab === "upload" && !canUploadHere ? "folders" : tab;

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
      // Single-choice mode: the file is now a gallery item like any other, so
      // the caller takes it the same way it takes a browsed one.
      if (pick) {
        if (assets[0]) onPick?.(assets[0]);
        else setError(t("gallery:photoPicker.errors.uploadReadback"));
        return;
      }
      await attachIds(itemIds, assets);
      setUploadNotice(t("gallery:photoPicker.uploadedNotice", { count: itemIds.length }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:photoPicker.errors.uploadAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  // ── Rendering ──────────────────────────────────────────────────────────────
  const breadcrumbParts = useMemo(() => (parent ? parent.split("/") : []), [parent]);
  const chipFilter = search.trim().toLocaleLowerCase();
  const visiblePeople = chipFilter
    ? people.filter((p) => (p.name || t("gallery:common.unnamed")).toLocaleLowerCase().includes(chipFilter))
    : people;
  const visibleTags = chipFilter
    ? tags.filter((t2) => t2.toLocaleLowerCase().includes(chipFilter))
    : tags;

  const grid = (assets: GalleryAsset[]) => (
    <div className="gallery-grid">
      {assets.map((asset) => {
        const isAdded = !pick && added.has(asset.id);
        const isSelected = !pick && selected.has(asset.id);
        // Video-pick mode: only a video is clickable, and a click chooses.
        const unpickable = pick === "video" && asset.kind !== "video";
        return (
          <button
            key={asset.id}
            type="button"
            className={`gallery-tile slideshow-browse-tile${isAdded ? " is-added" : isSelected ? " is-selected" : ""}${unpickable ? " is-unpickable" : ""}`}
            onClick={() => (pick ? onPick?.(asset) : toggle(asset))}
            disabled={isAdded || adding || unpickable}
            aria-pressed={pick ? undefined : isSelected}
            title={unpickable ? t("gallery:photoPicker.onlyVideoTitle") : isAdded ? t("gallery:photoPicker.alreadyAddedTitle") : asset.title}
          >
            {asset.coverUrl ? <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} /> : (
              <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
            )}
            {asset.kind === "video" && <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("gallery:common.video")}</span>}
            {isAdded ? (
              <span className="slideshow-browse-badge added">{t("gallery:photoPicker.addedBadge")}</span>
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
          {loading ? t("gallery:common.loading") : t("gallery:photoPicker.loadMoreLeft", { count: (total - shown).toLocaleString() })}
        </Button>
      </div>
    );

  const librarySelect = (
    <label className="slideshow-browse-scope">
      <span className="sr-only">{t("gallery:photoPicker.libraryAria")}</span>
      <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={adding}>
        <option value="all">{t("gallery:photoPicker.allLibraries")}</option>
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
      {activeTab !== "upload" && (
        <div className="photo-picker-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder={SEARCH_PLACEHOLDER[activeTab]}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={SEARCH_PLACEHOLDER[activeTab]}
          />
        </div>
      )}

      <div className="modal-tabs">
        {([
          ["folders", t("gallery:photoPicker.tabFolders")],
          ["people", t("gallery:photoPicker.tabPeople")],
          ["tags", t("gallery:photoPicker.tabTags")],
          ["all", t("gallery:photoPicker.tabAll")],
          ...(canUploadHere ? [["upload", t("gallery:photoPicker.tabUpload")] as [PickerTab, string]] : [])
        ] as [PickerTab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`modal-tab${activeTab === key ? " active" : ""}`}
            onClick={() => { setTab(key); if (key === "upload") setUploadNotice(""); }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* The person/tag chips live OUTSIDE the scroll pane, a fixed band like
          the search row above — who/what you're picking from stays in view
          however far the photos scroll. */}
      {activeTab === "people" && (
        visiblePeople.length > 0 ? (
          <div className="photo-picker-chips" role="tablist" aria-label={t("gallery:photoPicker.tabPeople")}>
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
                  <strong>{p.name || t("gallery:common.unnamed")}</strong>
                  <small>{t("gallery:common.counts.photo", { count: p.faceCount })}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          !loading && (
            <p className="management-empty photo-picker-chips-empty">
              {chipFilter ? t("gallery:photoPicker.noPeopleMatch") : t("gallery:photoPicker.noPeopleYet")}
            </p>
          )
        )
      )}
      {activeTab === "tags" && (
        visibleTags.length > 0 ? (
          <div className="photo-picker-chips" role="tablist" aria-label={t("gallery:photoPicker.tabTags")}>
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
          !loading && (
            <p className="management-empty photo-picker-chips-empty">
              {chipFilter ? t("gallery:photoPicker.noTagsMatch") : t("gallery:photoPicker.noTagsYet")}
            </p>
          )
        )
      )}

      <div className="modal-tab-content add-to-album-body">
        {error && <MessageBox tone="error" title={t("gallery:photoPicker.loadErrorTitle")}>{error}</MessageBox>}

        {activeTab === "upload" && uploadLibrary && uploadTo && (
          <div className="photo-picker-upload">
            {uploadNotice && <MessageBox tone="success" title={t("gallery:photoPicker.addedTitle")}>{uploadNotice}</MessageBox>}
            <p className="photo-picker-hint">
              {pick
                ? t("gallery:photoPicker.uploadHintPick", { name: uploadTo.name })
                : t("gallery:photoPicker.uploadHintMulti", { name: uploadTo.name })}
            </p>
            <FileUpload
              endpoint={`/api/library/gallery-libraries/${uploadLibrary.id}/assets/upload`}
              accept={uploadLibrary.uploadExtensions}
              maxBytes={uploadLibrary.maxUploadMB != null ? uploadLibrary.maxUploadMB * 1024 * 1024 : null}
              multiple={!pick}
              maxFiles={pick ? 1 : 100}
              hint={`${t("common:upload.accepted", { types: uploadLibrary.uploadExtensions.map((ext) => `.${ext}`).join(", ") })}${uploadLibrary.maxUploadMB != null ? t("gallery:photoPicker.maxSizeSuffix", { mb: uploadLibrary.maxUploadMB }) : ""}`}
              onUploaded={(response) => {
                const payload = response as { itemIds?: string[] };
                void uploadFinished(payload.itemIds ?? []);
              }}
              onBusyChange={setAdding}
            />
          </div>
        )}

        {activeTab === "folders" && (folderResults !== null ? (
          <>
            <p className="gallery-section-label">{folderResults.length === 0 ? t("gallery:photoPicker.noFoldersMatch") : t("gallery:photoPicker.matchingFolders")}</p>
            <div className="gallery-folder-grid">
              {folderResults.map((folder) => (
                <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => { setSearch(""); void loadFolder(folder.path); }} disabled={adding}>
                  <span className="gallery-folder-thumb">
                    {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                  </span>
                  <strong>{folder.name}</strong>
                  <small>{t("gallery:common.counts.item", { count: folder.assetCount })}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="gallery-breadcrumb slideshow-browse-crumbs">
              <button type="button" onClick={() => void loadFolder("")} disabled={adding}>{t("gallery:folders.allFolders")}</button>
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
                <p className="gallery-section-label">{t("gallery:photoPicker.tabFolders")}</p>
                <div className="gallery-folder-grid">
                  {folders.map((folder) => (
                    <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void loadFolder(folder.path)} disabled={adding}>
                      <span className="gallery-folder-thumb">
                        {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                      </span>
                      <strong>{folder.name}</strong>
                      <small>{t("gallery:common.counts.item", { count: folder.assetCount })}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            {folderAssets.length > 0 && (
              <>
                <p className="gallery-section-label">{t("gallery:photoPicker.photosVideosHeading")}</p>
                {grid(folderAssets)}
              </>
            )}
            {!loading && folders.length === 0 && folderAssets.length === 0 && <p className="management-empty">{t("gallery:folders.emptyFolder")}</p>}
          </>
        ))}

        {activeTab === "people" && person && (
          <>
            <p className="gallery-section-label">{t("gallery:photoPicker.showingPhotosOf")} <strong>{person.name || t("gallery:photoPicker.unnamedPersonFallback")}</strong></p>
            {/* The linked person's matches carry the family tree's caveat. */}
            {facePerson && person.id === facePerson.id && !pick && (
              <p className="photo-picker-hint">
                {t("gallery:photoPicker.faceMatchHint", { name: facePerson.name })}
              </p>
            )}
            {grid(personAssets)}
            {loadMore(personAssets.length, personTotal, () => void loadPerson(person, personAssets.length))}
          </>
        )}

        {activeTab === "tags" && tag && (
          <>
            <p className="gallery-section-label">{t("gallery:photoPicker.taggedHeading")} <strong>{tag}</strong></p>
            {grid(tagAssets)}
            {loadMore(tagAssets.length, tagTotal, () => void loadTag(tag, tagAssets.length))}
          </>
        )}

        {activeTab === "all" && (
          <>
            {grid(allAssets)}
            {loadMore(allAssets.length, allTotal, () => void loadAll(allAssets.length))}
            {!loading && allAssets.length === 0 && (
              <p className="management-empty">{query ? t("gallery:photoPicker.noPhotosMatch") : t("gallery:photoPicker.noPhotosInScope")}</p>
            )}
          </>
        )}

        {loading && <p className="management-empty">{t("gallery:common.loading")}</p>}
      </div>

      <div className="modal-actions photo-picker-actions">
        {pick ? (
          <>
            <span className="muted">{pick === "video" ? t("gallery:photoPicker.tapVideoHint") : t("gallery:photoPicker.tapPhotoHint")}</span>
            <div className="row-actions">
              <Button variant="secondary" compact onClick={onClose}>{t("common:common.cancel")}</Button>
            </div>
          </>
        ) : (
          <>
            <div className="photo-picker-tray">
              <span className="photo-picker-tray-count">
                {selected.size > 0
                  ? t("gallery:photoPicker.selectedCount", { count: selected.size })
                  : t("gallery:photoPicker.selectPrompt")}
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
                    aria-label={t("gallery:photoPicker.trayRemoveAria", { title: asset.title })}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {trayEntries.length > 8 && <span className="photo-picker-tray-overflow">+{trayEntries.length - 8}</span>}
            </div>
            <div className="row-actions">
              <Button variant="secondary" compact disabled={adding} onClick={onClose}>
                {addedAny ? t("common:common.done") : t("common:common.cancel")}
              </Button>
              <Button variant="primary" compact disabled={selected.size === 0 || adding} onClick={() => void addSelected()}>
                {adding ? t("gallery:common.adding") : selected.size === 0 ? t("gallery:common.addPhotos") : t("gallery:photoPicker.addCount", { count: selected.size })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
