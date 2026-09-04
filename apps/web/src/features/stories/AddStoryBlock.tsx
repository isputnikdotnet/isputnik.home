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
import { StoryBlockPicker, type MediaOnly, type PickableKind } from "./StoryBlockPicker";
import { useRecordingsTarget } from "./useRecordingsTarget";
import type { StoryBlockKind } from "./types";

/** What the dialog offers. A choice is a block kind plus, for the gallery, how
 *  to browse it: "Photo", "Photos" and "Video" all make media blocks, but a
 *  video is a hunt through a gallery of photos unless the picker lists videos
 *  alone, and a handful of photos is one trip through the picker rather than
 *  five — so the choice, not the block, carries the difference. */
interface BlockChoice {
  key: "text" | "media" | "photos" | "video" | "album" | "slideshow" | "map" | "person" | "quote" | "book" | "audio";
  kind: StoryBlockKind;
  icon: LucideIcon;
  only?: MediaOnly;
  /** Pick several; each becomes a block of its own, in the order chosen. */
  many?: boolean;
}

/** The order they are offered in: prose first, then what the library can lend. */
const BLOCK_CHOICES: BlockChoice[] = [
  { key: "text", kind: "text", icon: Type },
  { key: "media", kind: "media", icon: Image },
  { key: "photos", kind: "media", icon: Images, many: true },
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
  /** One entry per block to make: a single pick is a list of one, a handful of
   *  photos a list of several, in the order they were chosen. */
  onAdd: (kind: StoryBlockKind, fieldsList: Record<string, unknown>[]) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const recordings = useRecordingsTarget();
  const [choosing, setChoosing] = useState(false);
  const [picking, setPicking] = useState<{ kind: PickableKind; only?: MediaOnly; many?: boolean } | null>(null);

  const choose = (choice: BlockChoice) => {
    setChoosing(false);
    // Prose has nothing to pick: the block is the writing surface.
    if (choice.kind === "text") onAdd("text", [{ body: "" }]);
    else setPicking({ kind: choice.kind, only: choice.only, many: choice.many });
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

      {picking && picking.many && (
        // Several photos in one go: the picker's multi-select mode, with its
        // tray and Add button. The batch lands as consecutive blocks — which
        // the page lays out side by side — and the dialog closes on it, since
        // the author asked for these photos here, not for a session of adding.
        <PhotoPicker
          title={t("stories:picker.photosTitle")}
          onAttach={async (itemIds) => {
            setPicking(null);
            onAdd("media", itemIds.map((entityId) => ({ entityId })));
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {picking && !picking.many && (
        <StoryBlockPicker
          kind={picking.kind}
          only={picking.only}
          storyId={storyId}
          storyTags={storyTags}
          onPick={(fields) => onAdd(picking.kind, [fields])}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
