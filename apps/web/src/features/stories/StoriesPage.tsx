import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, Plus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { StoryCard } from "./StoryCard";
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
    <DashboardShell active="stories" user={user} logout={logout}>
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
            {stories.map((story) => <StoryCard key={story.id} story={story} />)}
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
