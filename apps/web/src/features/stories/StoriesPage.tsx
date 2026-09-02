import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, BookText, BriefcaseBusiness, CalendarDays, CheckCircle2, ChevronDown, Eye, FolderOpen, Heart, Image as ImageIcon, LayoutGrid, Library, MapPin, Plus, Star, type LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate, queryParam } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SortMenu } from "../../shared/SortMenu";
import { PartialDateField } from "../../shared/PartialDateField";
import { PhotoPicker } from "../gallery/PhotoPicker";
import type { GalleryAsset } from "../gallery/types";
import { StoriesSectionNav, type StoryIndexCounts } from "./StoriesSectionNav";
import { StoryCard } from "./StoryCard";
import { StoryRefPicker } from "./StoryRefPicker";
import { StoryCollectionFormModal } from "./StoryCollectionFormModal";
import { NewStoryModal } from "./NewStoryModal";
import { STORY_KINDS, type StoryCollectionSummary, type StoryKind, type StoryStatus, type StorySummary } from "./types";

type StorySort = "updated" | "date" | "title";
type StoryView = "grid" | "list";

const FILTERS = ["drafts", "published", "favorites"] as const;
type StoryFilter = (typeof FILTERS)[number];
const COLLECTION_PREVIEW_COUNT = 6;
const STORY_PAGE_SIZE = 9;
const STORY_KIND_ICONS: Record<StoryKind, LucideIcon> = {
  free: BookText,
  memory: Heart,
  journal: BriefcaseBusiness,
  review: Star
};

