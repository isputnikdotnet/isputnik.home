import { useTranslation } from "react-i18next";
import { BookOpen, Headphones, Image as ImageIcon, type LucideIcon } from "lucide-react";

export type MediaKind = "audiobook" | "ebook" | "gallery";

const KIND_META: Record<MediaKind, { labelKey: "audiobook" | "ebook" | "gallery"; Icon: LucideIcon }> = {
  audiobook: { labelKey: "audiobook", Icon: Headphones },
  ebook: { labelKey: "ebook", Icon: BookOpen },
  gallery: { labelKey: "gallery", Icon: ImageIcon }
};

// Global indicator of an item's media type, for surfaces that mix audiobooks and
// ebooks (home rows, the cross-type feed, category detail). `overlay` pins it to
// the top-right of a cover as a high-contrast pill; `showLabel` adds the text.
export function MediaKindBadge({
  kind,
  overlay = false,
  showLabel = false,
  size = 16
}: {
  kind: MediaKind;
  overlay?: boolean;
  showLabel?: boolean;
  size?: number;
}) {
  const { t } = useTranslation(["common"]);
  const { labelKey, Icon } = KIND_META[kind];
  const label = t(`common:mediaKind.${labelKey}`);
  return (
    <span
      className={`media-kind-badge ${kind}${overlay ? " overlay" : ""}${showLabel ? " labeled" : ""}`}
      title={label}
      aria-label={label}
    >
      <Icon size={size} aria-hidden="true" />
      {showLabel && <span>{label}</span>}
    </span>
  );
}
