import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, CalendarDays, Globe2, Library, Plus, ShieldCheck, SquarePen, Trash2, UserRound, UsersRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { goBack, navigate } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { StoriesSectionNav } from "./StoriesSectionNav";
import { StoryCard } from "./StoryCard";
import { StoryCollectionFormModal } from "./StoryCollectionFormModal";
import { NewStoryModal } from "./NewStoryModal";
import { StoryCollectionAccessModal } from "./StoryCollectionAccessModal";
import type { StorySummary } from "./types";

interface CollectionDetail {
  id: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  coverUrl: string | null;
  canContribute: boolean;
  canManage: boolean;
  /** No Everyone access row — the shelf is members-only. Deleting it lifts
   *  that restriction, which the delete dialog must say out loud. */
  restricted: boolean;
  createdAt: string;
  updatedAt: string;
}

// A collection page: the shelf's hero, then its stories on a year spine —
// grouped by their own chapter dates, so the timeline is derived, never
// curated twice. "Add story" creates straight into the shelf; Access is the
// manager's door to who sees it (and through it, who sees its stories).
export function StoryCollectionPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);

  const load = () => {
    api<{ collection: CollectionDetail; stories: StorySummary[] }>(`/api/stories/collections/${id}`)
      .then((payload) => {
        setCollection(payload.collection);
        setStories(payload.stories);
        document.title = `${payload.collection.title} — isputnik.home`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  };
  useEffect(load, [id]);

  // The year spine: stories grouped by the year their chapters start, oldest
  // year first (a shelf reads forward in time); undated stories close the page.
  const groups = useMemo(() => {
    const byYear = new Map<string, StorySummary[]>();
    const undated: StorySummary[] = [];
    for (const story of stories) {
      const year = story.firstDate?.slice(0, 4);
      if (!year) { undated.push(story); continue; }
      byYear.set(year, [...(byYear.get(year) ?? []), story]);
    }
    const dated = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { dated, undated };
  }, [stories]);

  // Earliest date to latest — and a shelf that spans one day says that day
  // once, not twice, the same way the index's card does.
  const span = (() => {
    if (!collection) return "";
    const first = stories.find((story) => story.firstDate)?.firstDate ?? null;
    const last = [...stories].map((story) => story.lastDate ?? story.firstDate).filter(Boolean).sort().pop() ?? null;
    return formatPartialDateRange(first, last === first ? null : last);
  })();

  // The last cell of the timeline: an empty frame that opens the same "Add
  // story" modal the hero does. Contributors only — for everyone else the
  // grid ends with the stories.
  const addTile = collection?.canContribute ? (
    <button type="button" className="story-add-tile" onClick={() => setAdding(true)}>
      <span className="story-add-tile-mark" aria-hidden="true"><Plus size={22} /></span>
      <strong>{t("stories:collections.addStory")}</strong>
      <small>{t("stories:collections.addStoryHint")}</small>
    </button>
  ) : null;

  return (
    <DashboardShell active="stories" user={user} logout={logout} sideNav={<StoriesSectionNav activeKey={id} />}>
      <section className="work-area audiobook-area">
        <div className="book-detail-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => goBack("/stories")}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("stories:backTo")}</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}
        {!collection && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {collection && (
          <>
            <div className={`story-collection-hero${collection.coverUrl ? " has-image" : ""}`}>
              {collection.coverUrl && <img src={collection.coverUrl} alt="" />}
              <div className="story-collection-hero-text">
                <h1>{collection.title}</h1>
                {collection.description && <p className="story-collection-description">{collection.description}</p>}
                {(span || stories.length > 0) && (
                  <p className="story-collection-meta">
                    {span && (
                      <span className="story-collection-meta-item">
                        <CalendarDays size={14} aria-hidden="true" />
                        {span}
                      </span>
                    )}
                    <span className="story-collection-meta-item">
                      <BookOpen size={14} aria-hidden="true" />
                      {t("stories:collections.storyCount", { count: stories.length })}
                    </span>
                  </p>
                )}
                {/* Three things you do *with* a shelf. Renaming it, its
                    description and its cover all live behind Edit — and so
                    does deleting it, which is a change to the shelf, not an
                    action on the page. */}
                <div className="story-collection-actions">
                  {collection.canContribute && (
                    <Button variant="primary" compact onClick={() => setAdding(true)}>
                      <Plus size={15} aria-hidden="true" />
                      <span>{t("stories:collections.addStory")}</span>
                    </Button>
                  )}
                  {collection.canManage && (
                    <Button variant="secondary" compact onClick={() => setEditing(true)}>
                      <SquarePen size={15} aria-hidden="true" />
                      <span>{t("stories:actions.edit")}</span>
                    </Button>
                  )}
                  {collection.canManage && (
                    <Button variant="secondary" compact onClick={() => setAccessOpen(true)}>
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span>{t("stories:collections.access")}</span>
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {stories.length === 0 && (
              <div className="empty-state library-empty">
                <Library size={58} aria-hidden="true" />
                <h2>{t("stories:collections.emptyHeading")}</h2>
                <p className="muted">{t("stories:collections.emptyBody")}</p>
              </div>
            )}

            {groups.dated.map(([year, groupStories], index) => (
              <section className="story-collection-year" key={year}>
                <p className="gallery-section-label story-collection-year-label">{year}</p>
                <div className="audiobook-grid story-grid">
                  {groupStories.map((story) => <StoryCard key={story.id} story={story} />)}
                  {/* The tile closes the last group only — one invitation per
                      page, at the end of the timeline where the next story
                      will land. */}
                  {index === groups.dated.length - 1 && groups.undated.length === 0 && addTile}
                </div>
              </section>
            ))}
            {groups.undated.length > 0 && (
              <section className="story-collection-year">
                <p className="gallery-section-label story-collection-year-label">{t("stories:collections.undated")}</p>
                <div className="audiobook-grid story-grid">
                  {groups.undated.map((story) => <StoryCard key={story.id} story={story} />)}
                  {addTile}
                </div>
              </section>
            )}
          </>
        )}
      </section>

      {adding && collection && (
        <NewStoryModal
          collectionId={collection.id}
          collectionTitle={collection.title}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && collection && (
        <StoryCollectionFormModal
          collection={collection}
          storyCount={stories.length}
          onSaved={load}
          onClose={() => setEditing(false)}
        />
      )}

      {accessOpen && collection && (
        <StoryCollectionAccessModal collectionId={collection.id} onClose={() => setAccessOpen(false)} />
      )}
    </DashboardShell>
  );
}