// The story index: a Collections shelf ("Family Story", "Trips") over the
// grid of stories — every published one the viewer may see, plus their own
// drafts. Collections the viewer has no access to simply aren't here, and
// neither are their stories (the server enforces both).
//
// The sidebar's filters and kinds are addresses (?filter=…, ?kind=…), so this
// page reads its view off the URL each render; search, sort and grid/list are
// session state on the Stories section toolbar. The Collections shelf shows only on
// the unfiltered view — a filtered view is a question about stories.
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
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<StorySort>("updated");
  const [view, setView] = useState<StoryView>("grid");
  const [collectionsExpanded, setCollectionsExpanded] = useState(false);
  const [storyLimit, setStoryLimit] = useState(STORY_PAGE_SIZE);

  const rawFilter = queryParam("filter");
  const filter: StoryFilter | null = (FILTERS as readonly string[]).includes(rawFilter ?? "") ? rawFilter as StoryFilter : null;
  const rawKind = queryParam("kind");
  const kind: StoryKind | null = (STORY_KINDS as readonly string[]).includes(rawKind ?? "") && rawKind !== "free" ? rawKind as StoryKind : null;

  useEffect(() => {
    api<{ stories: StorySummary[] }>("/api/stories")
      .then((payload) => setStories(payload.stories))
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => { /* the shelf is an extra; the grid still stands */ });
    document.title = `${t("stories:title")} — isputnik.home`;
  }, []);

  // The sidebar's tallies, over everything the viewer can see — they describe
  // the destinations, so search and the current filter don't shrink them.
  const counts: StoryIndexCounts | undefined = useMemo(() => {
    if (!stories) return undefined;
    const by = (test: (story: StorySummary) => boolean) => stories.filter(test).length;
    return {
      all: stories.length,
      drafts: by((story) => story.status === "draft"),
      published: by((story) => story.status === "published"),
      favorites: by((story) => story.saved),
      journal: by((story) => story.kind === "journal"),
      memory: by((story) => story.kind === "memory"),
      review: by((story) => story.kind === "review")
    };
  }, [stories]);

  const visible = useMemo(() => {
    if (!stories) return null;
    const wantedStatus: StoryStatus | null = filter === "drafts" ? "draft" : filter === "published" ? "published" : null;
    const needle = search.trim().toLowerCase();
    const list = stories.filter((story) => {
      if (wantedStatus && story.status !== wantedStatus) return false;
      if (filter === "favorites" && !story.saved) return false;
      if (kind && story.kind !== kind) return false;
      if (needle) {
        const haystack = [story.title, story.subtitle ?? "", story.firstPlace ?? "", ...story.tags].join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    // The server already sends newest-updated first, so "updated" keeps its
    // order; the other two re-sort a copy.
    if (sort === "date") {
      return [...list].sort((a, b) => (b.firstDate ?? "").localeCompare(a.firstDate ?? ""));
    }
    if (sort === "title") {
      return [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [stories, filter, kind, search, sort]);

  useEffect(() => {
    setStoryLimit(STORY_PAGE_SIZE);
  }, [filter, kind, search, sort, view]);

  // Optimistic: the star flips at once, and flips back if the server refuses.
  const toggleSave = (story: StorySummary) => {
    const saved = !story.saved;
    const patch = (value: boolean) =>
      setStories((current) => current?.map((row) => row.id === story.id ? { ...row, saved: value } : row) ?? current);
    patch(saved);
    api(`/api/stories/${story.id}/save`, { method: "PUT", body: JSON.stringify({ saved }) })
      .catch(() => patch(!saved));
  };

  const activeKey = kind ? `kind-${kind}` : filter ?? "all";
  const showCollections = !filter && !kind && !search.trim() && collections.length > 0;
  // Most-storied shelves lead the first row, then "View all" reveals the rest.
  const shelf = useMemo(() => [...collections].sort((a, b) => b.storyCount - a.storyCount), [collections]);
  const shownCollections = collectionsExpanded ? shelf : shelf.slice(0, COLLECTION_PREVIEW_COUNT);
  const collectionTitles = useMemo(() => new Map(collections.map((collection) => [collection.id, collection.title])), [collections]);
  const sortOptions = [
    { value: "updated" as const, label: t("stories:index.sortUpdated") },
    { value: "date" as const, label: t("stories:index.sortDate") },
    { value: "title" as const, label: t("stories:index.sortTitle") }
  ];
  const shownStories = visible?.slice(0, storyLimit) ?? null;
  const hasMoreStories = visible != null && visible.length > storyLimit;

  return (
    <DashboardShell active="stories" user={user} logout={logout} sideNav={<StoriesSectionNav activeKey={activeKey} counts={counts} />}>
      <section className="work-area audiobook-area story-index">
        <LibraryPageHeader
          title={t("stories:title")}
          subtitle={t("stories:index.tagline")}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("stories:index.searchPlaceholder")}
          actions={
            <Button variant="secondary" compact onClick={() => setCreatingCollection(true)}>
              <Library size={16} />
              <span>{t("stories:collections.new")}</span>
            </Button>
          }
          primaryAction={
            <Button variant="primary" compact onClick={() => setCreating(true)}>
              <Plus size={16} />
              <span>{t("stories:newStory")}</span>
            </Button>
          }
        />

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}

        {stories && stories.length > 0 && (
          <LibraryPageToolbar
            tools={
              <>
                <SortMenu
                  presentation="labelled"
                  value={sort}
                  ariaLabel={t("stories:index.sortAria")}
                  onChange={setSort}
                  options={sortOptions}
                />
                <SortMenu
                  presentation="labelled"
                  value={view}
                  ariaLabel={t("stories:index.viewAria")}
                  onChange={setView}
                  icon={<LayoutGrid size={18} aria-hidden="true" />}
                  label={t("stories:index.viewLabel")}
                  options={[
                    { value: "grid", label: t("stories:index.viewGrid") },
                    { value: "list", label: t("stories:index.viewList") }
                  ]}
                />
              </>
            }
          />
        )}

        {showCollections && (
          <section className="story-index-section story-index-collections" aria-labelledby="story-collections-title">
            <header className="story-section-head">
              <span className="story-section-title">
                <FolderOpen size={22} aria-hidden="true" />
                <h2 id="story-collections-title">{t("stories:collections.heading")}</h2>
              </span>
              {shelf.length > shownCollections.length && (
                <Button variant="text" className="story-section-link" onClick={() => setCollectionsExpanded(true)}>
                  <span>{t("common:common.viewAll")}</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </Button>
              )}
            </header>
            <CollectionShelf collections={shownCollections} />
          </section>
        )}

        {stories === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {stories && stories.length === 0 && collections.length === 0 && (
          <div className="empty-state library-empty">
            <BookText size={58} aria-hidden="true" />
            <h2>{t("stories:empty.heading")}</h2>
            <p className="muted">{t("stories:empty.body")}</p>
          </div>
        )}

        {visible && stories && stories.length > 0 && (
          <section className="story-index-section story-index-stories" aria-labelledby="story-list-title">
            <header className="story-section-head">
              <span className="story-section-title">
                <BookOpen size={22} aria-hidden="true" />
                <h2 id="story-list-title">{t("stories:title")}</h2>
              </span>
            </header>

            {visible.length === 0 ? (
              <div className="empty-state library-empty">
                <BookText size={48} aria-hidden="true" />
                <h2>{t("stories:index.noneMatch")}</h2>
              </div>
            ) : view === "grid" ? (
              <>
                <div className="audiobook-grid story-grid">
                  {shownStories?.map((story) => (
                    <StoryCard
                      key={story.id}
                      story={story}
                      variant="index"
                      collectionTitle={story.collectionId ? collectionTitles.get(story.collectionId) : undefined}
                      onToggleSave={toggleSave}
                    />
                  ))}
                </div>
                {hasMoreStories && (
                  <div className="story-load-more">
                    <Button variant="secondary" compact onClick={() => setStoryLimit((current) => current + STORY_PAGE_SIZE)}>
                      <span>{t("stories:index.loadMore")}</span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="story-list">
                  {shownStories?.map((story) => <StoryRow key={story.id} story={story} onToggleSave={toggleSave} />)}
                </div>
                {hasMoreStories && (
                  <div className="story-load-more">
                    <Button variant="secondary" compact onClick={() => setStoryLimit((current) => current + STORY_PAGE_SIZE)}>
                      <span>{t("stories:index.loadMore")}</span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </section>

      {creating && <NewStoryModal onClose={() => setCreating(false)} />}
      {creatingCollection && <StoryCollectionFormModal onClose={() => setCreatingCollection(false)} />}
    </DashboardShell>
  );
}

// The Collections shelf on the index mirrors the mockup: one even grid of
// horizontal cards, each with its cover, title, story count and derived date span.
function CollectionShelf({ collections }: { collections: StoryCollectionSummary[] }) {
  const { t } = useTranslation(["common", "stories"]);

  const dateSpan = (collection: StoryCollectionSummary) =>
    formatPartialDateRange(collection.firstDate, collection.lastDate === collection.firstDate ? null : collection.lastDate);

  return (
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
            {collection.description && <span className="story-collection-note">{collection.description}</span>}
            <span className="story-collection-fact">
              <BookOpen size={13} aria-hidden="true" />
              {t("stories:collections.storyCount", { count: collection.storyCount })}
            </span>
            {dateSpan(collection) && (
              <span className="story-collection-fact">
                <CalendarDays size={13} aria-hidden="true" />
                {dateSpan(collection)}
              </span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}

// One story as a row — the list view's shape: thumbnail, title and note, then
// the same facts the card shows, in a line.
function StoryRow({ story, onToggleSave }: { story: StorySummary; onToggleSave: (story: StorySummary) => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const href = `/stories/${story.id}`;
  return (
    <div className="story-row">
      <a className="story-row-main" href={href} onClick={(event) => followRoute(event, href)}>
        <span className="story-row-cover" aria-hidden="true">
          {story.coverUrl ? <img src={story.coverUrl} alt="" loading="lazy" /> : <BookText size={18} />}
        </span>
        <span className="story-row-body">
          <strong>
            {story.title}
            {story.status === "draft" && <span className="story-draft-badge">{t("stories:status.draft")}</span>}
          </strong>
          {story.subtitle && <small>{story.subtitle}</small>}
        </span>
        <span className="story-row-meta">
          {story.kind !== "free" && <span className="story-kind-chip">{t(`stories:kinds.${story.kind}.name`)}</span>}
          <span>{formatPartialDateRange(story.firstDate, story.lastDate === story.firstDate ? null : story.lastDate)}</span>
          {story.rating != null && <span>★ {story.rating}</span>}
          {story.placesCount > 0 && (
            <span className="story-row-places">
              <MapPin size={13} aria-hidden="true" />
              {t("stories:count.places", { count: story.placesCount })}
            </span>
          )}
        </span>
      </a>
      <Button
        variant="icon"
        className={`story-card-save story-row-save${story.saved ? " is-saved" : ""}`}
        aria-label={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
        title={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
        aria-pressed={story.saved}
        onClick={() => onToggleSave(story)}
      >
        <Star size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}

