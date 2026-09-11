import { useTranslation } from "react-i18next";
import { CalendarDays, CheckCircle2, Circle, Film, Play, Sparkles } from "lucide-react";
import { Button } from "../../../shared/Button";
import { AssetTile, type LightboxSource } from "../AssetTile";
import type { GalleryAsset, GalleryMemories, GalleryYearReview } from "../types";
import { getMemoriesTitles, memoryDateLabel, yearsAgo } from "./gallery-page-model";

// Memories: the years in review first — a finished year, played as a film — then
// "On this day": one section per year, each selectable and shareable as a group.
export function MemoriesView({
  memories,
  yearReviews,
  onPlayYearReview,
  onCreateFromYearReview,
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
  /** Past years with enough material for a film, newest first; empty hides the row. */
  yearReviews: GalleryYearReview[];
  onPlayYearReview: (review: GalleryYearReview) => void;
  onCreateFromYearReview: (review: GalleryYearReview) => void;
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
  const hasAnniversaries = (memories?.groups.length ?? 0) > 0;

  // Ahead of the anniversaries: a year is the thing the household built, a like
  // at a time, all year — the reason to open this view on a day with no
  // anniversary at all. Each card plays; the button under it keeps the film as a
  // slideshow of one's own (music, transitions, a movie), which is the editor's job.
  const yearRow = yearReviews.length > 0 && (
    <section className="gallery-memory-suggestions" aria-label={t("gallery:yearReview.heading")}>
      <div className="gallery-memory-suggestions-head">
        <h2>{t("gallery:yearReview.heading")}</h2>
      </div>
      <p className="gallery-year-hint">{t("gallery:yearReview.hint")}</p>
      <div className="gallery-suggestion-row">
        {yearReviews.map((review) => (
          <div key={review.id} className="gallery-year-card">
            <Button
              variant="tile"
              className="gallery-folder-tile gallery-memory-tile"
              onClick={() => onPlayYearReview(review)}
              title={t("gallery:yearReview.playTitle")}
            >
              <span className="gallery-folder-thumb">
                {review.coverUrl ? <img src={review.coverUrl} alt="" loading="lazy" /> : <CalendarDays size={28} aria-hidden="true" />}
                <span className="gallery-memory-play" aria-hidden="true"><Play size={20} /></span>
                <span className="gallery-year-badge" aria-hidden="true">{review.year}</span>
              </span>
              <strong>{t("gallery:yearReview.title", { year: review.year })}</strong>
              <small>{t("gallery:yearReview.count", { count: review.count })}</small>
            </Button>
            <Button
              variant="text"
              compact
              onClick={() => onCreateFromYearReview(review)}
              title={t("gallery:yearReview.createSlideshowTitle")}
            >
              <Film size={15} aria-hidden="true" /> {t("gallery:yearReview.createSlideshow")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );

  if (!hasAnniversaries) {
    // With a year to offer, the page is not empty — say plainly that today has
    // nothing, rather than "No memories yet" under a row of them.
    if (yearRow) {
      return (
        <>
          {yearRow}
          <p className="management-empty">{t("gallery:memories.noneOnThisDay")}</p>
        </>
      );
    }
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
  // FLATTENED memories list, so Next flows across year sections.
  let flatBase = 0;
  return (
    <>
      {yearRow}
      {/* Once there is a row above, the anniversaries need a name of their own —
          the same one the timeline's strip uses. */}
      {yearRow && <h2 className="gallery-memories-title">{getMemoriesTitles()[memories!.precision]}</h2>}
      {memories!.groups.map((group) => {
        const start = flatBase;
        flatBase += group.items.length;
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
