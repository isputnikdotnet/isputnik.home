import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tag } from "lucide-react";
import { api } from "../../api";
import { LightboxSuggestBox } from "./LightboxSuggestBox";

// Adding a tag from the lightbox's Details tab (LightboxSuggestBox). Tags are
// cross-type, so it offers the ones the gallery already uses, as GallerySetTags
// does — every book's subject heading as well would be a list nobody can read.
// The count is the tag's uses across the gallery: photos, albums and slideshows.
export function LightboxTagPicker({
  tags,
  busy,
  onPick,
  onClose
}: {
  /** On this photo already — not offered again. */
  tags: string[];
  busy: boolean;
  onPick: (tag: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["gallery"]);
  const [known, setKnown] = useState<{ name: string; galleryCount: number }[]>([]);

  useEffect(() => {
    let alive = true;
    api<{ tags: { name: string; galleryCount: number }[] }>("/api/library/tags")
      .then((payload) => { if (alive) setKnown(payload.tags.filter((tag) => tag.galleryCount > 0)); })
      .catch(() => { /* suggestions are advisory: a tag can still be typed */ });
    return () => { alive = false; };
  }, []);

  const onPhoto = new Set(tags.map((tag) => tag.toLowerCase()));
  const items = known
    .filter((tag) => !onPhoto.has(tag.name.toLowerCase()))
    .map((tag) => ({
      id: tag.name,
      name: tag.name,
      weight: tag.galleryCount,
      avatar: <Tag size={13} />,
      detail: t("gallery:lightbox.tagUses", { count: tag.galleryCount })
    }));

  return (
    <LightboxSuggestBox
      items={items}
      takenNames={tags}
      busy={busy}
      placeholder={t("gallery:lightbox.tagSearchPlaceholder")}
      ariaLabel={t("gallery:lightbox.tagSearchPlaceholder")}
      listLabel={t("gallery:lightbox.labelTags")}
      emptyHint={tags.length === 0 ? t("gallery:lightbox.tagsNoneYet") : undefined}
      newLabel={(name) => t("gallery:lightbox.addNewTag", { name })}
      onPick={(choice) => onPick(choice.name)}
      onClose={onClose}
    />
  );
}
