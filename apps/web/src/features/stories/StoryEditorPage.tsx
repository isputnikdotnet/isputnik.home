import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Link2, Plus, Star, Trash2 } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { TagInput } from "../../shared/TagInput";
import { ShareStoryModal } from "./ShareStoryModal";
import { StoryChapterEditor } from "./StoryChapterEditor";
import { useStoryEditor } from "./useStoryEditor";
import { hasChapterStructure } from "./types";

// The editor. One scrolling surface that mirrors the reading view, with an
// insert row under each chapter. Every field saves on blur and every structural
// change saves immediately — there is no Save button, so nothing is lost by
// navigating away mid-thought.
export function StoryEditorPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const editor = useStoryEditor(id);
  const { story, error, busy } = editor;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [chapterNoun, setChapterNoun] = useState("");
  const [intro, setIntro] = useState("");
  // Revealed on demand for a one-chapter story: a journal page shouldn't open
  // with a form, but a chaptered one needs its dates in reach.
  const [showChapterFields, setShowChapterFields] = useState(false);
  // Every tag already in use, so an author reaches for the family's existing
  // vocabulary ("Minnesota") instead of inventing a near-duplicate.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  useEffect(() => {
    api<{ tags: { name: string }[] }>("/api/library/tags")
      .then((payload) => setTagSuggestions(payload.tags.map((tag) => tag.name)))
      .catch(() => setTagSuggestions([]));
  }, []);

  useEffect(() => {
    if (!story) return;
    setTitle(story.title);
    setSubtitle(story.subtitle ?? "");
    setChapterNoun(story.chapterNoun ?? "");
    setIntro(story.intro ?? "");
    document.title = `${story.title} — isputnik.home`;
    if (hasChapterStructure(story)) setShowChapterFields(true);
  }, [story?.id, story?.title, story?.subtitle, story?.chapterNoun, story?.intro]);

  // Someone else's story (or a reader who guessed the URL) never gets the
  // editor — the server refuses the writes anyway, but the page shouldn't lie.
  useEffect(() => {
    if (story && !story.canEdit) navigate(`/stories/${story.id}`);
  }, [story?.canEdit, story?.id]);

  const structured = story ? hasChapterStructure(story) : false;

  return (
    <DashboardShell active="stories" user={user} logout={logout}>
      <section className="work-area story-edit-area">
        <div className="book-detail-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => navigate(`/stories/${id}`)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("stories:edit.backToStory")}</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.saveTitle")}>{error}</MessageBox>}
        {!story && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {story && (
          <>
            <div className="section-head audiobook-head story-edit-head">
              <div className="story-edit-title-fields">
                <p className="eyebrow">{t("stories:edit.eyebrow")}</p>
                <input
                  className="story-title-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => {
                    const next = title.trim();
                    if (!next) { setTitle(story.title); return; }
                    if (next !== story.title) void editor.patchStory({ title: next });
                  }}
                  placeholder={t("stories:fields.titlePlaceholder")}
                  maxLength={160}
                  aria-label={t("stories:fields.title")}
                />
                <input
                  className="story-subtitle-input"
                  value={subtitle}
                  onChange={(event) => setSubtitle(event.target.value)}
                  onBlur={() => {
                    const next = subtitle.trim();
                    if (next !== (story.subtitle ?? "")) void editor.patchStory({ subtitle: next || null });
                  }}
                  placeholder={t("stories:fields.subtitlePlaceholder")}
                  maxLength={300}
                  aria-label={t("stories:fields.subtitle")}
                />
              </div>

              <div className="story-edit-head-actions">
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
            </div>

            <MessageBox tone={story.status === "published" ? "success" : "info"} title={
              story.status === "published" ? t("stories:status.publishedTitle") : t("stories:status.draftTitle")
            }>
              {story.status === "published" ? t("stories:status.publishedBody") : t("stories:status.draftBody")}
            </MessageBox>

            <div className="story-tags-field">
              <p className="story-tags-label">{t("stories:tags.label")}</p>
              <TagInput
                value={story.tags}
                onChange={(tags) => void editor.setTags(tags)}
                suggestions={tagSuggestions}
                disabled={busy}
                listId="story-tag-suggestions"
                placeholder={t("stories:tags.placeholder")}
                hint={t("stories:tags.hint")}
              />
            </div>

            {/* Story Home fields: the intro opens the front page, and the
                chapter noun is authored text ("Day", "Stop") rendered "Day 1"
                — deliberately NOT translated, it belongs to this story. */}
            <div className="story-home-fields">
              <label className="story-field">
                <span>{t("stories:fields.intro")}</span>
                <textarea
                  value={intro}
                  rows={3}
                  maxLength={5000}
                  onChange={(event) => setIntro(event.target.value)}
                  onBlur={() => {
                    const next = intro.trim();
                    if (next !== (story.intro ?? "")) void editor.patchStory({ intro: next || null });
                  }}
                  placeholder={t("stories:fields.introPlaceholder")}
                />
              </label>
              <label className="story-field story-field-noun">
                <span>{t("stories:fields.chapterNoun")}</span>
                <input
                  value={chapterNoun}
                  maxLength={30}
                  onChange={(event) => setChapterNoun(event.target.value)}
                  onBlur={() => {
                    const next = chapterNoun.trim();
                    if (next !== (story.chapterNoun ?? "")) void editor.patchStory({ chapterNoun: next || null });
                  }}
                  placeholder={t("stories:fields.chapterNounPlaceholder")}
                />
                <span className="muted">{t("stories:fields.chapterNounHint")}</span>
              </label>
              <div className="story-field story-field-rating">
                <span>{t("stories:rating.label")}</span>
                <div className="story-rating-row">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="story-rating-star"
                      onClick={() => void editor.patchStory({ rating: value })}
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
                    <Button variant="text" compact onClick={() => void editor.patchStory({ rating: null })} disabled={busy}>
                      {t("stories:rating.clear")}
                    </Button>
                  )}
                </div>
                <span className="muted">{t("stories:rating.hint")}</span>
              </div>
            </div>

            {!structured && !showChapterFields && (
              <div className="story-chapter-reveal">
                <Button variant="text" compact onClick={() => setShowChapterFields(true)}>
                  {t("stories:edit.addChapterDetails")}
                </Button>
              </div>
            )}

            {story.chapters.map((chapter, index) => (
              <StoryChapterEditor
                key={chapter.id}
                chapter={chapter}
                storyId={story.id}
                index={index}
                total={story.chapters.length}
                busy={busy}
                showChapterFields={structured || showChapterFields}
                storyTags={story.tags}
                onPatch={(fields) => void editor.patchChapter(chapter.id, fields)}
                onRemove={() => void editor.removeChapter(chapter.id)}
                onMove={(direction) => void editor.moveChapter(chapter.id, direction)}
                onAddBlock={(kind, fields) => void editor.addBlock(chapter.id, kind, fields)}
                blockActions={{
                  move: (blockId, direction) => void editor.moveBlock(chapter, blockId, direction),
                  patch: (blockId, fields) => void editor.patchBlock(blockId, fields),
                  remove: (blockId) => void editor.removeBlock(blockId)
                }}
              />
            ))}

            <div className="story-add-chapter">
              <Button variant="secondary" onClick={() => { setShowChapterFields(true); void editor.addChapter(); }} disabled={busy}>
                <Plus size={16} aria-hidden="true" />
                <span>{t("stories:edit.addChapter")}</span>
              </Button>
            </div>
          </>
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
