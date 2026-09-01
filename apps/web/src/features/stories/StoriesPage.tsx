import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, LayoutGrid, Library, MapPin, Plus, Star } from "lucide-react";
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
import { StoriesSectionNav, type StoryIndexCounts } from "./StoriesSectionNav";
import { StoryCard } from "./StoryCard";
import { StoryRefPicker } from "./StoryRefPicker";
import { STORY_KINDS, type StoryCollectionSummary, type StoryKind, type StoryStatus, type StorySummary } from "./types";

type StorySort = "updated" | "date" | "title";
type StoryView = "grid" | "list";

const FILTERS = ["drafts", "published", "favorites"] as const;
type StoryFilter = (typeof FILTERS)[number];

// The story index: a Collections shelf ("Family Story", "Trips") over the
// grid of stories — every published one the viewer may see, plus their own
// drafts. Collections the viewer has no access to simply aren't here, and
// neither are their stories (the server enforces both).
//
// The sidebar's filters and kinds are addresses (?filter=…, ?kind=…), so this
// page reads its view off the URL each render; search, sort and grid/list are
// session state on the shared toolbar. The Collections shelf shows only on
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
  // Most-storied shelf first: it becomes the wide, featured card.
  const shelf = useMemo(() => [...collections].sort((a, b) => b.storyCount - a.storyCount), [collections]);

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

        {showCollections && (
          <>
            <p className="gallery-section-label">{t("stories:collections.heading")}</p>
            <CollectionShelf collections={shelf} />
          </>
        )}

        {stories !== null && stories.length > 0 && (
          <LibraryPageToolbar
            tools={
              <>
                <SortMenu
                  presentation="labelled"
                  value={sort}
                  ariaLabel={t("stories:index.sortAria")}
                  onChange={setSort}
                  options={[
                    { value: "updated", label: t("stories:index.sortUpdated") },
                    { value: "date", label: t("stories:index.sortDate") },
                    { value: "title", label: t("stories:index.sortTitle") }
                  ]}
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

        {stories === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {stories && stories.length === 0 && collections.length === 0 && (
          <div className="empty-state library-empty">
            <BookText size={58} aria-hidden="true" />
            <h2>{t("stories:empty.heading")}</h2>
            <p className="muted">{t("stories:empty.body")}</p>
          </div>
        )}

        {visible && stories && stories.length > 0 && (
          visible.length === 0 ? (
            <div className="empty-state library-empty">
              <BookText size={48} aria-hidden="true" />
              <h2>{t("stories:index.noneMatch")}</h2>
            </div>
          ) : view === "grid" ? (
            <>
              {showCollections && <p className="gallery-section-label">{t("stories:title")}</p>}
              <div className="audiobook-grid story-grid">
                {visible.map((story) => <StoryCard key={story.id} story={story} onToggleSave={toggleSave} />)}
              </div>
            </>
          ) : (
            <div className="story-list">
              {visible.map((story) => <StoryRow key={story.id} story={story} onToggleSave={toggleSave} />)}
            </div>
          )
        )}
      </section>

      {creating && <NewStoryModal onClose={() => setCreating(false)} />}
      {creatingCollection && <NewCollectionModal onClose={() => setCreatingCollection(false)} />}
    </DashboardShell>
  );
}

// The Collections shelf: the fullest shelf gets the wide, featured card —
// cover across the back, description alongside — and the rest line up as the
// familiar small cards.
function CollectionShelf({ collections }: { collections: StoryCollectionSummary[] }) {
  const { t } = useTranslation(["common", "stories"]);
  const [featured, ...rest] = collections;
  if (!featured) return null;

  const span = (collection: StoryCollectionSummary) => [
    formatPartialDateRange(collection.firstDate, collection.lastDate === collection.firstDate ? null : collection.lastDate),
    t("stories:collections.storyCount", { count: collection.storyCount })
  ].filter(Boolean).join(" · ");

  return (
    <div className="story-collection-shelf">
      <a
        className={`story-collection-feature${featured.coverUrl ? " has-image" : ""}`}
        href={`/stories/collections/${featured.id}`}
        onClick={(event) => followRoute(event, `/stories/collections/${featured.id}`)}
      >
        {featured.coverUrl && <img src={featured.coverUrl} alt="" loading="lazy" />}
        <span className="story-collection-feature-body">
          <strong>{featured.title}</strong>
          {featured.description && <p>{featured.description}</p>}
          <small>{span(featured)}</small>
        </span>
      </a>
      {rest.map((collection) => (
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
            <small>{span(collection)}</small>
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
      <button
        type="button"
        className={`story-card-save story-row-save${story.saved ? " is-saved" : ""}`}
        aria-label={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
        title={story.saved ? t("stories:card.unsave") : t("stories:card.save")}
        aria-pressed={story.saved}
        onClick={() => onToggleSave(story)}
      >
        <Star size={16} aria-hidden="true" />
      </button>
    </div>
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
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

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

        {(kind === "memory" || kind === "free") && (
          <div className="story-create-row">
            <PartialDateField
              label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
              value={date}
              onChange={setDate}
              placeholder={t("stories:chapter.datePlaceholder")}
            />
            {kind === "memory" && (
              <label className="field">
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
            <div className="story-create-row">
              <PartialDateField
                label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                value={date}
                onChange={setDate}
                placeholder={t("stories:chapter.datePlaceholder")}
              />
              <PartialDateField
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

        <div className="modal-actions">
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
    </Modal>
  );
}
