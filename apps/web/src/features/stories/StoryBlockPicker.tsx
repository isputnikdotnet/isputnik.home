import { useTranslation } from "react-i18next";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryAudioModal } from "./StoryAudioModal";
import { StoryMapModal } from "./StoryMapModal";
import { StoryRefPicker } from "./StoryRefPicker";
import type { StoryBlock, StoryBlockKind } from "./types";

/** Every kind that points at something, and so has something to pick. `text` is
 *  the exception — it carries its own content and is written in place. */
export type PickableKind = Exclude<StoryBlockKind, "text">;

export function isPickable(kind: StoryBlockKind): kind is PickableKind {
  return kind !== "text";
}

/** Narrow a media pick to one gallery kind. "video" lists videos alone — the
 *  block is the same media block either way. */
export type MediaOnly = "video";

// The one place that knows which chooser a block kind needs. Adding a block and
// changing what an existing one points at are the same question — "which photo,
// which album, which place?" — so they ask it with the same dialog, and a kind
// added here becomes editable and insertable in one go.
export function StoryBlockPicker({
  kind,
  only,
  storyId,
  storyTags,
  block,
  onPick,
  onClose
}: {
  kind: PickableKind;
  /** For a media block: browse only this gallery kind (the "Video" choice). */
  only?: MediaOnly;
  storyId: string;
  /** Lets the pickers offer content sharing the story's tags first. */
  storyTags?: string[];
  /** The block being changed; omitted when picking for a new one. A map opens
   *  on its own pin rather than on an empty world. */
  block?: StoryBlock;
  /** The fields to write — on a new block or over the old one. */
  onPick: (fields: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);

  if (kind === "media") {
    return (
      <PhotoPicker
        title={only === "video" ? t("stories:picker.videoTitle") : t("stories:picker.photoTitle")}
        pick={only ?? "any"}
        onPick={(asset) => { onClose(); onPick({ entityId: asset.id }); }}
        onClose={onClose}
      />
    );
  }

  if (kind === "map") {
    return (
      <StoryMapModal
        initial={block && block.lat != null && block.lng != null
          ? { lat: block.lat, lng: block.lng, zoom: block.zoom, label: block.label, points: block.points }
          : null}
        onSave={(value) => { onClose(); onPick(value); }}
        onClose={onClose}
      />
    );
  }

  if (kind === "audio") {
    return (
      <StoryAudioModal
        storyId={storyId}
        onAdded={(audioId) => { onClose(); onPick({ entityId: audioId }); }}
        onClose={onClose}
      />
    );
  }

  return (
    <StoryRefPicker
      kind={kind}
      storyTags={storyTags}
      onPick={(id, entityType) => {
        onClose();
        // A book pick carries which shelf it came from; the block keeps it.
        onPick(kind === "book" ? { entityId: id, entityType } : { entityId: id });
      }}
      onClose={onClose}
    />
  );
}
