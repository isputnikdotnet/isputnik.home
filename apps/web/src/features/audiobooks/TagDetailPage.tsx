import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, BookText, Headphones, Images, Play, TreeDeciduous } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, getReferrer, goBack, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { FeedTile } from "../library/FeedTile";
import type { FeedItem } from "../library/feed";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { GalleryAsset } from "../gallery/types";
import { faceFocusStyle } from "../gallery/types";
import { PersonAvatar } from "../familytree/PersonAvatar";
import { lifeYears, type FamilyPerson } from "../familytree/types";
import { StoryCard } from "../stories/StoryCard";
import type { StorySummary } from "../stories/types";

interface TagDetail {
  name: string;
  books: FeedItem[];
  photos: GalleryAsset[];
  people: FamilyPerson[];
  stories: StorySummary[];
}

type KindFilter = "all" | "audiobook" | "ebook" | "gallery" | "family" | "story";

export function TagDetailPage({
  tagName,
  user,
  logout
}: {
  tagName: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book", "family"]);
  const [tag, setTag] = useState<TagDetail | null>(null);
  const [error, setError] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  // Photos open here rather than in the gallery, so closing one keeps the
  // reader on the tag they were browsing.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const backTo = getReferrer();

  useEffect(() => {
    setError("");
    setTag(null);
    setKindFilter("all");
    api<{ tag: TagDetail }>(`/api/library/tags/${encodeURIComponent(tagName)}/books`)
      .then((payload) => setTag(payload.tag))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:tags.unableLoadDetail")));
  }, [tagName]);

  const audiobookCount = tag?.books.filter((book) => book.kind === "audiobook").length ?? 0;
  const ebookCount = tag?.books.filter((book) => book.kind === "ebook").length ?? 0;
  const galleryCount = tag?.photos.length ?? 0;
  const familyCount = tag?.people.length ?? 0;
  const storyCount = tag?.stories.length ?? 0;
  const total = (tag?.books.length ?? 0) + galleryCount + familyCount + storyCount;

  // The toggle earns its place only when the tag spans more than one type.
  const scopes = useMemo(() => ([
    { value: "all" as const, label: t("common:common.all"), icon: null, count: total },
    { value: "audiobook" as const, label: t("common:nav.audiobooks"), icon: Headphones, count: audiobookCount },
    { value: "ebook" as const, label: t("common:nav.ebooks"), icon: BookOpen, count: ebookCount },
    { value: "gallery" as const, label: t("common:nav.gallery"), icon: Images, count: galleryCount },
    { value: "family" as const, label: t("common:nav.familyTree"), icon: TreeDeciduous, count: familyCount },
    { value: "story" as const, label: t("common:nav.stories"), icon: BookText, count: storyCount }
  ]), [total, audiobookCount, ebookCount, galleryCount, familyCount, storyCount, t]);
  const populated = scopes.filter((s) => s.value !== "all" && s.count > 0);
  const showToggle = populated.length > 1;

  const showBooks = kindFilter === "all" || kindFilter === "audiobook" || kindFilter === "ebook";
  const shownBooks = tag && showBooks
    ? (kindFilter === "all" ? tag.books : tag.books.filter((book) => book.kind === kindFilter))
    : [];
  const shownPhotos = tag && (kindFilter === "all" || kindFilter === "gallery") ? tag.photos : [];
  const shownPeople = tag && (kindFilter === "all" || kindFilter === "family") ? tag.people : [];
  const shownStories = tag && (kindFilter === "all" || kindFilter === "story") ? tag.stories : [];
  const nothingShown = shownBooks.length === 0 && shownPhotos.length === 0
    && shownPeople.length === 0 && shownStories.length === 0;

  return (
    <DashboardShell active="tags" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => goBack(backTo ?? "/tags")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? t("book:catalog.back") : t("book:tags.backToTags")}</span>
        </button>

        {error && <MessageBox tone="error" title={t("book:tags.detailErrorTitle")}>{error}</MessageBox>}

        {tag && (
          <>
            <div className="section-head audiobook-head">
              <div>
                <p className="eyebrow">{t("book:tags.eyebrow")}</p>
                <h1>{tag.name}</h1>
              </div>
              <span>{t("book:catalog.counts.item", { count: total })}</span>
            </div>

            {showToggle && (
              <div className="kind-toggle" role="group" aria-label={t("book:tags.filterByTypeAria")}>
                {scopes.filter((s) => s.value === "all" || s.count > 0).map(({ value, label, icon: Icon, count }) => (
                  <button
                    key={value}
                    type="button"
                    className={kindFilter === value ? "is-active" : ""}
                    onClick={() => setKindFilter(value)}
                  >
                    {Icon && <Icon size={15} aria-hidden="true" />}
                    {label}
                    <span className="kind-toggle-count">{count}</span>
                  </button>
                ))}
              </div>
            )}

            {nothingShown && <p className="management-empty">{t("book:tags.nothingYet")}</p>}

            {shownBooks.length > 0 && (
              <div className="library-feed-grid">
                {shownBooks.map((book) => (
                  <FeedTile key={`${book.kind}-${book.id}`} item={book} progress kindLabel={kindFilter === "all"} />
                ))}
              </div>
            )}

            {shownPhotos.length > 0 && (
              <>
                {kindFilter === "all" && <p className="gallery-section-label">{t("book:tags.photosVideosLabel")}</p>}
                <div className="gallery-grid tag-photo-grid">
                  {shownPhotos.map((photo, index) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="gallery-tile"
                      onClick={() => setLightboxIndex(index)}
                      title={photo.title}
                    >
                      {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" style={faceFocusStyle(photo)} />}
                      {photo.kind === "video" && (
                        <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("book:tags.videoBadge")}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {shownStories.length > 0 && (
              <>
                {kindFilter === "all" && <p className="gallery-section-label">{t("book:tags.storiesLabel")}</p>}
                <div className="audiobook-grid story-grid">
                  {shownStories.map((story) => <StoryCard key={story.id} story={story} />)}
                </div>
              </>
            )}

            {shownPeople.length > 0 && (
              <>
                {kindFilter === "all" && <p className="gallery-section-label">{t("book:tags.familyMembersLabel")}</p>}
                <div className="ft-people-grid">
                  {shownPeople.map((person) => (
                    <a
                      key={person.id}
                      className="ft-person-card"
                      href={`/family/people/${person.id}`}
                      onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
                    >
                      <PersonAvatar person={person} size={64} />
                      <strong>{person.name}</strong>
                      <small>
                        {[person.maidenName ? t("family:common.nee", { name: person.maidenName }) : "", lifeYears(person)]
                          .filter(Boolean)
                          .join(" · ") || " "}
                      </small>
                    </a>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {tag && lightboxIndex != null && tag.photos[lightboxIndex] && (
        <GalleryLightbox
          assets={tag.photos}
          index={lightboxIndex}
          canDelete={false}
          canEdit={false}
          canShare={false}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          onChanged={() => { /* read-only browse; counts refresh on next load */ }}
        />
      )}
    </DashboardShell>
  );
}
