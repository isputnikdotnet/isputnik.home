import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, Image as ImageIcon } from "lucide-react";
import { AssetTile, type LightboxSource } from "../AssetTile";
import { activeGalleryFilterCount, type GalleryFilters } from "../GalleryFilter";
import type { GalleryGrouping } from "../gallery-view";
import type { GalleryAsset, GalleryMemories } from "../types";
import { dayLabel, getMemoriesTitles, yearsAgo, type TimelineSort } from "./gallery-page-model";

// The gallery's front page: the "On this day" strip, then every photo in scope —
// in dated sections, or as one uninterrupted grid — with "Load more" below.
export function TimelineView({
  assets,
  total,
  loading,
  sort,
  grouping,
  gridClass,
  query,
  filters,
  memories,
  openMemoryYear,
  selectionMode,
  selectedIds,
  toggleSelect,
  toggleDaySelect,
  toggleAssetLike,
  openLightbox,
  canShareAny,
  onShare,
  onLoadMore
}: {
  assets: GalleryAsset[];
  total: number;
  loading: boolean;
  sort: TimelineSort;
  grouping: GalleryGrouping;
  gridClass: string;
  query: string;
  filters: GalleryFilters;
  memories: GalleryMemories | null;
  openMemoryYear: (year: number) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleDaySelect: (ids: string[]) => void;
  toggleAssetLike: (asset: GalleryAsset, next: boolean) => Promise<void>;
  openLightbox: (source: LightboxSource, index: number) => void;
  canShareAny: boolean;
  onShare: (ids: string[]) => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const MEMORIES_TITLES = getMemoriesTitles();

  // Group timeline assets into calendar-day buckets for the date headers, keyed on
  // whichever date the timeline is sorted by so the buckets stay consecutive.
  // Skipped entirely in one-continuous-grid mode: that view renders `assets`
  // straight through, so there is nothing to bucket.
  const days = useMemo(() => {
    const out: { label: string; items: { asset: GalleryAsset; index: number }[] }[] = [];
    if (grouping === "none") return out;
    assets.forEach((asset, index) => {
      const label = sort === "added" ? dayLabel({ takenAt: asset.addedAt }) : dayLabel(asset);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ asset, index });
      else out.push({ label, items: [{ asset, index }] });
    });
    return out;
  }, [assets, sort, grouping]);

  return (
    <>
      {memories && memories.groups.length > 0 && !query && activeGalleryFilterCount(filters) === 0 && !selectionMode && (
        <section className="gallery-memories" aria-label={t("gallery:page.views.memories")}>
          <h2 className="gallery-memories-title">{MEMORIES_TITLES[memories.precision]}</h2>
          <div className="gallery-memories-row">
            {memories.groups.map((group) => (
              <button
                key={group.year}
                type="button"
                className="gallery-memory-card"
                onClick={() => openMemoryYear(group.year)}
                aria-label={t("gallery:timeline.memoryCardAria", { title: MEMORIES_TITLES[memories.precision], year: group.year, count: t("gallery:common.counts.photo", { count: group.count }) })}
              >
                {group.items[0]?.coverUrl ? (
                  <img src={group.items[0].coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="gallery-memory-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                )}
                <span className="gallery-memory-overlay">
                  <strong>{group.year}</strong>
                  <small>{yearsAgo(group.year)} · {t("gallery:common.counts.photo", { count: group.count })}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {grouping === "none" ? (
        // One uninterrupted grid: no date headers, so the whole run of
        // photos reads as a single wall. Selection is still available —
        // through the toolbar's Select rather than a day's checkbox.
        <div className={gridClass}>
          {assets.map((asset, index) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              onOpen={() => openLightbox("timeline", index)}
              selectionMode={selectionMode}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onToggleLike={(next) => void toggleAssetLike(asset, next)}
            />
          ))}
        </div>
      ) : days.map((day) => {
        const ids = day.items.map(({ asset }) => asset.id);
        const allSelected = ids.every((id) => selectedIds.has(id));
        return (
          <div key={day.items[0].asset.id}>
            <div className="gallery-day-head">
              <button
                type="button"
                className={`gallery-day-select${allSelected ? " selected" : ""}`}
                onClick={() => toggleDaySelect(ids)}
                role="checkbox"
                aria-checked={allSelected}
                aria-label={t("gallery:memories.selectAllAria", { label: day.label })}
                title={allSelected ? t("gallery:timeline.deselectDayTitle") : t("gallery:timeline.selectDayTitle")}
              >
                {allSelected ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              </button>
              {canShareAny && (
                <button
                  type="button"
                  className="gallery-day-share"
                  onClick={() => onShare(ids)}
                  aria-label={t("gallery:memories.shareAria", { label: day.label })}
                  title={t("gallery:common.shareTheseTitle")}
                >
                  {t("gallery:common.share")}
                </button>
              )}
              <h2 className="gallery-day-label">{day.label}</h2>
            </div>
            <div className={gridClass}>
              {day.items.map(({ asset, index }) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  onOpen={() => openLightbox("timeline", index)}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(asset.id)}
                  onToggleSelect={() => toggleSelect(asset.id)}
                  onToggleLike={(next) => void toggleAssetLike(asset, next)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {!loading && assets.length === 0 && (
        <p className="management-empty">{query ? t("gallery:timeline.emptyNoMatch") : t("gallery:timeline.emptyNone")}</p>
      )}
      {assets.length < total && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loading}>
            {loading ? t("gallery:common.loading") : t("gallery:common.loadMore")}
          </button>
        </div>
      )}
    </>
  );
}
