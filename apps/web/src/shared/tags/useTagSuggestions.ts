import { useEffect, useState } from "react";
import { api } from "../../api";

// The tags worth offering where something is being tagged. Tags are cross-type, so
// a photo is offered the tags photos already wear and a story the ones stories
// wear — every book's subject heading under a photo is a list nobody can read.
// `uses` is how many things of those kinds wear the tag: the list's order, and the
// "used 12 times" at a row's end.

export interface TagSuggestion {
  name: string;
  /** Unknown for a vocabulary that has no counts. */
  uses?: number;
}

export type TagScope = "audiobook" | "ebook" | "gallery" | "story" | "family";

interface TagListEntry {
  name: string;
  audiobookCount: number;
  ebookCount: number;
  galleryCount: number;
  familyCount: number;
  storyCount: number;
}

const COUNT: Record<TagScope, keyof Omit<TagListEntry, "name">> = {
  audiobook: "audiobookCount",
  ebook: "ebookCount",
  gallery: "galleryCount",
  story: "storyCount",
  family: "familyCount"
};

export function useTagSuggestions(scope: TagScope | TagScope[], enabled = true): TagSuggestion[] {
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const key = ([] as TagScope[]).concat(scope).join(",");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const scopes = key.split(",") as TagScope[];
    api<{ tags: TagListEntry[] }>("/api/library/tags")
      .then((payload) => {
        if (!alive) return;
        setSuggestions(payload.tags
          .map((tag) => ({ name: tag.name, uses: scopes.reduce((sum, s) => sum + (tag[COUNT[s]] ?? 0), 0) }))
          .filter((tag) => tag.uses > 0));
      })
      // Suggestions are advisory: a tag can still be typed.
      .catch(() => { if (alive) setSuggestions([]); });
    return () => { alive = false; };
  }, [key, enabled]);

  return suggestions;
}
