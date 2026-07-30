import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Headphones, Images, Play, TreeDeciduous } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { FeedTile } from "../library/FeedTile";
import type { FeedItem } from "../library/feed";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { GalleryAsset } from "../gallery/types";
import { PersonAvatar } from "../familytree/PersonAvatar";
import { lifeYears, type FamilyPerson } from "../familytree/types";

interface TagDetail {
  name: string;
  books: FeedItem[];
  photos: GalleryAsset[];
  people: FamilyPerson[];
}

type KindFilter = "all" | "audiobook" | "ebook" | "gallery" | "family";

export function TagDetailPage({
  tagName,
  user,
  logout
}: {
  tagName: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
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
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tag"));
  }, [tagName]);

  const audiobookCount = tag?.books.filter((book) => book.kind === "audiobook").length ?? 0;
  const ebookCount = tag?.books.filter((book) => book.kind === "ebook").length ?? 0;
  const galleryCount = tag?.photos.length ?? 0;
  const familyCount = tag?.people.length ?? 0;
  const total = (tag?.books.length ?? 0) + galleryCount + familyCount;

  // The toggle earns its place only when the tag spans more than one type.
  const scopes = useMemo(() => ([
    { value: "all" as const, label: "All", icon: null, count: total },
    { value: "audiobook" as const, label: "Audiobooks", icon: Headphones, count: audiobookCount },
    { value: "ebook" as const, label: "Ebooks", icon: BookOpen, count: ebookCount },
    { value: "gallery" as const, label: "Gallery", icon: Images, count: galleryCount },
    { value: "family" as const, label: "Family tree", icon: TreeDeciduous, count: familyCount }
  ]), [total, audiobookCount, ebookCount, galleryCount, familyCount]);
  const populated = scopes.filter((s) => s.value !== "all" && s.count > 0);
  const showToggle = populated.length > 1;

  const showBooks = kindFilter === "all" || kindFilter === "audiobook" || kindFilter === "ebook";
  const shownBooks = tag && showBooks
    ? (kindFilter === "all" ? tag.books : tag.books.filter((book) => book.kind === kindFilter))
    : [];
  const shownPhotos = tag && (kindFilter === "all" || kindFilter === "gallery") ? tag.photos : [];
  const shownPeople = tag && (kindFilter === "all" || kindFilter === "family") ? tag.people : [];
  const nothingShown = shownBooks.length === 0 && shownPhotos.length === 0 && shownPeople.length === 0;

  return (
    <DashboardShell active="tags" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/tags")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : "Back to tags"}</span>
        </button>

        {error && <MessageBox tone="error" title="Tag error">{error}</MessageBox>}

        {tag && (
          <>
            <div className="section-head audiobook-head">
              <div>
                <p className="eyebrow">Tag</p>
                <h1>{tag.name}</h1>
              </div>
              <span>{total} {total === 1 ? "item" : "items"}</span>
            </div>

            {showToggle && (
              <div className="kind-toggle" role="group" aria-label="Filter by type">
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

            {nothingShown && <p className="management-empty">Nothing carries this tag yet.</p>}

            {shownBooks.length > 0 && (
              <div className="library-feed-grid">
                {shownBooks.map((book) => (
                  <FeedTile key={`${book.kind}-${book.id}`} item={book} progress kindLabel={kindFilter === "all"} />
                ))}
              </div>
            )}

            {shownPhotos.length > 0 && (
              <>
                {kindFilter === "all" && <p className="gallery-section-label">Photos &amp; videos</p>}
                <div className="gallery-grid tag-photo-grid">
                  {shownPhotos.map((photo, index) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="gallery-tile"
                      onClick={() => setLightboxIndex(index)}
                      title={photo.title}
                    >
                      {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" />}
                      {photo.kind === "video" && (
                        <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {shownPeople.length > 0 && (
              <>
                {kindFilter === "all" && <p className="gallery-section-label">Family members</p>}
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
                        {[person.maidenName ? `née ${person.maidenName}` : "", lifeYears(person)]
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
