import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { GalleryAsset, GalleryFaceSettings, GalleryPerson } from "./types";
import type { GalleryStatus } from "./useGalleryAlbums";

/** Page size for one person's photo grid. Matches the timeline. */
const PAGE_SIZE = 80;
/** How many person cards each section of the People grid adds at a time. */
const PEOPLE_PAGE = 120;

interface PeopleDeps extends GalleryStatus {
  /** The current library/kind scope as query params — People is scope-filtered.
   *  Widened to the record URLSearchParams wants; the page returns a narrower union. */
  scopeParams: () => Record<string, string | undefined>;
  /** Face-recognition settings are an admin-only read. */
  isAdmin: boolean;
}

/**
 * The People view: the person grid, the open person's photos, and every
 * correction you can make to a face cluster — rename, merge, delete, detach a
 * photo, or pick several and move them to someone else.
 *
 * Third of the view hooks, after useGalleryAlbums and useGallerySlideshows, and
 * the same contract: a flat object the page destructures back into its original
 * names. This one takes two extra dependencies because People is scope-filtered
 * and its face settings are admin-only.
 */
export function useGalleryPeople({ setLoading, setError, setNotice, scopeParams, isAdmin }: PeopleDeps) {
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<{ id: string; name: string } | null>(null);
  const [personAssets, setPersonAssets] = useState<GalleryAsset[]>([]);
  const [personTotal, setPersonTotal] = useState(0);
  // Face recognition (admin): per-library settings + the settings popup.
  const [faceSettings, setFaceSettings] = useState<GalleryFaceSettings | null>(null);
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  // Inline rename of the open person.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [personDeleteOpen, setPersonDeleteOpen] = useState(false);
  // Picking individual photos out of the open person, to move them to someone else
  // — the fix for a cluster that swept in a stranger (a whole-cluster merge can't).
  const [personPick, setPersonPick] = useState<Set<string> | null>(null);
  const [moveNewName, setMoveNewName] = useState<string | null>(null);
  const [movingPhotos, setMovingPhotos] = useState(false);
  const [showSmallGroups, setShowSmallGroups] = useState(false);
  // How many cards each section of the People grid currently renders (paged).
  const [visiblePeople, setVisiblePeople] = useState(PEOPLE_PAGE);
  const [visibleSmall, setVisibleSmall] = useState(PEOPLE_PAGE);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    setError("");
    setVisiblePeople(PEOPLE_PAGE);
    setVisibleSmall(PEOPLE_PAGE);
    try {
      const params = new URLSearchParams(scopeParams() as Record<string, string>);
      const payload = await api<{ people: GalleryPerson[] }>(`/api/library/gallery/people?${params}`);
      setPeople(payload.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load people");
    } finally {
      setLoading(false);
    }
  }, [scopeParams, setLoading, setError]);

  // Drill into one person's photos (opened from a person chip). Paged like the
  // timeline: offset 0 replaces the grid, later offsets append. A person can have
  // thousands of photos, so we never try to pull them all in one request — that
  // both hid photos past the server's page cap and flooded the thumbnail route.
  const openPerson = useCallback(async (person: { id: string; name: string }, offset = 0) => {
    setLoading(true);
    setError("");
    setSelectedPerson(person);
    try {
      const payload = await api<{ assets: GalleryAsset[]; total: number }>(
        `/api/library/gallery/people/${person.id}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      setPersonAssets((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
      setPersonTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this person's photos");
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  const loadFaceSettings = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setFaceSettings(await api<GalleryFaceSettings>("/api/library/gallery/faces/settings"));
    } catch { /* non-admins / errors just hide the controls */ }
  }, [isAdmin]);

  const anyFaceEnabled = (faceSettings?.libraries ?? []).some((library) => library.enabled);

  const submitRename = useCallback(async () => {
    if (!selectedPerson || renameValue == null) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setSelectedPerson({ ...selectedPerson, name });
      setRenameValue(null);
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename");
    }
  }, [selectedPerson, renameValue, loadPeople, setError]);

  const confirmMerge = useCallback(async (targetId: string) => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}/merge`, { method: "POST", body: JSON.stringify({ intoId: targetId }) });
      setMergeOpen(false);
      setSelectedPerson(null);
      void loadPeople();
      setNotice("People merged.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to merge");
    }
  }, [selectedPerson, loadPeople, setError, setNotice]);

  // Detach one photo from the open person (a mismatched auto-cluster member, or a
  // manual tag). Drops it from the grid optimistically and refreshes counts.
  const removeFromPerson = useCallback(async (assetId: string) => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/assets/${assetId}/people/${selectedPerson.id}`, { method: "DELETE" });
      setPersonAssets((prev) => prev.filter((a) => a.id !== assetId));
      setPersonTotal((n) => Math.max(0, n - 1));
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the photo");
    }
  }, [selectedPerson, loadPeople, setError]);

  // Toggle one photo in the "move these to someone else" picker.
  const togglePersonPick = useCallback((assetId: string) => {
    setPersonPick((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }, []);

  // Leaving (or switching) the open person drops any half-made selection, so it
  // can't be applied to the wrong cluster later.
  useEffect(() => { setPersonPick(null); setMoveNewName(null); }, [selectedPerson?.id]);

  // Move the picked photos to another person (existing, or a name to create). The
  // moved photos leave this person's grid; both people's counts change, so the
  // people list reloads.
  const movePickedPhotos = useCallback(async (target: { intoId: string } | { name: string }) => {
    if (!selectedPerson || !personPick || personPick.size === 0) return;
    const itemIds = [...personPick];
    setMovingPhotos(true);
    setError("");
    try {
      const payload = await api<{ moved: number }>(
        `/api/library/gallery/people/${selectedPerson.id}/reassign`,
        { method: "POST", body: JSON.stringify({ itemIds, ...target }) }
      );
      setPersonAssets((prev) => prev.filter((a) => !personPick.has(a.id)));
      setPersonTotal((n) => Math.max(0, n - payload.moved));
      setPersonPick(null);
      setMoveNewName(null);
      void loadPeople();
      setNotice(`${payload.moved} ${payload.moved === 1 ? "photo" : "photos"} moved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move the photos");
    } finally {
      setMovingPhotos(false);
    }
  }, [selectedPerson, personPick, loadPeople, setError, setNotice]);

  const confirmDeletePerson = useCallback(async () => {
    if (!selectedPerson) return;
    try {
      await api(`/api/library/gallery/people/${selectedPerson.id}`, { method: "DELETE" });
      setPersonDeleteOpen(false);
      setSelectedPerson(null);
      void loadPeople();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete");
    }
  }, [selectedPerson, loadPeople, setError]);

  return {
    people, setPeople,
    selectedPerson, setSelectedPerson,
    personAssets, setPersonAssets,
    personTotal, setPersonTotal,
    faceSettings, setFaceSettings,
    faceModalOpen, setFaceModalOpen,
    renameValue, setRenameValue,
    mergeOpen, setMergeOpen,
    personDeleteOpen, setPersonDeleteOpen,
    personPick, setPersonPick,
    moveNewName, setMoveNewName,
    movingPhotos, showSmallGroups, setShowSmallGroups,
    visiblePeople, setVisiblePeople,
    visibleSmall, setVisibleSmall,
    anyFaceEnabled,
    loadPeople, openPerson, loadFaceSettings, submitRename, confirmMerge,
    removeFromPerson, togglePersonPick, movePickedPhotos, confirmDeletePerson
  };
}
