import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, ImagePlus, MapPin, Pencil, Trash2 } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "../../shared/ActionMenu";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryMap } from "./StoryMap";
import type { GalleryAsset } from "../gallery/types";

// The wide cover a story's front page and every chapter opens with, plus the
// one menu that changes it. The picture IS the control: the menu sits on the
// banner rather than in a form below it, so choosing a cover reads like
// dressing the page instead of filling in a field.
//
// A chapter with a pin can wear the map instead of a photo — same banner, same
// menu, so the two covers are one decision and not two competing fields.
export function StoryCoverBanner({
  cover,
  pickerTitle,
  pin,
  useMap = false,
  onPick,
  onClear,
  onUseMap
}: {
  /** The chosen photo, resolved for this viewer; null = nothing set. */
  cover: GalleryAsset | null;
  pickerTitle: string;
  /** The chapter's place, when it has one — what "Use map as cover" draws. */
  pin?: { lat: number; lng: number; label: string } | null;
  useMap?: boolean;
  onPick: (asset: GalleryAsset) => void;
  onClear: () => void;
  /** Omitted where a map cover makes no sense (the story's own front page). */
  onUseMap?: (next: boolean) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [picking, setPicking] = useState(false);

  const showingMap = Boolean(useMap && pin);
  const empty = !showingMap && !cover?.coverUrl;

  const items: ActionMenuItem[] = [
    {
      key: "photo",
      label: cover ? t("stories:edit.coverChangePhoto") : t("stories:edit.coverChoosePhoto"),
      icon: <ImageIcon size={15} aria-hidden="true" />,
      onSelect: () => setPicking(true)
    }
  ];
  if (onUseMap) {
    items.push({
      key: "map",
      label: showingMap ? t("stories:edit.coverUsePhoto") : t("stories:edit.coverUseMap"),
      icon: <MapPin size={15} aria-hidden="true" />,
      disabledReason: pin ? undefined : t("stories:edit.coverNeedsPin"),
      onSelect: () => onUseMap(!showingMap)
    });
  }
  if (cover || showingMap) {
    items.push({
      key: "clear",
      label: t("stories:edit.coverRemove"),
      icon: <Trash2 size={15} aria-hidden="true" />,
      danger: true,
      onSelect: onClear
    });
  }

  return (
    <div className={`story-edit-cover${empty ? " is-empty" : ""}`}>
      {showingMap && pin ? (
        <div className="story-edit-cover-map">
          <StoryMap
            pins={[{ id: "cover", lat: pin.lat, lng: pin.lng, label: "", title: pin.label }]}
            onOpen={() => {}}
          />
        </div>
      ) : cover?.coverUrl ? (
        <img src={cover.coverUrl} alt="" />
      ) : (
        <p className="story-edit-cover-empty">
          <ImagePlus size={20} aria-hidden="true" />
          <span>{t("stories:edit.coverEmpty")}</span>
        </p>
      )}

      <div className="story-edit-cover-actions">
        <ActionMenu
          label={empty ? t("stories:edit.addCover") : t("stories:edit.editCover")}
          icon={<Pencil size={15} aria-hidden="true" />}
          items={items}
          compact
          className="story-edit-cover-menu"
        />
      </div>

      {picking && (
        <PhotoPicker
          title={pickerTitle}
          pick="any"
          onPick={(asset) => { setPicking(false); onPick(asset); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
