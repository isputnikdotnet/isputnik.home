import { useTranslation } from "react-i18next";
import { Plus, SlidersHorizontal } from "lucide-react";
import { Button } from "../../shared/Button";
import { SectionNav, type SectionNavGroup } from "../../shared/SectionNav";
import { storyEditorDetailsHref, storyEditorHref } from "../../router";
import { chapterLabel, type StoryDetail } from "./types";

// The editor's own sidebar. While a story is being written the section's
// filters and shelves are the wrong nav — what an author moves between is the
// story's front page, its details, and its chapters, one at a time. Chapters
// are dragged into order here, which is also the only place that order is set:
// a list you can see beats two arrows on a chapter you happen to be looking at.
export function StoryEditorNav({
  story,
  activeKey,
  busy,
  onAddChapter,
  onReorderChapters
}: {
  story: StoryDetail;
  /** "home" | "details" | a chapter id. */
  activeKey: string;
  busy: boolean;
  onAddChapter: () => void;
  onReorderChapters: (orderedIds: string[]) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);

  const groups: SectionNavGroup[] = [
    {
      label: "",
      items: [
        {
          key: "details",
          label: t("stories:edit.nav.details"),
          href: storyEditorDetailsHref(story.id),
          icon: SlidersHorizontal
        }
      ]
    },
    {
      label: t("stories:edit.nav.chapters"),
      items: story.chapters.map((chapter, index) => ({
        key: chapter.id,
        label: chapterLabel(story, chapter, index),
        href: storyEditorHref(story.id, chapter.id)
      })),
      onReorder: onReorderChapters,
      footer: (
        <Button variant="text" compact className="story-edit-nav-add" onClick={onAddChapter} disabled={busy}>
          <Plus size={15} aria-hidden="true" />
          <span>{t("stories:edit.addChapter")}</span>
        </Button>
      )
    }
  ];

  return (
    <SectionNav
      ariaLabel={t("stories:edit.nav.aria")}
      groups={groups}
      activeKey={activeKey}
      home={{
        key: "home",
        label: t("stories:edit.nav.home"),
        href: storyEditorHref(story.id)
      }}
    />
  );
}
