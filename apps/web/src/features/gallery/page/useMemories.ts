import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import type { GalleryView } from "../../../router";
import type { GalleryAsset, GalleryMemories, GalleryMemorySuggestion, GallerySlideshow, GalleryYearReview } from "../types";
import type { LightboxState } from "./gallery-page-model";

// Memories ("On this day") — the strip above the timeline AND the Memories view —
// plus the suggested memories (event/trip clusters) the Slideshows list offers,
// and the years in review the Memories view opens with.
export function useMemories({
  scopeParams,
  setError,
  setNotice,
  goToView,
  openSlideshow,
  resetSlideshow,
  setLightbox
}: {
  scopeParams: () => { libraryIds?: string };
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  goToView: (next: GalleryView) => void;
  openSlideshow: (id: string) => Promise<void>;
  /** Clear the open slideshow's items before a new one loads into its place. */
  resetSlideshow: () => void;
  setLightbox: (state: LightboxState) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [memories, setMemories] = useState<GalleryMemories | null>(null);
  const [memorySuggestions, setMemorySuggestions] = useState<GalleryMemorySuggestion[]>([]);
  // A suggestion opened for PREVIEW — nothing is created until the user picks an
  // action in the modal. previewAssets null = thumbnails still loading.
  const [previewSuggestion, setPreviewSuggestion] = useState<GalleryMemorySuggestion | null>(null);
  const [previewAssets, setPreviewAssets] = useState<GalleryAsset[] | null>(null);
  // "Your 2025 in photos": finished years, proposed as a film (server:
  // year-review.ts). yearReviewAssets is the one being played — the list the
  // lightbox pages through for its "yearReview" source.
  const [yearReviews, setYearReviews] = useState<GalleryYearReview[]>([]);
  const [yearReviewAssets, setYearReviewAssets] = useState<GalleryAsset[]>([]);

  // Memories, scope-dependent like the facets; the date is the viewer's local
  // calendar day (the server may be in another timezone, and "on this day"
  // belongs to whoever is looking at the screen). perYear is the server-side
  // max so the Memories view has every photo, not a sample.
  const loadMemories = useCallback(async () => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const params = new URLSearchParams({ ...scopeParams(), date, perYear: "200" } as Record<string, string>);
    try {
      setMemories(await api<GalleryMemories>(`/api/library/gallery/memories?${params}`));
    } catch { /* advisory; the strip/view just stay empty */ }
  }, [scopeParams]);

  useEffect(() => { void loadMemories(); }, [loadMemories]);

  // Suggested memories (event/trip clusters). Loaded on mount too, so the Memories
  // tab can appear even when there are no "On this day" anniversaries today.
  const loadMemorySuggestions = useCallback(async () => {
    const params = new URLSearchParams({ ...scopeParams(), limit: "8" } as Record<string, string>);
    try {
      const payload = await api<{ suggestions: GalleryMemorySuggestion[] }>(`/api/library/gallery/memories/suggestions?${params}`);
      setMemorySuggestions(payload.suggestions);
    } catch { /* advisory; the section just stays empty */ }
  }, [scopeParams]);

  useEffect(() => { void loadMemorySuggestions(); }, [loadMemorySuggestions]);

  // Years in review, scoped like everything else here. Each card is a whole
  // selection pass over a year on the server, so only the most recent few are
  // asked for — one more than are shown, because the year still running is left
  // out: a look back at a year belongs to a year that is over. Loaded on mount
  // for the same reason as the suggestions: it can be what makes the Memories
  // tab appear at all.
  const loadYearReviews = useCallback(async () => {
    const params = new URLSearchParams({ ...scopeParams(), limit: "4" } as Record<string, string>);
    try {
      const payload = await api<{ suggestions: GalleryYearReview[] }>(`/api/library/gallery/year-review?${params}`);
      const thisYear = new Date().getFullYear();
      setYearReviews(payload.suggestions.filter((review) => review.year < thisYear).slice(0, 3));
    } catch { /* advisory; the section just stays hidden */ }
  }, [scopeParams]);

  useEffect(() => { void loadYearReviews(); }, [loadYearReviews]);

  // Play a year in the lightbox's own slideshow mode — the same player "Play"
  // runs on an album, not a player of its own. Its photos are fetched in the
  // film's order (lookup keeps the order asked for) and drop whatever this
  // viewer can no longer reach.
  const playYearReview = useCallback(async (review: GalleryYearReview) => {
    setError("");
    try {
      const payload = await api<{ assets: GalleryAsset[] }>("/api/library/gallery/assets/lookup", {
        method: "POST",
        // The lookup takes at most 100 ids; a year's film is 60 unless asked for more.
        body: JSON.stringify({ itemIds: review.itemIds.slice(0, 100) })
      });
      if (payload.assets.length === 0) {
        setError(t("gallery:suggestions.previewEmpty"));
        return;
      }
      setYearReviewAssets(payload.assets);
      setLightbox({ source: "yearReview", index: 0, autoPlay: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:yearReview.errors.play"));
    }
  }, [setError, setLightbox, t]);

  // Open a suggestion for preview: show its photos and let the user choose an action
  // (create a slideshow, or add the photos to an existing/new one). Nothing persists
  // until they pick one.
  const openSuggestionPreview = useCallback(async (suggestion: GalleryMemorySuggestion) => {
    setPreviewSuggestion(suggestion);
    setPreviewAssets(null);
    try {
      const payload = await api<{ assets: GalleryAsset[] }>("/api/library/gallery/assets/lookup", {
        method: "POST",
        body: JSON.stringify({ itemIds: suggestion.itemIds })
      });
      setPreviewAssets(payload.assets);
    } catch {
      setPreviewAssets([]); // grid stays empty; the actions still work
    }
  }, []);

  // Turn a suggested memory into a real slideshow (sourceKind=memory) and jump into
  // its editor, pre-filled with the montage. From there the user customizes/plays it.
  const createFromMemory = useCallback(async (suggestion: GalleryMemorySuggestion) => {
    setError("");
    try {
      const { slideshow } = await api<{ slideshow: GallerySlideshow }>("/api/library/gallery/slideshows", {
        method: "POST",
        body: JSON.stringify({ name: suggestion.title, itemIds: suggestion.itemIds, sourceKind: "memory", sourceRef: suggestion.id })
      });
      resetSlideshow();
      goToView("slideshows");
      await openSlideshow(slideshow.id);
      setNotice(t("gallery:memories.createdSlideshowNotice", { name: slideshow.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:memories.errors.createSlideshow"));
    }
  }, [openSlideshow, goToView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a year as a slideshow of one's own — for music, transitions, a movie.
  // Named here rather than by the server, whose title is English-only.
  const createFromYearReview = useCallback((review: GalleryYearReview) => (
    createFromMemory({ ...review, title: t("gallery:yearReview.slideshowName", { year: review.year }) })
  ), [createFromMemory, t]);

  // The Memories lightbox runs over ALL years flattened (newest year first,
  // chronological within a year), so Next flows from one year into the next.
  const memoryItems = useMemo(() => memories?.groups.flatMap((group) => group.items) ?? [], [memories]);

  // A strip card opens the viewer directly at that year's first photo (same as
  // the home page) — the full memory set is already loaded, no view switch.
  const openMemoryYear = useCallback((year: number) => {
    const groups = memories?.groups ?? [];
    let start = 0;
    for (const group of groups) {
      if (group.year === year) break;
      start += group.items.length;
    }
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    if (total === 0) return;
    setLightbox({ source: "memory", index: Math.min(start, total - 1) });
  }, [memories]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    memories, setMemories, memorySuggestions,
    previewSuggestion, setPreviewSuggestion, previewAssets,
    loadMemories, openSuggestionPreview, createFromMemory,
    memoryItems, openMemoryYear,
    yearReviews, yearReviewAssets, setYearReviewAssets, playYearReview, createFromYearReview
  };
}
