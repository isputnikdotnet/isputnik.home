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
      {creatingCollection && <NewCollectionModal onClose={() => setCreatingCollection(false)} />}
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

// A new shelf opens on its own page, ready for its first story.
function NewCollectionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cover, setCover] = useState<GalleryAsset | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const previewTitle = title.trim() || t("stories:collections.titlePlaceholder");
  const previewDescription = description.trim() || t("stories:collections.descriptionPlaceholder");

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
      // Creation itself takes no cover — it's a follow-up PATCH, same as
      // setting one later from the collection page. A failure here shouldn't
      // strand an otherwise-successful create; the cover stays settable after.
      if (cover) {
        await api(`/api/stories/collections/${collectionId}`, {
          method: "PATCH",
          body: JSON.stringify({ coverItemId: cover.id })
        }).catch(() => {});
      }
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
      subtitle={t("stories:collections.createIntro")}
      icon={<Library size={24} />}
      className="story-new-collection-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="modal-tab-content story-new-collection-content">
        {error && <MessageBox tone="error" title={t("stories:errors.createTitle")}>{error}</MessageBox>}

        <div className="story-new-collection-layout">
          <div className="story-new-collection-fields">
            <label className="field story-new-collection-field">
              <span>{t("stories:fields.title")}</span>
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("stories:collections.titlePlaceholder")}
                maxLength={160}
              />
              <small>{t("stories:collections.titleHint")}</small>
            </label>

            <label className="field story-new-collection-field">
              <span>{t("stories:collections.descriptionField")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("stories:collections.descriptionPlaceholder")}
                rows={5}
                maxLength={2000}
              />
              <small>{t("stories:collections.descriptionHint")}</small>
            </label>
          </div>

          <aside className="story-collection-preview-panel" aria-label={t("stories:collections.preview")}>
            <h3>
              <Eye size={20} aria-hidden="true" />
              <span>{t("stories:collections.preview")}</span>
            </h3>

            <div className="story-collection-preview-card">
              <div className="story-collection-preview-covers" aria-hidden="true">
                {cover?.coverUrl ? (
                  <img src={cover.coverUrl} alt="" />
                ) : (
                  <>
                    <span className="story-preview-photo is-back-left" />
                    <span className="story-preview-photo is-back-right" />
                    <span className="story-preview-photo is-main" />
                    <span className="story-preview-photo is-side" />
                  </>
                )}
              </div>
              <strong>{previewTitle}</strong>
              <p>{previewDescription}</p>
              <span className="story-preview-divider" />
              <span className="story-preview-count">
                <Library size={14} aria-hidden="true" />
                {t("stories:collections.storyCount", { count: 0 })}
              </span>
            </div>

            <div className="story-cover-field">
              <span>
                {t("stories:collections.coverImage")} <small className="muted">{t("stories:fields.optional")}</small>
              </span>
              {cover ? (
                <div className="story-chapter-hero-row">
                  <img className="story-chapter-hero-thumb" src={cover.coverUrl ?? undefined} alt="" />
                  <Button variant="secondary" compact onClick={() => setPickingCover(true)} disabled={saving}>
                    {t("stories:fields.changeCover")}
                  </Button>
                  <Button variant="text" compact onClick={() => setCover(null)} disabled={saving}>
                    {t("stories:fields.clearCover")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="story-cover-picker-button"
                  onClick={() => setPickingCover(true)}
                  disabled={saving}
                >
                  <ImageIcon size={20} aria-hidden="true" />
                  <span>{t("stories:collections.setCover")}</span>
                </Button>
              )}
            </div>
          </aside>
        </div>

        <div className="modal-actions story-new-collection-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
            {saving ? t("stories:collections.creating") : t("stories:collections.create")}
          </Button>
        </div>
      </div>

      {pickingCover && (
        <PhotoPicker
          title={t("stories:collections.coverPickerTitle")}
          pick="any"
          onPick={(asset) => { setPickingCover(false); setCover(asset); }}
          onClose={() => setPickingCover(false)}
        />
      )}
    </Modal>
  );
}

