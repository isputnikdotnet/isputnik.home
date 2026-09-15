import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { Button } from "../../../shared/Button";
import { AssetTile, type LightboxSource } from "../AssetTile";
import type { GalleryAsset, GalleryMemories } from "../types";
import { memoryDateLabel, yearsAgo } from "./gallery-page-model";

// "On this day": one section per year, each selectable and shareable as a group.
export function MemoriesView({
  memories,
  selectionMode,
  selectedIds,
  toggleSelect,
  toggleDaySelect,
  toggleAssetLike,
  openLightbox,
  canShareAny,
  onShare
}: {
  memories: GalleryMemories | null;
  selectionMode: boolean;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleDaySelect: (ids: string[]) => void;
  toggleAssetLike: (asset: GalleryAsset, next: boolean) => Promise<void>;
  openLightbox: (source: LightboxSource, index: number) => void;
  canShareAny: boolean;
  onShare: (ids: string[]) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);

  if (!((memories?.groups.length ?? 0) > 0)) {
    return (
      <div className="empty-state library-empty">
        <Sparkles size={48} aria-hidden="true" />
        <h2>{t("gallery:memories.emptyTitle")}</h2>
        <p className="muted">
          {t("gallery:memories.emptyBody")}
        </p>
      </div>
    );
  }

  // Tiles open the lightbox at the asset's position in the
  // FLATTENED memories list, so Next flows across year sections. Worked out up
  // front rather than counted up inside the map below — a render must not carry
  // a running total from one child to the next. A handful of years, so the
  // quadratic walk costs nothing.
  const flatStarts = memories!.groups.map(
    (_group, index) => memories!.groups.slice(0, index).reduce((n, g) => n + g.items.length, 0)
  );
  return (
    <>
      {memories!.groups.map((group, groupIndex) => {
        const start = flatStarts[groupIndex];
        const ids = group.items.map((asset) => asset.id);
        const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
        return (
          <section key={group.year} id={`gallery-memories-${group.year}`} className="gallery-memories-year" aria-label={t("gallery:memories.sectionAria", { year: group.year })}>
            <div className="gallery-memories-year-head">
              <Button
                variant="bare"
                className={`gallery-day-select${allSelected ? " selected" : ""}`}
                onClick={() => toggleDaySelect(ids)}
                role="checkbox"
                aria-checked={allSelected}
                aria-label={t("gallery:memories.selectAllAria", { label: memoryDateLabel(group.precision, group.year) })}
                title={allSelected ? t("gallery:memories.deselectTitle") : t("gallery:memories.selectTitle")}
              >
                {allSelected ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              </Button>
              {canShareAny && (
                <Button
                  variant="bare"
                  className="gallery-day-share"
                  onClick={() => onShare(ids)}
                  aria-label={t("gallery:memories.shareAria", { label: memoryDateLabel(group.precision, group.year) })}
                  title={t("gallery:common.shareTheseTitle")}
                >
                  {t("gallery:common.share")}
                </Button>
              )}
              <h2>{memoryDateLabel(group.precision, group.year)}</h2>
              <small>{yearsAgo(group.year)} · {t("gallery:common.counts.photo", { count: group.count })}</small>
            </div>
            <div className="gallery-grid">
              {group.items.map((asset, i) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  onOpen={() => openLightbox("memory", start + i)}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(asset.id)}
                  onToggleSelect={() => toggleSelect(asset.id)}
                  onToggleLike={(next) => void toggleAssetLike(asset, next)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
