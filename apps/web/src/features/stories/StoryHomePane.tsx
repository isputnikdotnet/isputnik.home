import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import type { ActionMenuItem } from "../../shared/ActionMenu";
import { InlineEdit } from "../../shared/InlineEdit";
import { StoryCoverBanner } from "./StoryCoverBanner";
import { StoryMap } from "./StoryMap";
import { StoryMarkdown } from "./StoryMarkdown";
import { navigate, storyEditorHref } from "../../router";
import { chapterLabel, type StoryDetail } from "./types";

// The story's front page, edited as the page itself: the cover it opens with,
// its name, and the few lines that introduce it. Everything a reader meets
// first, and nothing else — the settings that never appear on this page live on
// Story details instead.
export function StoryHomePane({
  story,
  onPatch
}: {
  story: StoryDetail;
  onPatch: (fields: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);

  // A story that shows a book can wear that book's artwork — the first one it
  // shows, which on a review is the book it is about.
  const book = story.chapters
    .flatMap((chapter) => chapter.blocks)
    .find((block) => block.kind === "book" && block.available && block.coverUrl && block.entityId);
  const bookCover: ActionMenuItem[] = book
    ? [{
      key: "book",
      label: t("stories:edit.coverUseBook"),
      icon: <BookOpen size={15} aria-hidden="true" />,
      onSelect: () => onPatch({ coverItemId: book.entityId })
    }]
    : [];

  const pins = story.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => chapter.placeLat != null && chapter.placeLng != null)
    .map(({ chapter, index }) => ({
      id: chapter.id,
      lat: chapter.placeLat!,
      lng: chapter.placeLng!,
      label: String(index + 1),
      title: chapter.place ?? chapterLabel(story, chapter, index)
    }));

  return (
    <div className="story-edit-pane story-edit-home">
      <StoryCoverBanner
        coverUrl={story.coverUrl}
        pickerTitle={t("stories:fields.coverPickerTitle")}
        extraActions={bookCover}
        onPick={(asset) => onPatch({ coverItemId: asset.id })}
        onClear={() => onPatch({ coverItemId: null })}
      />

      <h1 className="story-edit-story-title">
        <InlineEdit
          value={story.title}
          ariaLabel={t("stories:fields.title")}
          placeholder={t("stories:fields.titlePlaceholder")}
          maxLength={160}
          // The one field with nothing to fall back on: a story always has a
          // name, so an emptied title keeps the old one.
          onSave={(next) => { if (next) onPatch({ title: next }); }}
        />
      </h1>

      <div className="story-edit-story-subtitle">
        <InlineEdit
          value={story.subtitle ?? ""}
          ariaLabel={t("stories:fields.subtitle")}
          placeholder={t("stories:fields.subtitlePlaceholder")}
          maxLength={300}
          onSave={(next) => onPatch({ subtitle: next || null })}
        />
      </div>

      <div className="story-edit-intro">
        <InlineEdit
          value={story.intro ?? ""}
          ariaLabel={t("stories:fields.intro")}
          placeholder={t("stories:fields.introPlaceholder")}
          maxLength={5000}
          multiline
          rows={6}
          display={story.intro ? <StoryMarkdown source={story.intro} /> : undefined}
          onSave={(next) => onPatch({ intro: next || null })}
        />
      </div>

      {pins.length > 0 && (
        <section className="story-edit-home-map">
          <h2>{t("stories:site.mapHeading")}</h2>
          <StoryMap pins={pins} onOpen={(id) => navigate(storyEditorHref(story.id, id))} />
        </section>
      )}
    </div>
  );
}
