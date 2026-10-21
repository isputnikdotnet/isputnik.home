import type { GalleryAsset } from "../gallery/types";
import type { StoryDetail } from "./types";

/** Every photo a story already shows, once each, for choosing a cover from
 *  what is on the page rather than from the whole library: single photos,
 *  the photos of a group, and the previewed photos of an album or slideshow.
 *  Chapter order, with `firstChapterId`'s photos first — a chapter's cover
 *  most likely lives in that chapter. */
export function storyPhotos(story: StoryDetail, firstChapterId?: string): GalleryAsset[] {
  const chapters = [...story.chapters].sort((a, b) =>
    (a.id === firstChapterId ? 0 : 1) - (b.id === firstChapterId ? 0 : 1) || a.position - b.position);
  const seen = new Set<string>();
  const photos: GalleryAsset[] = [];
  const add = (asset: GalleryAsset | null | undefined) => {
    if (!asset || asset.kind !== "photo" || !asset.coverUrl || seen.has(asset.id)) return;
    seen.add(asset.id);
    photos.push(asset);
  };
  for (const chapter of chapters) {
    add(chapter.hero);
    for (const block of chapter.blocks) {
      add(block.asset);
      block.items.forEach(add);
      block.preview.forEach(add);
    }
  }
  return photos;
}
