import { useTranslation } from "react-i18next";
import { Plus, BookOpen } from "lucide-react";
import { Button } from "../../shared/Button";
import { SectionNav, type SectionNavGroup } from "../../shared/SectionNav";
import { storyEditorHref } from "../../router";
import { chapterLabel, type StoryDetail } from "./types";

// The editor's own sidebar. While a story is being written the section's
// filters and shelves are the wrong nav — what an author moves between is the
// story's overview and its chapters, one at a time. Chapters are dragged into
// order here, which is also the only place that order is set: a list you can
// see beats two arrows on a chapter you happen to be looking at.
//
// It carries no way out (`exit={null}`): leaving is one of the story's actions
// and lives with them, in the strip of icons above the page. The slot held the
// story's front page under a Home icon once, which read as the app's Home
// everywhere else in the sidebar and was the one row nobody trusted; a link to
// the app's Home would be worse still, in an editor you cannot leave that way
// without losing your place.
//
// `replace` is what keeps that exit honest wherever it lives: moving between
// panes replaces the history entry, so the whole editing session is one step in
// the trail and leaving means leaving, not walking back through the chapters
// you edited.
export function StoryEditorNav({
  story,
  activeKey,
  busy,
  onAddChapter,
  onReorderChapters
}: {
  story: StoryDetail;
  /** "overview" | a chapter id. */
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
          key: "overview",
          label: t("stories:edit.nav.overview"),
          href: storyEditorHref(story.id),
          icon: BookOpen
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
      replace
      exit={null}
    />
  );
}
