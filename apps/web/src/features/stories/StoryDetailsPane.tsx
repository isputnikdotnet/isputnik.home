import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { TagInput } from "../../shared/TagInput";
import type { StoryCollectionSummary, StoryDetail } from "./types";

// Everything true of the story that never shows on its front page: what it
// calls a chapter, how it is filed, and what it is worth. The front page's own
// words (title, subtitle, intro, cover) are edited there, in place, so nothing
// on this pane is a second way to set something.
export function StoryDetailsPane({
  story,
  busy,
  onPatch,
  onTags
}: {
  story: StoryDetail;
  busy: boolean;
  onPatch: (fields: Record<string, unknown>) => void;
  onTags: (tags: string[]) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [chapterNoun, setChapterNoun] = useState(story.chapterNoun ?? "");
  // Every tag already in use, so an author reaches for the family's existing
  // vocabulary ("Minnesota") instead of inventing a near-duplicate.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  // Shelves this author may put the story on (plus wherever it already is).
  const [collections, setCollections] = useState<StoryCollectionSummary[]>([]);

  useEffect(() => { setChapterNoun(story.chapterNoun ?? ""); }, [story.chapterNoun]);

  useEffect(() => {
    api<{ tags: { name: string }[] }>("/api/library/tags")
      .then((payload) => setTagSuggestions(payload.tags.map((tag) => tag.name)))
      .catch(() => setTagSuggestions([]));
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => setCollections([]));
  }, []);

  return (
    <div className="story-edit-pane story-edit-details">
      <MessageBox
        tone={story.status === "published" ? "success" : "info"}
        title={story.status === "published" ? t("stories:status.publishedTitle") : t("stories:status.draftTitle")}
      >
        {story.status === "published" ? t("stories:status.publishedBody") : t("stories:status.draftBody")}
      </MessageBox>

      <div className="story-edit-details-fields">
        {/* Authored text ("Day", "Stop") rendered "Day 1" — deliberately NOT
            translated, it belongs to this story rather than to the app. */}
        <label className="field story-edit-detail">
          <span>{t("stories:fields.chapterNoun")}</span>
          <input
            value={chapterNoun}
            maxLength={30}
            onChange={(event) => setChapterNoun(event.target.value)}
            onBlur={() => {
              const next = chapterNoun.trim();
              if (next !== (story.chapterNoun ?? "")) onPatch({ chapterNoun: next || null });
            }}
            placeholder={t("stories:fields.chapterNounPlaceholder")}
          />
          <span className="muted">{t("stories:fields.chapterNounHint")}</span>
        </label>

        <label className="field story-edit-detail">
          <span>{t("stories:collections.pickerLabel")}</span>
          <select
            value={story.collectionId ?? ""}
            onChange={(event) => onPatch({ collectionId: event.target.value || null })}
            disabled={busy}
          >
            <option value="">{t("stories:collections.none")}</option>
            {collections
              .filter((collection) => collection.canContribute || collection.id === story.collectionId)
              .map((collection) => (
                <option key={collection.id} value={collection.id}>{collection.title}</option>
              ))}
          </select>
          <span className="muted">{t("stories:collections.pickerHint")}</span>
        </label>

        <div className="field story-edit-detail">
          <span>{t("stories:rating.label")}</span>
          <div className="story-rating-row">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className="story-rating-star"
                onClick={() => onPatch({ rating: value })}
                disabled={busy}
                aria-pressed={story.rating != null && story.rating >= value}
                aria-label={t("stories:rating.setAria", { count: value })}
                title={t("stories:rating.setAria", { count: value })}
              >
                <Star
                  size={20}
                  aria-hidden="true"
                  fill={story.rating != null && story.rating >= value ? "currentColor" : "none"}
                />
              </button>
            ))}
            {story.rating != null && (
              <Button variant="text" compact onClick={() => onPatch({ rating: null })} disabled={busy}>
                {t("stories:rating.clear")}
              </Button>
            )}
          </div>
          <span className="muted">{t("stories:rating.hint")}</span>
        </div>

        <div className="field story-edit-detail story-edit-detail-wide">
          <span>{t("stories:tags.label")}</span>
          <TagInput
            value={story.tags}
            onChange={onTags}
            suggestions={tagSuggestions}
            disabled={busy}
            listId="story-tag-suggestions"
            placeholder={t("stories:tags.placeholder")}
            hint={t("stories:tags.hint")}
          />
        </div>
      </div>
    </div>
  );
}
