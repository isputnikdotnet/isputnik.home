import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Clapperboard,
  Image,
  Images,
  LayoutGrid,
  MapPin,
  Mic,
  Play,
  Plus,
  Quote,
  Type,
  UserRound,
  type LucideIcon
} from "lucide-react";
import { Button } from "../../shared/Button";
import { Modal } from "../../shared/Modal";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryBlockPicker, isPickable, type MediaOnly, type PickableKind } from "./StoryBlockPicker";
import { useRecordingsTarget } from "./useRecordingsTarget";
import { PHOTO_GROUP_MAX, type StoryBlockKind } from "./types";

/** What the dialog offers. A choice is a block kind plus, for the gallery, how
 *  to browse it: "Photo" and "Video" both make a media block, but a video is a
 *  hunt through a gallery of photos unless the picker lists videos alone — so
 *  the choice, not the block, carries the difference.
 *
 *  "Photos" makes a different block entirely: a `photos` GROUP holding the
 *  whole batch. It used to make one media block per photo and let the reading
 *  view guess they belonged together; the group says so, and carries how it is
 *  laid out (mosaic, grid or stacked). */
interface BlockChoice {
  key: "text" | "media" | "photos" | "video" | "album" | "slideshow" | "map" | "person" | "quote" | "book" | "audio";
  kind: StoryBlockKind;
  icon: LucideIcon;
  only?: MediaOnly;
  /** Pick several, into ONE group block. */
  group?: boolean;
}

/** The order they are offered in: prose first, then what the library can lend. */
const BLOCK_CHOICES: BlockChoice[] = [
  { key: "text", kind: "text", icon: Type },
  { key: "media", kind: "media", icon: Image },
  { key: "photos", kind: "photos", icon: LayoutGrid, group: true },
  { key: "video", kind: "media", icon: Clapperboard, only: "video" },
  { key: "album", kind: "album", icon: Images },
  { key: "slideshow", kind: "slideshow", icon: Play },
  { key: "map", kind: "map", icon: MapPin },
  { key: "person", kind: "person", icon: UserRound },
  { key: "quote", kind: "quote", icon: Quote },
  { key: "book", kind: "book", icon: BookOpen },
  { key: "audio", kind: "audio", icon: Mic }
];

// The insert point between blocks. It opens a dialog rather than a menu: the
// kinds are a choice worth seeing laid out — each with a line saying what it
// actually puts on the page — and a nine-item popover said only their names.
export function AddStoryBlock({
  storyId,
  storyTags,
  busy,
  onAdd
}: {
  storyId: string;
  storyTags: string[];
  busy: boolean;
  /** One entry per block to make. Almost always a list of one — a handful of
   *  photos is ONE group block carrying them all, not a block each. */
  onAdd: (kind: StoryBlockKind, fieldsList: Record<string, unknown>[]) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const recordings = useRecordingsTarget();
  const [choosing, setChoosing] = useState(false);
  const [picking, setPicking] = useState<
    { kind: "photos"; group: true } | { kind: PickableKind; only?: MediaOnly; group?: false }
  >();

  const choose = (choice: BlockChoice) => {
    setChoosing(false);
    // Prose has nothing to pick: the block is the writing surface.
    if (choice.kind === "text") onAdd("text", [{ body: "" }]);
    else if (choice.group) setPicking({ kind: "photos", group: true });
    else if (isPickable(choice.kind)) setPicking({ kind: choice.kind, only: choice.only });
  };

  return (
    <div className="story-add-block">
      <Button
        variant="secondary"
        compact
        className="story-add-block-button"
        onClick={() => setChoosing(true)}
        disabled={busy}
      >
        <Plus size={15} aria-hidden="true" />
        <span>{t("stories:edit.addBlock")}</span>
      </Button>

      {choosing && (
        <Modal
          variant="panel"
          title={t("stories:edit.addBlock")}
          subtitle={t("stories:edit.addBlockIntro")}
          icon={<LayoutGrid size={22} />}
          className="story-add-block-modal"
          onClose={() => setChoosing(false)}
        >
          <div className="modal-tab-content story-add-block-content">
            <div className="story-block-kind-grid">
              {BLOCK_CHOICES.map((choice) => {
                const { key, kind, icon: Icon } = choice;
                // Recording needs a destination: the affordance exists only once
                // an admin has nominated the recordings library. Members see
                // nothing until then; an admin sees it disabled, pointing at the
                // setting.
                if (kind === "audio" && !recordings.enabled && !recordings.isAdmin) return null;
                const blocked = kind === "audio" && !recordings.enabled;
                return (
                  <Button
                    key={key}
                    variant="secondary"
                    className="story-block-kind"
                    disabled={blocked}
                    title={blocked ? t("stories:audio.needsLibraryHint") : undefined}
                    onClick={() => choose(choice)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <strong>{t(`stories:kind.${key}`)}</strong>
                    <small>{t(`stories:kindHint.${key}`)}</small>
                  </Button>
                );
              })}
            </div>

            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setChoosing(false)}>
                {t("common:common.cancel")}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {picking?.group && (
        // Several photos in one go: the picker's multi-select mode, with its
        // tray and Add button. The batch becomes ONE group block, in the order
        // it was chosen, wearing the mosaic plate until the author says
        // otherwise. The dialog closes on it, since the author asked for these
        // photos here, not for a session of adding.
        <PhotoPicker
          title={t("stories:picker.photosTitle")}
          onAttach={async (itemIds) => {
            setPicking(undefined);
            onAdd("photos", [{
              layout: "mosaic",
              items: itemIds.slice(0, PHOTO_GROUP_MAX).map((itemId) => ({ itemId }))
            }]);
          }}
          onClose={() => setPicking(undefined)}
        />
      )}

      {picking && !picking.group && (
        <StoryBlockPicker
          kind={picking.kind}
          only={picking.only}
          storyId={storyId}
          storyTags={storyTags}
          onPick={(fields) => onAdd(picking.kind, [fields])}
          onClose={() => setPicking(undefined)}
        />
      )}
    </div>
  );
}
