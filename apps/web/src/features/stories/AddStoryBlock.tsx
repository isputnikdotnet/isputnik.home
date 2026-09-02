import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
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
import { StoryBlockPicker, type PickableKind } from "./StoryBlockPicker";
import { useRecordingsTarget } from "./useRecordingsTarget";
import type { StoryBlockKind } from "./types";

const BLOCK_ICONS: Record<StoryBlockKind, LucideIcon> = {
  text: Type,
  media: Images,
  album: Images,
  slideshow: Play,
  map: MapPin,
  person: UserRound,
  quote: Quote,
  book: BookOpen,
  audio: Mic
};

/** The order they are offered in: prose first, then what the library can lend. */
const BLOCK_KINDS: StoryBlockKind[] = [
  "text", "media", "album", "slideshow", "map", "person", "quote", "book", "audio"
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
  const [picking, setPicking] = useState<PickableKind | null>(null);

  const choose = (kind: StoryBlockKind) => {
    setChoosing(false);
    // Prose has nothing to pick: the block is the writing surface.
    if (kind === "text") onAdd("text", { body: "" });
    else setPicking(kind);
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
              {BLOCK_KINDS.map((kind) => {
                const Icon = BLOCK_ICONS[kind];
                // Recording needs a destination: the affordance exists only once
                // an admin has nominated the recordings library. Members see
                // nothing until then; an admin sees it disabled, pointing at the
                // setting.
                if (kind === "audio" && !recordings.enabled && !recordings.isAdmin) return null;
                const blocked = kind === "audio" && !recordings.enabled;
                return (
                  <Button
                    key={kind}
                    variant="secondary"
                    className="story-block-kind"
                    disabled={blocked}
                    title={blocked ? t("stories:audio.needsLibraryHint") : undefined}
                    onClick={() => choose(kind)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <strong>{t(`stories:kind.${kind}`)}</strong>
                    <small>{t(`stories:kindHint.${kind}`)}</small>
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
          kind={picking}
          storyId={storyId}
          storyTags={storyTags}
          onPick={(fields) => onAdd(picking, fields)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
