import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, Library, Plus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { StoryCard } from "./StoryCard";
import { STORY_KINDS, type StoryCollectionSummary, type StoryKind, type StorySummary } from "./types";

// The story index: a Collections shelf ("Family Story", "Trips") over the
// grid of stories — every published one the viewer may see, plus their own
// drafts. Collections the viewer has no access to simply aren't here, and
// neither are their stories (the server enforces both).
export function StoriesPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [stories, setStories] = useState<StorySummary[] | null>(null);
  const [collections, setCollections] = useState<StoryCollectionSummary[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);

  useEffect(() => {
    api<{ stories: StorySummary[] }>("/api/stories")
      .then((payload) => setStories(payload.stories))
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => { /* the shelf is an extra; the grid still stands */ });
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
          <div className="story-index-actions">
            <Button variant="secondary" compact onClick={() => setCreatingCollection(true)}>
              <Library size={16} />
              <span>{t("stories:collections.new")}</span>
            </Button>
            <Button variant="primary" compact onClick={() => setCreating(true)}>
              <Plus size={16} />
              <span>{t("stories:newStory")}</span>
            </Button>
          </div>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}

        {collections.length > 0 && (
          <>
            <p className="gallery-section-label">{t("stories:collections.heading")}</p>
            <div className="story-collection-shelf">
              {collections.map((collection) => (
                <a
                  key={collection.id}
                  className="story-collection-card"
                  href={`/stories/collections/${collection.id}`}
                  onClick={(event) => followRoute(event, `/stories/collections/${collection.id}`)}
                >
                  <span className="story-collection-cover" aria-hidden="true">
                    {collection.coverUrl ? <img src={collection.coverUrl} alt="" loading="lazy" /> : <Library size={26} />}
                  </span>
                  <span className="story-collection-body">
                    <strong>{collection.title}</strong>
                    <small>
                      {[
                        formatPartialDateRange(collection.firstDate, collection.lastDate === collection.firstDate ? null : collection.lastDate),
                        t("stories:collections.storyCount", { count: collection.storyCount })
                      ].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                </a>
              ))}
            </div>
          </>
        )}

        {stories === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {stories && stories.length === 0 && collections.length === 0 && (
          <div className="empty-state library-empty">
            <BookText size={58} aria-hidden="true" />
            <h2>{t("stories:empty.heading")}</h2>
            <p className="muted">{t("stories:empty.body")}</p>
          </div>
        )}

        {stories && stories.length > 0 && (
          <>
            {collections.length > 0 && <p className="gallery-section-label">{t("stories:title")}</p>}
            <div className="audiobook-grid story-grid">
              {stories.map((story) => <StoryCard key={story.id} story={story} />)}
            </div>
          </>
        )}
      </section>

      {creating && <NewStoryModal onClose={() => setCreating(false)} />}
      {creatingCollection && <NewCollectionModal onClose={() => setCreatingCollection(false)} />}
    </DashboardShell>
  );
}

// A new shelf opens on its own page, ready for its first story.
function NewCollectionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { collectionId } = await api<{ collectionId: string }>("/api/stories/collections", {
        method: "POST",
        body: JSON.stringify({ title: trimmed, description: description.trim() || null })
      });
      navigate(`/stories/collections/${collectionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.create"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("stories:collections.new")}
      icon={<Library size={20} />}
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
            placeholder={t("stories:collections.titlePlaceholder")}
            maxLength={160}
          />
        </label>

        <label className="field">
          <span>{t("stories:collections.descriptionField")} <small className="muted">{t("stories:fields.optional")}</small></span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("stories:collections.descriptionPlaceholder")}
            rows={2}
            maxLength={2000}
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

// A new story opens straight into its editor — there is nothing to look at
// until something is written. The kind is a TEMPLATE choice made here and
// only here: it seeds the shape (a journal counts its days, a review opens on
// a book) and is never managed afterward.
function NewStoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [kind, setKind] = useState<StoryKind>("free");
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
        body: JSON.stringify({ title: trimmed, subtitle: subtitle.trim() || null, kind })
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

        <div className="story-kind-row" role="radiogroup" aria-label={t("stories:kinds.label")}>
          {STORY_KINDS.map((option) => (
            <button
              key={option}
              type="button"
              className={`story-kind-option${kind === option ? " is-current" : ""}`}
              role="radio"
              aria-checked={kind === option}
              onClick={() => setKind(option)}
            >
              <strong>{t(`stories:kinds.${option}.name`)}</strong>
              <small>{t(`stories:kinds.${option}.hint`)}</small>
            </button>
          ))}
        </div>

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
