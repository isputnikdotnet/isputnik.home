import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Clapperboard,
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
import { StoryBlockPicker, type MediaOnly, type PickableKind } from "./StoryBlockPicker";
import { useRecordingsTarget } from "./useRecordingsTarget";
import type { StoryBlockKind } from "./types";

/** What the dialog offers. A choice is a block kind plus, for the gallery, which
 *  of its kinds to browse: "Photo" and "Video" both make a media block, but a
 *  video is a hunt through a gallery of photos unless the picker lists videos
 *  alone — so the choice, not the block, carries the difference. */
interface BlockChoice {
  key: "text" | "media" | "video" | "album" | "slideshow" | "map" | "person" | "quote" | "book" | "audio";
  kind: StoryBlockKind;
  icon: LucideIcon;
  only?: MediaOnly;
}

/** The order they are offered in: prose first, then what the library can lend. */
const BLOCK_CHOICES: BlockChoice[] = [
  { key: "text", kind: "text", icon: Type },
  { key: "media", kind: "media", icon: Images },
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
  onAdd: (kind: StoryBlockKind, fields?: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const recordings = useRecordingsTarget();
  const [choosing, setChoosing] = useState(false);
  const [picking, setPicking] = useState<{ kind: PickableKind; only?: MediaOnly } | null>(null);

  const choose = (choice: BlockChoice) => {
    setChoosing(false);
    // Prose has nothing to pick: the block is the writing surface.
    if (choice.kind === "text") onAdd("text", { body: "" });
    else setPicking({ kind: choice.kind, only: choice.only });
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

      {picking && (
        <StoryBlockPicker
          kind={picking.kind}
          only={picking.only}
          storyId={storyId}
          storyTags={storyTags}
          onPick={(fields) => onAdd(picking.kind, fields)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
