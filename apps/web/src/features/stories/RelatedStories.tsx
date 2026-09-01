import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { StoryCard } from "./StoryCard";
import type { StorySummary } from "./types";

interface ReferencingStory extends StorySummary {
  /** Which entity the story actually referenced — on a book page queried
   *  work-wide, this says which edition ("audiobook" | "ebook"). */
  refEntityType: string | null;
}

// Back-links: the stories that reference this page's subject. A book page
// wears it as "Reviews & stories" (queried across the whole work, each card
// noting the edition it referenced), a person as "Stories featuring…", an
// album or slideshow as "Appears in stories". Renders nothing at all when no
// story does — a permanent empty section would just be furniture.
export function RelatedStories({
  entityType,
  entityId,
  personName
}: {
  entityType: "audiobook" | "ebook" | "family_tree_person" | "gallery_album" | "gallery_slideshow";
  entityId: string;
  /** Person pages: the name the heading speaks of. */
  personName?: string;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [stories, setStories] = useState<ReferencingStory[]>([]);
  const isBook = entityType === "audiobook" || entityType === "ebook";

  useEffect(() => {
    let alive = true;
    setStories([]);
    api<{ stories: ReferencingStory[] }>(
      `/api/stories/referencing?type=${entityType}&id=${encodeURIComponent(entityId)}`
    )
      .then((payload) => { if (alive) setStories(payload.stories); })
      .catch(() => { /* back-links are an extra, never an error banner */ });
    return () => { alive = false; };
  }, [entityType, entityId]);

  if (stories.length === 0) return null;

  const heading = isBook
    ? t("stories:related.bookHeading")
    : entityType === "family_tree_person"
      ? t("stories:related.personHeading", { name: personName ?? "" })
      : t("stories:related.setHeading");

  return (
    <section className="story-related">
      <h2>{heading}</h2>
      <div className="story-related-grid">
        {stories.map((story) => (
          <div className="story-related-item" key={story.id}>
            <StoryCard story={story} />
            {isBook && story.refEntityType && (
              <span className="story-related-edition">
                {story.refEntityType === "audiobook"
                  ? t("stories:related.audiobookEdition")
                  : t("stories:related.ebookEdition")}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
