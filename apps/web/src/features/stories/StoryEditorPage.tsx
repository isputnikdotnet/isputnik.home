import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Link2, Trash2 } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate, replaceNavigate, storyEditorDetailsHref, storyEditorHref } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { useIsMobile } from "../../shared/useIsMobile";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ShareStoryModal } from "./ShareStoryModal";
import { StoryChapterEditor } from "./StoryChapterEditor";
import { StoryDetailsPane } from "./StoryDetailsPane";
import { StoryEditorNav } from "./StoryEditorNav";
import { StoryHomePane } from "./StoryHomePane";
import { useStoryEditor } from "./useStoryEditor";
import { chapterLabel } from "./types";

// The editor. One pane at a time — the story's front page, its details, or a
// single chapter — with the sidebar holding the story's shape and the top bar
// holding what you do to the story as a whole. Every field saves on blur and
// every structural change saves immediately: there is no Save button anywhere
// here, so nothing is lost by navigating away mid-thought.
export function StoryEditorPage({
  id,
  pane,
  chapterId,
  user,
  logout
}: {
  id: string;
  pane: "home" | "details" | "chapter";
  chapterId?: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const editor = useStoryEditor(id);
  const { story, error, busy } = editor;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  // The panes live in the sidebar, and a phone has no sidebar — the same strip
  // the reading view uses carries them there instead.
  const isMobile = useIsMobile();

  const chapterIndex = story && chapterId
    ? story.chapters.findIndex((chapter) => chapter.id === chapterId)
    : -1;
  const chapter = chapterIndex >= 0 ? story!.chapters[chapterIndex] : null;

  useEffect(() => {
    if (story) document.title = `${story.title} — isputnik.home`;
  }, [story?.title]);

  // Someone else's story (or a reader who guessed the URL) never gets the
  // editor — the server refuses the writes anyway, but the page shouldn't lie.
  useEffect(() => {
    if (story && !story.canEdit) navigate(`/stories/${story.id}`);
  }, [story?.canEdit, story?.id]);

  // A chapter that has been deleted (here or in another tab) leaves its address
  // behind; fall back to the front page rather than showing an empty pane.
  useEffect(() => {
    if (story && pane === "chapter" && !chapter) replaceNavigate(storyEditorHref(story.id));
  }, [story?.id, pane, chapter?.id]);

  const activeKey = pane === "chapter" ? chapterId ?? "home" : pane;
  // The chapter's name for the page head — "Day 1", or its title when the
  // story doesn't number its chapters.
  const chapterHeading = story && chapter ? chapterLabel(story, chapter, chapterIndex) : "";

  return (
    <DashboardShell
      active="stories"
      user={user}
      logout={logout}
      sideNav={story
        ? (
          <StoryEditorNav
            story={story}
            activeKey={activeKey}
            busy={busy}
            onAddChapter={() => void editor.addChapter().then((created) => {
              if (created) navigate(storyEditorHref(story.id, created));
            })}
            onReorderChapters={(orderedIds) => void editor.reorderChapters(orderedIds)}
          />
        )
        : undefined}
    >
      <section className="work-area story-edit-area">
        <div className="story-edit-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => navigate(`/stories/${id}`)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("stories:edit.backToStory")}</span>
          </button>

          {story && (
            <div className="story-edit-topbar-actions">
              <Button variant="secondary" compact onClick={() => navigate(`/stories/${story.id}`)}>
                <BookOpen size={15} aria-hidden="true" />
                <span>{t("stories:actions.read")}</span>
              </Button>
              <Button
                variant={story.status === "published" ? "secondary" : "primary"}
                compact
                disabled={busy}
                onClick={() => void editor.patchStory({
                  status: story.status === "published" ? "draft" : "published"
                })}
              >
                {story.status === "published" ? t("stories:actions.unpublish") : t("stories:actions.publish")}
              </Button>
              <Button variant="secondary" compact onClick={() => setSharing(true)}>
                <Link2 size={15} aria-hidden="true" />
                <span>{t("stories:actions.shareLink")}</span>
              </Button>
              <Button variant="secondary" compact danger onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} aria-hidden="true" />
                <span>{t("stories:actions.delete")}</span>
              </Button>
            </div>
          )}
        </div>

        {story && isMobile && (
          <nav className="story-site-strip story-edit-strip" aria-label={t("stories:edit.nav.aria")}>
            <a
              href={storyEditorHref(story.id)}
              className={pane === "home" ? "is-current" : ""}
              onClick={(event) => followRoute(event, storyEditorHref(story.id))}
            >
              {t("stories:edit.nav.home")}
            </a>
            <a
              href={storyEditorDetailsHref(story.id)}
              className={pane === "details" ? "is-current" : ""}
              onClick={(event) => followRoute(event, storyEditorDetailsHref(story.id))}
            >
              {t("stories:edit.nav.details")}
            </a>
            {story.chapters.map((item, itemIndex) => (
              <a
                key={item.id}
                href={storyEditorHref(story.id, item.id)}
                className={item.id === chapterId ? "is-current" : ""}
                onClick={(event) => followRoute(event, storyEditorHref(story.id, item.id))}
              >
                {chapterLabel(story, item, itemIndex)}
              </a>
            ))}
          </nav>
        )}

        {error && <MessageBox tone="error" title={t("stories:errors.saveTitle")}>{error}</MessageBox>}
        {!story && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {story && pane !== "home" && (
          <header className="story-edit-pane-head">
            <p className="eyebrow">{story.title}</p>
            <h1>{pane === "details" ? t("stories:edit.nav.details") : chapterHeading}</h1>
          </header>
        )}

        {story && pane === "home" && (
          <StoryHomePane story={story} onPatch={(fields) => void editor.patchStory(fields)} />
        )}

        {story && pane === "details" && (
          <StoryDetailsPane
            story={story}
            busy={busy}
            onPatch={(fields) => void editor.patchStory(fields)}
            onTags={(tags) => void editor.setTags(tags)}
          />
        )}

        {story && pane === "chapter" && chapter && (
          <StoryChapterEditor
            key={chapter.id}
            story={story}
            chapter={chapter}
            index={chapterIndex}
            busy={busy}
            onPatch={(fields) => void editor.patchChapter(chapter.id, fields)}
            onRemove={() => void editor.removeChapter(chapter.id).then(() => {
              replaceNavigate(storyEditorHref(story.id));
            })}
            onAddBlock={(kind, fields, afterId) => void editor.addBlock(chapter.id, kind, fields, afterId)}
            blockActions={{
              move: (blockId, direction) => void editor.moveBlock(chapter, blockId, direction),
              moveToChapter: (blockId, targetId) => {
                const target = story.chapters.find((entry) => entry.id === targetId);
                if (target) void editor.moveBlockToChapter(blockId, target);
              },
              reorder: (orderedIds) => void editor.reorderBlocks(chapter.id, orderedIds),
              patch: (blockId, fields) => void editor.patchBlock(blockId, fields),
              remove: (blockId) => void editor.removeBlock(blockId)
            }}
          />
        )}
      </section>

      {sharing && story && (
        <ShareStoryModal storyId={story.id} storyTitle={story.title} onClose={() => setSharing(false)} />
      )}

      {confirmDelete && story && (
        <ConfirmDialog
          title={t("stories:confirm.deleteStoryTitle", { name: story.title })}
          confirmLabel={t("stories:confirm.deleteStoryConfirm")}
          danger
          busy={busy}
          onConfirm={() => void editor.removeStory()}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:confirm.deleteStoryBody")}
        </ConfirmDialog>
      )}
    </DashboardShell>
  );
}
