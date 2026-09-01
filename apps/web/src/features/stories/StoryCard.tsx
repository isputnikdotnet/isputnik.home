import { useTranslation } from "react-i18next";
import { BookText, MapPin, Star } from "lucide-react";
import { followRoute } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import type { StorySummary } from "./types";

// One story as a tile. The index and the cross-type tag browse both show it, so
// a story looks the same wherever it is found. The cover carries what a reader
// scans for first — draft flag, where it happened, the favorite star — and the
// body the rest: title, date span, stars, how far it travels, the note.
//
// `onToggleSave` makes the star a live control (the index passes it); without
// it a saved story still wears its star, read-only, so the tag browse and the
// collection page agree with the index about what is a favorite.
export function StoryCard({
  story,
  onToggleSave
}: {
  story: StorySummary;
  onToggleSave?: (story: StorySummary) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const href = `/stories/${story.id}`;

  // The date span leads when the story has one — that is what a reader
  // recognises it by. A rated story (a review, usually) wears its stars in the
  // same line; a travelling one says how many places it visits, and only a
  // stay-at-home story falls back to how much is in it.
  const meta = [
    formatPartialDateRange(story.firstDate, story.lastDate === story.firstDate ? null : story.lastDate),
    story.rating != null ? `★ ${story.rating}` : "",
    story.placesCount > 0
      ? t("stories:count.places", { count: story.placesCount })
      : story.chapterCount > 1
        ? t("stories:count.chapters", { count: story.chapterCount })
        : t("stories:count.blocks", { count: story.blockCount })
  ].filter(Boolean).join(" · ");

  return (
    <div className="story-card-wrap">
      <a
        className="audiobook-card story-card"
        href={href}
        onClick={(event) => followRoute(event, href)}
      >
        <div className="story-card-cover" aria-hidden="true">
          {story.coverUrl ? <img src={story.coverUrl} alt="" loading="lazy" /> : <BookText size={28} />}
          {story.status === "draft" && (
            <span className="story-draft-badge">{t("stories:status.draft")}</span>
          )}
          {story.firstPlace && (
            <span className="story-card-place">
              <MapPin size={12} aria-hidden="true" />
              <span>{story.firstPlace}</span>
            </span>
          )}
        </div>
        <div className="audiobook-card-body">
          <strong>{story.title}</strong>
          <span>{meta}</span>
          {story.subtitle && <p className="audiobook-card-note">{story.subtitle}</p>}
          {story.kind !== "free" && (
            <span className="story-kind-chip">{t(`stories:kinds.${story.kind}.name`)}</span>
          )}
        </div>
      </a>
      {onToggleSave ? (
        <button
          type="button"
          className={`story-card-save${story.saved ? " is-saved" : ""}`}
          aria-label={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
          title={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
          aria-pressed={story.saved}
          onClick={() => onToggleSave(story)}
        >
          <Star size={16} aria-hidden="true" />
        </button>
      ) : story.saved && (
        <span className="story-card-save is-saved is-static" aria-hidden="true">
          <Star size={16} />
        </span>
      )}
    </div>
  );
}
