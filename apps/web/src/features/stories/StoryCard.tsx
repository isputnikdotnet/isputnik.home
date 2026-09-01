import { useTranslation } from "react-i18next";
import { BookText } from "lucide-react";
import { followRoute } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import type { StorySummary } from "./types";

// One story as a tile. The index and the cross-type tag browse both show it, so
// a story looks the same wherever it is found.
export function StoryCard({ story }: { story: StorySummary }) {
  const { t } = useTranslation(["common", "stories"]);
  const href = `/stories/${story.id}`;

  // The date span leads when the story has one — that is what a reader
  // recognises it by; otherwise fall back to how much is in it. A rated story
  // (a review, usually) wears its stars in the same line.
  const meta = [
    formatPartialDateRange(story.firstDate, story.lastDate === story.firstDate ? null : story.lastDate),
    story.rating != null ? `★ ${story.rating}` : "",
    story.chapterCount > 1
      ? t("stories:count.chapters", { count: story.chapterCount })
      : t("stories:count.blocks", { count: story.blockCount })
  ].filter(Boolean).join(" · ");

  return (
    <a
      className="audiobook-card story-card"
      href={href}
      onClick={(event) => followRoute(event, href)}
    >
      <div className="story-card-cover" aria-hidden="true">
        {story.coverUrl ? <img src={story.coverUrl} alt="" loading="lazy" /> : <BookText size={28} />}
      </div>
      <div className="audiobook-card-body">
        <strong>{story.title}</strong>
        <span>{meta}</span>
        {story.subtitle && <p className="audiobook-card-note">{story.subtitle}</p>}
        {story.status === "draft" && (
          <span className="story-draft-badge">{t("stories:status.draft")}</span>
        )}
      </div>
    </a>
  );
}
