import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, Send as SendIcon, Trash2 } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followReplace, goBack, navigate, replaceNavigate, storyEditorHref } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { useIsMobile } from "../../shared/useIsMobile";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SendToSheet } from "../social/SendToSheet";
import { ShareStoryModal } from "./ShareStoryModal";
import { StoryChapterEditor } from "./StoryChapterEditor";
import { StoryEditorNav } from "./StoryEditorNav";
import { StoryOverviewPane } from "./StoryOverviewPane";
import { useStoryEditor } from "./useStoryEditor";
import { chapterLabel } from "./types";

// The editor. One pane at a time — the story's overview or a single
// chapter — with the sidebar holding the story's shape and the top bar
// holding what you do to the story as a whole. Every field saves on blur and
// every structural change saves immediately: there is no Save button anywhere
// here, so nothing is lost by navigating away mid-thought.
//
// Every move between panes REPLACES the history entry (the reading view does
// the same with chapters): the whole session is one step in the trail, so
// leaving the editor returns to whatever opened it — a story page, a
// collection's Add story, the index — instead of the last pane visited.
export function StoryEditorPage({
  id,
  pane,
  chapterId,
  user,
  logout
}: {
  id: string;
  pane: "overview" | "chapter";
  chapterId?: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const editor = useStoryEditor(id);
  const { story, error, busy } = editor;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sending, setSending] = useState(false);
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
  // behind; fall back to the overview rather than showing an empty pane.
  useEffect(() => {
    if (story && pane === "chapter" && !chapter) replaceNavigate(storyEditorHref(story.id));
  }, [story?.id, pane, chapter?.id]);

  const activeKey = pane === "chapter" ? chapterId ?? "overview" : pane;
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
              if (created) replaceNavigate(storyEditorHref(story.id, created));
            })}
            onReorderChapters={(orderedIds) => void editor.reorderChapters(orderedIds)}
          />
        )
        : undefined}
    >
      <section className="work-area story-edit-area">
        <div className="story-edit-topbar">
          {/* The way out lives in the sidebar, where every other section keeps
              it — except on a phone, which has no sidebar to keep it in. Same
              exit either way: back the way they came in, story page if they
              came from outside the app. */}
          {isMobile && (
            <button
              className="audiobook-back-button"
              type="button"
              onClick={() => goBack(`/stories/${id}`)}
            >
              <LogOut size={18} aria-hidden="true" />
              <span>{t("stories:edit.exitEdit")}</span>
            </button>
          )}

          {story && (
            <div className="story-edit-topbar-actions">
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
              {/* Handing the story on is one door everywhere in the app: Send
                  holds both the people and the guest link, and its link tab
                  hands back to the story's own dialog. */}
              <Button variant="secondary" compact onClick={() => setSending(true)}>
                <SendIcon size={15} aria-hidden="true" />
                <span>{t("stories:actions.send")}</span>
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
              className={pane === "overview" ? "is-current" : ""}
              onClick={(event) => followReplace(event, storyEditorHref(story.id))}
            >
              {t("stories:edit.nav.overview")}
            </a>
            {story.chapters.map((item, itemIndex) => (
              <a
                key={item.id}
                href={storyEditorHref(story.id, item.id)}
                className={item.id === chapterId ? "is-current" : ""}
                onClick={(event) => followReplace(event, storyEditorHref(story.id, item.id))}
              >
                {chapterLabel(story, item, itemIndex)}
              </a>
            ))}
          </nav>
        )}

        {error && <MessageBox tone="error" title={t("stories:errors.saveTitle")}>{error}</MessageBox>}
        {!story && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {story && pane === "chapter" && (
          <header className="story-edit-pane-head">
            <p className="eyebrow">{story.title}</p>
            <h1>{chapterHeading}</h1>
          </header>
        )}

        {story && pane === "overview" && (
          <StoryOverviewPane
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

      {sending && story && (
        <SendToSheet
          subject={{ entityType: "story", entityId: story.id }}
          onClose={() => setSending(false)}
          // A story's guest links hang off the story API rather than
          // /api/shares, so the sheet offers the tab and the story's own dialog
          // does the work — the same handoff a gallery album makes.
          onGuestLink={() => { setSending(false); setSharing(true); }}
        />
      )}

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
