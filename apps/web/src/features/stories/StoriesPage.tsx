import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, Plus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { UserAreaNav } from "../library/UserAreaNav";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { formatPartialDateRange } from "../../shared/utils";
import type { StorySummary } from "./types";

// The story index: every published story, plus the viewer's own drafts.
export function StoriesPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [stories, setStories] = useState<StorySummary[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<{ stories: StorySummary[] }>("/api/stories")
      .then((payload) => setStories(payload.stories))
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
    document.title = `${t("stories:title")} — isputnik.home`;
  }, []);

  return (
    <DashboardShell active="user" user={user} logout={logout} sideNav={<UserAreaNav active="stories" />}>
      <section className="work-area audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">{t("stories:eyebrow")}</p>
            <h1>{t("stories:title")}</h1>
          </div>
          <Button variant="primary" compact onClick={() => setCreating(true)}>
            <Plus size={16} />
            <span>{t("stories:newStory")}</span>
          </Button>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}

        {stories === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {stories && stories.length === 0 && (
          <div className="empty-state library-empty">
            <BookText size={58} aria-hidden="true" />
            <h2>{t("stories:empty.heading")}</h2>
            <p className="muted">{t("stories:empty.body")}</p>
          </div>
        )}

        {stories && stories.length > 0 && (
          <div className="audiobook-grid story-grid">
            {stories.map((story) => (
              <button
                className="audiobook-card story-card"
                key={story.id}
                onClick={() => navigate(`/stories/${story.id}`)}
              >
                <div className="story-card-cover" aria-hidden="true">
                  {story.coverUrl ? <img src={story.coverUrl} alt="" /> : <BookText size={28} />}
                </div>
                <div className="audiobook-card-body">
                  <strong>{story.title}</strong>
                  <span>
                    {[
                      // The date span leads when the story has one — that is
                      // what a reader recognises it by.
                      formatPartialDateRange(
                        story.firstDate,
                        story.lastDate === story.firstDate ? null : story.lastDate
                      ),
                      story.chapterCount > 1
                        ? t("stories:count.chapters", { count: story.chapterCount })
                        : t("stories:count.blocks", { count: story.blockCount })
                    ].filter(Boolean).join(" · ")}
                  </span>
                  {story.subtitle && <p className="audiobook-card-note">{story.subtitle}</p>}
                  {story.status === "draft" && (
                    <span className="story-draft-badge">{t("stories:status.draft")}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {creating && <NewStoryModal onClose={() => setCreating(false)} />}
    </DashboardShell>
  );
}

// A new story opens straight into its editor — there is nothing to look at
// until something is written.
function NewStoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { story } = await api<{ story: { id: string } }>("/api/stories", {
        method: "POST",
        body: JSON.stringify({ title: trimmed, subtitle: subtitle.trim() || null })
      });
      navigate(`/stories/${story.id}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.create"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("stories:newStory")}
      icon={<BookText size={20} />}
      busy={saving}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="modal-tab-content new-collection-form">
        {error && <MessageBox tone="error" title={t("stories:errors.createTitle")}>{error}</MessageBox>}

        <label className="field">
          <span>{t("stories:fields.title")}</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("stories:fields.titlePlaceholder")}
            maxLength={160}
          />
        </label>

        <label className="field">
          <span>{t("stories:fields.subtitle")} <small className="muted">{t("stories:fields.optional")}</small></span>
          <input
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            placeholder={t("stories:fields.subtitlePlaceholder")}
            maxLength={300}
          />
        </label>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
            {saving ? t("stories:actions.creating") : t("stories:actions.create")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
