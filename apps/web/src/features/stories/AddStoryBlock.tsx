import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Images, MapPin, Mic, Play, Plus, Quote, Type, UserRound } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "../../shared/ActionMenu";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryAudioModal } from "./StoryAudioModal";
import { StoryMapModal } from "./StoryMapModal";
import { StoryRefPicker, type RefKind } from "./StoryRefPicker";
import { useRecordingsTarget } from "./useRecordingsTarget";
import type { StoryBlockKind } from "./types";

// The insert point that sits between blocks. It used to be a row of nine
// buttons under every chapter, which read as a toolbar the chapter was wearing;
// as one menu it is a single decision — "something goes here" — and the kinds
// stay a list rather than a wall.
export function AddStoryBlock({
  storyId,
  storyTags,
  busy,
  onAdd
}: {
  storyId: string;
  /** Lets the pickers offer content that shares the story's tags first. */
  storyTags: string[];
  busy: boolean;
  onAdd: (kind: StoryBlockKind, fields?: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const recordings = useRecordingsTarget();
  const [picker, setPicker] = useState<"photo" | "map" | "audio" | RefKind | null>(null);

  const items: ActionMenuItem[] = [
    {
      key: "text",
      label: t("stories:kind.text"),
      icon: <Type size={15} aria-hidden="true" />,
      onSelect: () => onAdd("text", { body: "" })
    },
    {
      key: "media",
      label: t("stories:kind.media"),
      icon: <Images size={15} aria-hidden="true" />,
      onSelect: () => setPicker("photo")
    },
    {
      key: "album",
      label: t("stories:kind.album"),
      icon: <Images size={15} aria-hidden="true" />,
      onSelect: () => setPicker("album")
    },
    {
      key: "slideshow",
      label: t("stories:kind.slideshow"),
      icon: <Play size={15} aria-hidden="true" />,
      onSelect: () => setPicker("slideshow")
    },
    {
      key: "map",
      label: t("stories:kind.map"),
      icon: <MapPin size={15} aria-hidden="true" />,
      onSelect: () => setPicker("map")
    },
    {
      key: "person",
      label: t("stories:kind.person"),
      icon: <UserRound size={15} aria-hidden="true" />,
      onSelect: () => setPicker("person")
    },
    {
      key: "quote",
      label: t("stories:kind.quote"),
      icon: <Quote size={15} aria-hidden="true" />,
      onSelect: () => setPicker("quote")
    },
    {
      key: "book",
      label: t("stories:kind.book"),
      icon: <BookOpen size={15} aria-hidden="true" />,
      onSelect: () => setPicker("book")
    }
  ];

  // Recording needs a destination: the affordance exists only once an admin has
  // nominated the recordings library. Members see nothing until then; an admin
  // sees it disabled, pointing at the setting.
  if (recordings.enabled || recordings.isAdmin) {
    items.push({
      key: "audio",
      label: t("stories:kind.audio"),
      icon: <Mic size={15} aria-hidden="true" />,
      disabledReason: recordings.enabled ? undefined : t("stories:audio.needsLibraryHint"),
      onSelect: () => setPicker("audio")
    });
  }

  return (
    <div className="story-add-block">
      <ActionMenu
        label={t("stories:edit.addBlock")}
        icon={<Plus size={15} aria-hidden="true" />}
        items={items}
        compact
        className="story-add-block-menu"
      />

      {picker === "photo" && (
        <PhotoPicker
          title={t("stories:picker.photoTitle")}
          pick="any"
          onPick={(asset) => { setPicker(null); onAdd("media", { entityId: asset.id }); }}
          onClose={() => setPicker(null)}
        />
      )}

      {(picker === "album" || picker === "slideshow" || picker === "person" || picker === "quote" || picker === "book") && (
        <StoryRefPicker
          kind={picker}
          storyTags={storyTags}
          onPick={(id, entityType) => {
            const kind = picker;
            setPicker(null);
            // A book pick carries which shelf it came from; the block keeps it.
            onAdd(kind, kind === "book" ? { entityId: id, entityType } : { entityId: id });
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {picker === "map" && (
        <StoryMapModal
          initial={null}
          onSave={(value) => { setPicker(null); onAdd("map", value); }}
          onClose={() => setPicker(null)}
        />
      )}

      {picker === "audio" && (
        <StoryAudioModal
          storyId={storyId}
          onAdded={(audioId) => { setPicker(null); onAdd("audio", { entityId: audioId }); }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