// A new story opens straight into its editor — there is nothing to look at
// until something is written. The kind is a TEMPLATE choice made here and
// only here, and the modal's fields follow it: a memory asks when and where,
// a travel blog asks from–to (a full range lays out one chapter per day), a
// review asks which book. Everything is skippable, everything it seeds is an
// ordinary field afterwards, and the kind gates nothing.
function NewStoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [kind, setKind] = useState<StoryKind>("free");
  const [date, setDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [place, setPlace] = useState("");
  const [book, setBook] = useState<{ id: string; entityType: "audiobook" | "ebook"; title: string } | null>(null);
  const [pickingBook, setPickingBook] = useState(false);
  const [cover, setCover] = useState<GalleryAsset | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const previewTitle = title.trim() || (kind === "review" ? book?.title.trim() : "") || t("stories:fields.titlePlaceholder");
  const previewSubtitle = subtitle.trim() || t("stories:fields.subtitlePlaceholder");
  const previewDate = kind === "journal"
    ? formatPartialDateRange(date.trim(), endDate.trim() || null)
    : kind !== "review"
      ? formatPartialDateRange(date.trim(), null)
      : "";
  const previewPlace = kind === "memory" ? place.trim() : "";

  const submit = async () => {
    // A review with a chosen book can go out untitled — the book names it.
    const trimmed = title.trim() || (kind === "review" ? book?.title ?? "" : "");
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { story } = await api<{ story: { id: string } }>("/api/stories", {
        method: "POST",
        body: JSON.stringify({
          title: trimmed,
          subtitle: subtitle.trim() || null,
          kind,
          date: kind !== "review" && date.trim() ? date.trim() : null,
          endDate: kind === "journal" && endDate.trim() ? endDate.trim() : null,
          place: kind === "memory" && place.trim() ? place.trim() : null,
          reviewOf: kind === "review" && book ? { entityType: book.entityType, entityId: book.id } : null
        })
      });
      // Same follow-up-PATCH shape as the collection modal: creation takes no
      // cover, and a failure here shouldn't strand an otherwise-successful
      // create — the cover stays settable from the editor afterwards.
      if (cover) {
        await api(`/api/stories/${story.id}`, {
          method: "PATCH",
          body: JSON.stringify({ coverItemId: cover.id })
        }).catch(() => {});
      }
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
      subtitle={t("stories:create.intro")}
      icon={<BookText size={24} />}
      className="story-new-story-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="modal-tab-content story-new-story-content">
        {error && <MessageBox tone="error" title={t("stories:errors.createTitle")}>{error}</MessageBox>}

        <div className="story-new-story-layout">
          <div className="story-new-story-fields">
            <div className="story-kind-row" role="radiogroup" aria-label={t("stories:kinds.label")}>
              {STORY_KINDS.map((option) => {
                const KindIcon = STORY_KIND_ICONS[option];
                return (
                  <Button
                    key={option}
                    variant="secondary"
                    className={`story-kind-option${kind === option ? " is-current" : ""}`}
                    role="radio"
                    aria-checked={kind === option}
                    onClick={() => setKind(option)}
                  >
                    <span className="story-kind-option-icon">
                      <KindIcon size={19} aria-hidden="true" />
                      {kind === option && <CheckCircle2 size={17} className="story-kind-check" aria-hidden="true" />}
                    </span>
                    <strong>{t(`stories:kinds.${option}.name`)}</strong>
                    <small>{t(`stories:kinds.${option}.hint`)}</small>
                  </Button>
                );
              })}
            </div>

            <label className="field story-new-story-field">
              <span>{t("stories:fields.title")}</span>
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("stories:fields.titlePlaceholder")}
                maxLength={160}
              />
            </label>

            <label className="field story-new-story-field">
              <span>{t("stories:fields.subtitle")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <input
                value={subtitle}
                onChange={(event) => setSubtitle(event.target.value)}
                placeholder={t("stories:fields.subtitlePlaceholder")}
                maxLength={300}
              />
            </label>

            {(kind === "memory" || kind === "free") && (
              <div className="story-create-row story-new-story-date-row">
                <PartialDateField
                  className="story-new-story-field"
                  label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                  value={date}
                  onChange={setDate}
                  placeholder={t("stories:chapter.datePlaceholder")}
                />
                {kind === "memory" && (
                  <label className="field story-new-story-field">
                    <span>{t("stories:chapter.placeField")} <small className="muted">{t("stories:fields.optional")}</small></span>
                    <input
                      value={place}
                      onChange={(event) => setPlace(event.target.value)}
                      placeholder={t("stories:chapter.placePlaceholder")}
                      maxLength={200}
                    />
                  </label>
                )}
              </div>
            )}

            {kind === "journal" && (
              <>
                <div className="story-create-row story-new-story-date-row">
                  <PartialDateField
                    className="story-new-story-field"
                    label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                    value={date}
                    onChange={setDate}
                    placeholder={t("stories:chapter.datePlaceholder")}
                  />
                  <PartialDateField
                    className="story-new-story-field"
                    label={t("stories:chapter.endDateField")}
                    value={endDate}
                    onChange={setEndDate}
                    placeholder={t("stories:chapter.endDatePlaceholder")}
                  />
                </div>
                <p className="muted story-create-hint">{t("stories:create.journalRangeHint")}</p>
              </>
            )}

            {kind === "review" && (
              <div className="story-create-row story-create-book">
                <Button variant="secondary" compact onClick={() => setPickingBook(true)} disabled={saving}>
                  <BookText size={15} aria-hidden="true" />
                  <span>{book ? t("stories:create.changeBook") : t("stories:create.pickBook")}</span>
                </Button>
                {book && <span className="story-create-book-title">{book.title}</span>}
              </div>
            )}
          </div>

          <aside className="story-new-story-preview-panel" aria-label={t("stories:actions.preview")}>
            <h3>
              <Eye size={20} aria-hidden="true" />
              <span>{t("stories:actions.preview")}</span>
            </h3>

            <div className="story-new-story-preview-card">
              {cover?.coverUrl ? (
                <img className="story-new-story-preview-cover" src={cover.coverUrl} alt="" />
              ) : (
                <span className="story-new-story-preview-cover" aria-hidden="true" />
              )}
              <div className="story-new-story-preview-body">
                <strong>{previewTitle}</strong>
                <p>{previewSubtitle}</p>
                {(previewDate || previewPlace) && (
                  <div className="story-new-story-preview-meta">
                    {previewDate && (
                      <span>
                        <CalendarDays size={15} aria-hidden="true" />
                        {previewDate}
                      </span>
                    )}
                    {previewPlace && (
                      <span>
                        <MapPin size={15} aria-hidden="true" />
                        {previewPlace}
                      </span>
                    )}
                  </div>
                )}
                <div className="story-new-story-preview-chips">
                  <span>
                    <Library size={15} aria-hidden="true" />
                    {t(`stories:kinds.${kind}.name`)}
                  </span>
                  {kind === "review" && book && (
                    <span>
                      <BookText size={15} aria-hidden="true" />
                      {book.title}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="story-cover-field">
              <span>
                {t("stories:create.coverImage")} <small className="muted">{t("stories:fields.optional")}</small>
              </span>
              {cover ? (
                <div className="story-chapter-hero-row">
                  <img className="story-chapter-hero-thumb" src={cover.coverUrl ?? undefined} alt="" />
                  <Button variant="secondary" compact onClick={() => setPickingCover(true)} disabled={saving}>
                    {t("stories:fields.changeCover")}
                  </Button>
                  <Button variant="text" compact onClick={() => setCover(null)} disabled={saving}>
                    {t("stories:fields.clearCover")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="story-cover-picker-button"
                  onClick={() => setPickingCover(true)}
                  disabled={saving}
                >
                  <ImageIcon size={20} aria-hidden="true" />
                  <span>{t("stories:fields.setCover")}</span>
                </Button>
              )}
            </div>
          </aside>
        </div>

        <div className="modal-actions story-new-story-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving || (!title.trim() && !(kind === "review" && book))}
          >
            {saving ? t("stories:actions.creating") : t("stories:actions.create")}
          </Button>
        </div>
      </div>

      {pickingBook && (
        <StoryRefPicker
          kind="book"
          onPick={(id, entityType, bookTitle) => {
            setPickingBook(false);
            if (!entityType) return;
            setBook({ id, entityType, title: bookTitle ?? "" });
          }}
          onClose={() => setPickingBook(false)}
        />
      )}

      {pickingCover && (
        <PhotoPicker
          title={t("stories:fields.coverPickerTitle")}
          pick="any"
          onPick={(asset) => { setPickingCover(false); setCover(asset); }}
          onClose={() => setPickingCover(false)}
        />
      )}
    </Modal>
  );
}
