import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";
import { Button } from "../../shared/Button";
import { InlineEdit } from "../../shared/InlineEdit";
import { MessageBox } from "../../shared/MessageBox";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { faceFocusStyle } from "../gallery/types";
import { groupLayout } from "./story-layout";
import { PHOTO_GROUP_LAYOUTS, PHOTO_GROUP_MAX, type PhotoGroupLayout, type StoryBlock } from "./types";

/** The whole group, as a write: the server replaces the member list wholesale,
 *  so every edit here — reorder, remove, caption, add — sends the same shape. */
type GroupItem = { itemId: string; caption: string | null };

// The controls under a photo group's plate: which layout it wears, and the
// photos themselves — reorder, caption, remove, add more.
//
// It sits BELOW the reader's own rendering of the block (StoryBlockView), so an
// author sees the plate exactly as it will be read and arranges it underneath,
// rather than editing a second, tidier version of it.
export function StoryPhotoGroupEditor({
  block,
  busy,
  onPatch
}: {
  block: StoryBlock;
  busy: boolean;
  onPatch: (fields: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [adding, setAdding] = useState(false);
  const chosen: PhotoGroupLayout = groupLayout(block.layout);
  const items: GroupItem[] = block.items.map((photo) => ({ itemId: photo.id, caption: photo.blockCaption }));
  const room = PHOTO_GROUP_MAX - items.length;

  const write = (next: GroupItem[]) => onPatch({ items: next });

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    write(next);
  };

  return (
    <div className="story-photo-group-edit">
      {/* Which plate. A visible row rather than a menu entry: it is the one
          decision a group exists to carry, and the choice wants to be seen
          against the photos it changes. */}
      <div className="story-photo-layouts" role="tablist" aria-label={t("stories:photos.layoutLabel")}>
        {PHOTO_GROUP_LAYOUTS.map((layout) => (
          <Button
            key={layout}
            variant="tab"
            className="story-photo-layout"
            selected={chosen === layout}
            disabled={busy}
            // The name is the label, not the hint: with only `title` on it, a
            // screen reader announced "Uneven rows that keep each photo's own
            // shape" where a sighted reader sees "Collage". The hint stays as
            // the tooltip it was meant to be.
            aria-label={t(`stories:photos.layout.${layout}`)}
            title={t(`stories:photos.layoutHint.${layout}`)}
            onClick={() => onPatch({ layout })}
          >
            {t(`stories:photos.layout.${layout}`)}
          </Button>
        ))}
      </div>

      {items.length === 0 ? (
        <MessageBox tone="info" title={t("stories:photos.emptyTitle")}>
          {t("stories:photos.emptyBody")}
        </MessageBox>
      ) : (
        <ul className="story-photo-strip">
          {block.items.map((photo, index) => (
            <li className="story-photo-strip-item" key={photo.id}>
              <span className="story-photo-strip-thumb">
                <img
                  src={photo.coverUrl ?? photo.previewUrl ?? ""}
                  alt={photo.title}
                  loading="lazy"
                  style={faceFocusStyle(photo)}
                />
                {/* Order by button, not by drag alone: a plate is arranged as
                    often from a keyboard as from a mouse, and a drag handle
                    reachable by neither is no handle at all. */}
                <span className="story-photo-strip-tools">
                  <Button
                    variant="icon"
                    compact
                    disabled={busy || index === 0}
                    aria-label={t("stories:photos.moveEarlier")}
                    title={t("stories:photos.moveEarlier")}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="icon"
                    compact
                    disabled={busy || index === items.length - 1}
                    aria-label={t("stories:photos.moveLater")}
                    title={t("stories:photos.moveLater")}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="icon"
                    compact
                    danger
                    disabled={busy}
                    aria-label={t("stories:photos.removeAria", { title: photo.title })}
                    title={t("stories:photos.remove")}
                    onClick={() => write(items.filter((_, at) => at !== index))}
                  >
                    <X size={14} aria-hidden="true" />
                  </Button>
                </span>
              </span>
              {/* This photo's own line, on this plate — not the photo's title,
                  and not the group's caption. */}
              <InlineEdit
                className="story-photo-strip-caption"
                value={photo.blockCaption ?? ""}
                ariaLabel={t("stories:photos.captionAria", { title: photo.title })}
                placeholder={t("stories:photos.captionPlaceholder")}
                maxLength={500}
                onSave={(next) => write(items.map((item, at) =>
                  at === index ? { ...item, caption: next || null } : item
                ))}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="story-photo-group-actions">
        <Button
          variant="secondary"
          compact
          disabled={busy || room <= 0}
          title={room <= 0 ? t("stories:photos.fullHint", { max: PHOTO_GROUP_MAX }) : undefined}
          onClick={() => setAdding(true)}
        >
          <ImagePlus size={15} aria-hidden="true" />
          <span>{t("stories:photos.add")}</span>
        </Button>
        <small className="muted">{t("stories:photos.count", { count: items.length })}</small>
      </div>

      {adding && (
        <PhotoPicker
          title={t("stories:photos.add")}
          // Already on the plate: shown as "Added" rather than offered twice.
          existingIds={items.map((item) => item.itemId)}
          onAttach={async (itemIds) => {
            setAdding(false);
            // Appended in the order they were chosen, and capped where the
            // server caps: the dialog can gather more than a plate may hold.
            write([...items, ...itemIds.slice(0, room).map((itemId) => ({ itemId, caption: null }))]);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
