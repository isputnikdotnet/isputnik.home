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
  coverUrl,
  inherited = false,
  pickerTitle,
  pin,
  useMap = false,
  extraActions,
  onPick,
  onClear,
  onUseMap
}: {
  /** What to draw, resolved for this viewer; null = nothing set. A cover is
   *  usually a photo, but a review may wear the book's own artwork. */
  coverUrl: string | null;
  /** True = what is drawn belongs to the story, not to this chapter — a
   *  chapter with no cover of its own borrows the story's rather than opening
   *  on a grey box. It is a picture, not a choice: there is nothing here to
   *  remove, and choosing one replaces it for this chapter only. */
  inherited?: boolean;
  pickerTitle: string;
  /** The chapter's place, when it has one — what "Use map as cover" draws. */
  pin?: { lat: number; lng: number; label: string } | null;
  useMap?: boolean;
  /** Other places this cover could come from — a review's book, say. Offered
   *  in the same menu, because "where does this picture come from" is one
   *  question with several answers, not several buttons. */
  extraActions?: ActionMenuItem[];
  onPick: (asset: GalleryAsset) => void;
  onClear: () => void;
  /** Omitted where a map cover makes no sense (the story's own front page). */
  onUseMap?: (next: boolean) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [picking, setPicking] = useState(false);

  const showingMap = Boolean(useMap && pin);
  const empty = !showingMap && !coverUrl;
  // A borrowed picture is not this object's cover: there is nothing to change
  // and nothing to remove, only a cover to choose.
  const owned = Boolean(showingMap || (coverUrl && !inherited));

  const items: ActionMenuItem[] = [
    {
      key: "photo",
      label: owned ? t("stories:edit.coverChangePhoto") : t("stories:edit.coverChoosePhoto"),
      icon: <ImageIcon size={15} aria-hidden="true" />,
      onSelect: () => setPicking(true)
    },
    ...(extraActions ?? [])
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
  if (owned) {
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
      ) : coverUrl ? (
        <img src={coverUrl} alt="" />
      ) : (
        <p className="story-edit-cover-empty">
          <ImagePlus size={20} aria-hidden="true" />
          <span>{t("stories:edit.coverEmpty")}</span>
        </p>
      )}

      {inherited && !showingMap && coverUrl && (
        <p className="story-edit-cover-note">{t("stories:edit.coverFromStory")}</p>
      )}

      <div className="story-edit-cover-actions">
        <ActionMenu
          label={owned ? t("stories:edit.editCover") : t("stories:edit.addCover")}
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
