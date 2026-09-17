import { useTranslation } from "react-i18next";
import { SuggestBox } from "../../shared/tags/SuggestBox";
import type { GalleryPerson, GalleryPersonTag } from "./types";

// Tagging a person from the lightbox's Details tab (shared/tags/SuggestBox): each row
// wears the person's face and photo count, so two Annas can be told apart.
export function LightboxPeoplePicker({
  people,
  tagged,
  busy,
  onPick,
  onClose
}: {
  /** Everyone the library knows. */
  people: GalleryPerson[];
  /** Already on this photo — not offered again. */
  tagged: GalleryPersonTag[];
  busy: boolean;
  /** An existing person, or a name to create one from. */
  onPick: (choice: { personId: string } | { name: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["gallery", "galleryReview"]);
  const taggedIds = new Set(tagged.map((person) => person.id));
  const items = people
    .filter((person) => person.name && !taggedIds.has(person.id))
    .map((person) => ({
      id: person.id,
      name: person.name,
      weight: person.faceCount,
      avatar: person.coverUrl ? <img src={person.coverUrl} alt="" /> : person.name.slice(0, 1).toUpperCase(),
      detail: person.faceCount > 0 ? t("gallery:common.counts.photo", { count: person.faceCount }) : undefined
    }));

  return (
    <SuggestBox
      items={items}
      takenNames={tagged.map((person) => person.name)}
      busy={busy}
      placeholder={t("galleryReview:who.searchPlaceholder")}
      ariaLabel={t("galleryReview:who.searchAria")}
      listLabel={t("gallery:lightbox.labelPeople")}
      emptyHint={tagged.length === 0 ? t("galleryReview:who.nobodyYet") : undefined}
      newLabel={(name) => t("gallery:lightbox.addNewPerson", { name })}
      onPick={(choice) => onPick("id" in choice ? { personId: choice.id } : { name: choice.name })}
      onClose={onClose}
    />
  );
}
