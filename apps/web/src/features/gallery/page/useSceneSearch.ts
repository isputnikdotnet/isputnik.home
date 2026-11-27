import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import type { GalleryFilters } from "../GalleryFilter";
import type { GalleryAsset } from "../types";

/** Shorter than this is a letter, not something to look for. */
const MIN_QUERY = 2;

// Search by what a photo shows (docs/scene-search-plan.md): asked beside the
// Timeline's search by name, with the same words and filters, and shown above it
// as "Looks like …". It is an extra: when the feature is off, the engine is away
// or the request fails, there is simply no such section, and nothing is said.
export function useSceneSearch({
  active,
  query,
  filters,
  peopleMatchAll
}: {
  /** The Timeline is on screen; other views have no search by content. */
  active: boolean;
  query: string;
  filters: GalleryFilters;
  peopleMatchAll: boolean;
}) {
  const [sceneAssets, setSceneAssets] = useState<GalleryAsset[]>([]);
  // The words the photos on screen were found for: results for an older search
  // must not sit under a newer one while its own are on their way.
  const [sceneQuery, setSceneQuery] = useState("");
  const latest = useRef(0);

  const reloadScene = useCallback(async () => {
    const ticket = latest.current + 1;
    latest.current = ticket;
    const words = query.trim();
    if (!active || words.length < MIN_QUERY) {
      setSceneAssets([]);
      setSceneQuery("");
      return;
    }
    try {
      const payload = await api<{ available: boolean; assets: GalleryAsset[] }>("/api/library/gallery/scene/search", {
        method: "POST",
        body: JSON.stringify({ q: words, kinds: filters.kinds, filters: { ...filters, peopleMatch: peopleMatchAll ? "all" : "any" } })
      });
      if (latest.current !== ticket) return;
      setSceneAssets(payload.available ? payload.assets : []);
      setSceneQuery(words);
    } catch {
      if (latest.current !== ticket) return;
      setSceneAssets([]);
      setSceneQuery("");
    }
  }, [active, query, filters, peopleMatchAll]);

  useEffect(() => { void reloadScene(); }, [reloadScene]);

  return { sceneAssets: sceneQuery === query.trim() ? sceneAssets : [], setSceneAssets, reloadScene };
}
