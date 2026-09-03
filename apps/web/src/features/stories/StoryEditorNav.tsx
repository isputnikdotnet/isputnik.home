import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, Plus, BookOpen } from "lucide-react";
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
// The top row is the way OUT of the editor: back to wherever the author opened
// it from — the story's own page, the collection whose Add story made it, the
// index — with the story's page as the fallback for an editor reached by a
// pasted link. It used to be the story's front page under a Home icon, which
// read as the app's Home everywhere else in the sidebar and so was the one row
// nobody trusted.
//
// `replace` is what makes that exit honest: moving between panes replaces the
// history entry, so the whole editing session is one step in the trail and
// leaving means leaving, not walking back through the chapters you edited.
export function StoryEditorNav({
  story,
  activeKey,
  busy,
  actions,
  onAddChapter,
  onReorderChapters
}: {
  story: StoryDetail;
  /** "overview" | a chapter id. */
  activeKey: string;
  busy: boolean;
  /** What you do to the story as a whole — publishing it, handing it on,
   *  deleting it. They sit under the chapters, where the reading view keeps the
   *  same kind of thing; a phone has no sidebar and keeps them in the top bar. */
  actions?: ReactNode;
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
      footer={actions}
      replace
      exit={{
        label: t("stories:edit.exitEdit"),
        href: `/stories/${story.id}`,
        icon: LogOut,
        back: true
      }}
    />
  );
}
