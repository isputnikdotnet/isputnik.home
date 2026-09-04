import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, MapPin, Pencil, Send, Star } from "lucide-react";
import { api } from "../../api";
import { followReplace, followRoute, goBack, navigate, replaceNavigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Button } from "../../shared/Button";
import { useIsMobile } from "../../shared/useIsMobile";
import { formatPartialDate, formatPartialDateRange } from "../../shared/utils";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { GalleryAsset } from "../gallery/types";
import type { SlideshowTransition } from "../gallery/types";
import { NotesSection } from "../social/NotesSection";
import { SendToSheet } from "../social/SendToSheet";
import { StoryBlockView } from "./StoryBlockView";
import { StoryMarkdown } from "./StoryMarkdown";
import { StoryMap } from "./StoryMap";
import { StoryStep } from "./StoryStep";
import { chapterDateText, groupIntoRows } from "./story-layout";
import { chapterLabel, hasChapterStructure, type StoryBlock, type StoryChapter, type StoryDetail } from "./types";

// The story SITE: reading a story is chrome-free — no app nav, only the
// story's own navigation (docs/stories-v2-proposal.md, "Site view replaces the
// player"). /stories/:id is the Story Home (hero, intro, chapter cards, story
// map); each chapter is its own page at /stories/:id/chapters/:chapterId. A
// story with one bare chapter collapses to a single reading page at the story
// URL, exactly as v1 rendered it.
export function StoryDetailPage({ id, chapterId }: { id: string; chapterId?: string }) {
  const { t } = useTranslation(["common", "stories"]);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const isMobile = useIsMobile();
  const [lightbox, setLightbox] = useState<
    { assets: GalleryAsset[]; index: number; autoPlay?: boolean; transition?: SlideshowTransition; interval?: number; transitionSeconds?: number; musicUrl?: string } | null
  >(null);

  useEffect(() => {
    setStory(null);
    setError("");
    api<{ story: StoryDetail }>(`/api/stories/${id}`)
      .then((payload) => setStory(payload.story))
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  }, [id]);

  const structured = story ? hasChapterStructure(story) : false;
  const chapterIndex = story && chapterId
    ? story.chapters.findIndex((chapter) => chapter.id === chapterId)
    : -1;
  const chapter = chapterIndex >= 0 ? story!.chapters[chapterIndex] : null;

  useEffect(() => {
    if (!story) return;
    document.title = chapter
      ? `${chapterLabel(story, chapter, chapterIndex)} — ${story.title} — isputnik.home`
      : `${story.title} — isputnik.home`;
  }, [story, chapter, chapterIndex]);

  // A slideshow block plays with its own settings, so it looks the same inside a
  // story as it does in the gallery. The block only carries a preview strip, so
  // the full item list is fetched at the moment Play is pressed.
  const playSlideshow = async (block: StoryBlock) => {
    if (!block.entityId) return;
    try {
      const payload = await api<{
        slideshow: { transition: SlideshowTransition; slideSeconds: number; transitionSeconds: number; musicUrl: string | null };
        assets: GalleryAsset[];
      }>(`/api/library/gallery/slideshows/${block.entityId}?limit=500`);
      if (payload.assets.length === 0) return;
      setLightbox({
        assets: payload.assets,
        index: 0,
        autoPlay: true,
        transition: payload.slideshow.transition,
        interval: payload.slideshow.slideSeconds,
        transitionSeconds: payload.slideshow.transitionSeconds,
        musicUrl: payload.slideshow.musicUrl ?? undefined
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.playSlideshow"));
    }
  };

  const openMedia = (assets: GalleryAsset[], index: number) => setLightbox({ assets, index });

  // Chapter moves REPLACE the history entry: the whole story is one step in
  // the trail, so Back leaves to wherever the reader came from (a book page,
  // the collection, the feed) instead of replaying every day. The strip and
  // prev/next are the story's own way of stepping through days.
  const openChapter = (targetId: string) => replaceNavigate(`/stories/${id}/chapters/${targetId}`);

  // What the story's own navigation looks like: a rail beside the page, which
  // shows the shape of the journey — every chapter, dated, with the photo it
  // opens on — and stays there while a chapter is read. Every story wears it,
  // whatever its shape: a one-page review lists no days, but it is read the
  // same way and handed on with the same buttons. Only a phone, with no room
  // for a column beside the page, keeps the bar and the horizontal strip.
  const railLayout = Boolean(story && !isMobile);
  const actions = story && (story.canEdit || story.status === "published")
    ? (
      <>
        {story.canEdit && (
          <Button variant="secondary" compact onClick={() => navigate(`/stories/${story.id}/edit`)}>
            <Pencil size={15} aria-hidden="true" />
            <span>{t("stories:actions.edit")}</span>
          </Button>
        )}
        {/* One door for handing a story on, the same as everywhere else in the
            app: Send holds the people and the guest link together, and manages
            both itself. Shown to whoever has something to do in it — a reader of
            a published story can send it, an author can always mint a link, even
            for a draft. */}
        <Button variant="secondary" compact onClick={() => setSending(true)}>
          <Send size={15} aria-hidden="true" />
          <span>{t("stories:actions.send")}</span>
        </Button>
      </>
    )
    : null;

  // Honest label on both: with chapter moves collapsed into one history entry,
  // this returns to wherever the reader came from rather than to a fixed page.
  const backButton = (
    <button className="story-site-exit" type="button" onClick={() => goBack("/stories")}>
      <ArrowLeft size={18} aria-hidden="true" />
      <span>{t("stories:site.exit")}</span>
    </button>
  );

  return (
    <div className={`story-site${railLayout ? " has-rail" : ""}`}>
      {!railLayout && (
        <header className="story-site-bar">
          {backButton}
          {story && (
            <a
              className="story-site-name"
              href={`/stories/${story.id}`}
              onClick={(event) => followReplace(event, `/stories/${story.id}`)}
            >
              {story.title}
            </a>
          )}
          {actions && <div className="story-site-actions">{actions}</div>}
        </header>
      )}

      {!railLayout && story && structured && (
        <nav className="story-site-strip" aria-label={t("stories:site.stripAria")}>
          <a
            href={`/stories/${story.id}`}
            className={chapter ? "" : "is-current"}
            onClick={(event) => followReplace(event, `/stories/${story.id}`)}
          >
            {t("stories:site.overview")}
          </a>
          {story.chapters.map((item, index) => (
            <a
              key={item.id}
              href={`/stories/${story.id}/chapters/${item.id}`}
              className={item.id === chapterId ? "is-current" : ""}
              onClick={(event) => followReplace(event, `/stories/${story.id}/chapters/${item.id}`)}
            >
              {chapterLabel(story, item, index)}
            </a>
          ))}
        </nav>
      )}

      <div className="story-site-shell">
        {railLayout && story && (
          <aside className="story-site-rail">
            {backButton}

            <div className="story-site-rail-card">
              <nav className="story-site-steps" aria-label={t("stories:site.stripAria")}>
                {/* The story's name rides on the first step: the rail is the
                    only thing on a chapter's page that says which story it
                    belongs to. A story with no chapters to list has no
                    "overview" to be distinct from, so the step is the story. */}
                <StoryStep
                  href={`/stories/${story.id}`}
                  current={!chapter}
                  label={structured ? t("stories:site.overview") : story.title}
                  sub={structured ? story.title : ""}
                  mark={<BookOpen size={14} aria-hidden="true" />}
                />
                {structured && story.chapters.map((item, index) => {
                  const thumb = chapterThumb(item);
                  const label = chapterLabel(story, item, index);
                  const dateText = chapterDateText(item, formatPartialDate, formatPartialDateRange);
                  // A chapter with no name of its own is labelled by its date,
                  // and a step that says "Jun 22, 2025" twice says nothing the
                  // second time — fall through to the place instead.
                  const sub = [dateText, item.place].find((value) => value && value !== label) ?? "";
                  return (
                    <StoryStep
                      key={item.id}
                      href={`/stories/${story.id}/chapters/${item.id}`}
                      current={item.id === chapterId}
                      label={label}
                      sub={sub}
                      mark={thumb
                        ? <img src={thumb} alt="" loading="lazy" />
                        : <span>{index + 1}</span>}
                    />
                  );
                })}
              </nav>

              {actions && <div className="story-site-rail-actions">{actions}</div>}
            </div>
          </aside>
        )}

        <main className="story-site-page">
          {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}
          {!story && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

          {story && chapterId && !chapter && (
            <MessageBox tone="error" title={t("stories:errors.loadTitle")}>
              {t("stories:site.chapterMissing")}
            </MessageBox>
          )}

          {story && chapter && (
            <ChapterPage
              story={story}
              chapter={chapter}
              index={chapterIndex}
              onOpenMedia={openMedia}
              onPlaySlideshow={playSlideshow}
              onOpenChapter={openChapter}
            />
          )}

          {story && !chapterId && (structured
            ? <StoryHome story={story} onOpenChapter={openChapter} />
            : <FlatStory story={story} onOpenMedia={openMedia} onPlaySlideshow={playSlideshow} />
          )}
        </main>
      </div>

      {story && sending && (
        <SendToSheet
          subject={{ entityType: "story", entityId: story.id }}
          onClose={() => setSending(false)}
        />
      )}

      {lightbox && (
        <GalleryLightbox
          assets={lightbox.assets}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(next) => setLightbox((state) => (state ? { ...state, index: next } : state))}
          // A story is a reading surface: editing a photo belongs in the gallery.
          onChanged={() => {}}
          canDelete={false}
          canEdit={false}
          canShare={false}
          autoPlay={lightbox.autoPlay}
          transition={lightbox.transition}
          transitionSeconds={lightbox.transitionSeconds}
          initialInterval={lightbox.interval}
          musicUrl={lightbox.musicUrl}
        />
      )}
    </div>
  );
}

/** The story's stars, read-only — five outlines, `value` of them filled. */
function StoryStars({ value }: { value: number }) {
  const { t } = useTranslation(["stories"]);
  return (
    <span className="story-stars" role="img" aria-label={t("stories:rating.aria", { count: value })}>
      {[1, 2, 3, 4, 5].map((step) => (
        <Star key={step} size={14} aria-hidden="true" fill={step <= value ? "currentColor" : "none"} />
      ))}
    </span>
  );
}

/** The best image a chapter can offer its card: the hero, else the first
 *  visible photo any of its blocks shows. */
function chapterThumb(chapter: StoryChapter): string | null {
  if (chapter.hero?.coverUrl) return chapter.hero.coverUrl;
  for (const block of chapter.blocks) {
    if (block.asset?.coverUrl && block.asset.kind !== "audio") return block.asset.coverUrl;
    const preview = block.preview.find((asset) => asset.coverUrl);
    if (preview?.coverUrl) return preview.coverUrl;
  }
  return null;
}

/** Every photo/video a chapter's blocks show — the "Photos from Day N" footer. */
function chapterGallery(chapter: StoryChapter): GalleryAsset[] {
  const seen = new Set<string>();
  const out: GalleryAsset[] = [];
  for (const block of chapter.blocks) {
    for (const asset of [block.asset, ...block.preview]) {
      if (!asset || asset.kind === "audio" || seen.has(asset.id)) continue;
      seen.add(asset.id);
      out.push(asset);
    }
  }
  return out;
}

// ── Story Home ─────────────────────────────────────────────────────────────

// How every story opens, whatever shape it is: the cover it was given, its
// name, its subtitle and the facts underneath — when, where, what it was worth.
// A travel blog and a one-page review are the same kind of thing to a reader,
// so they get the same front door; only what follows it differs.
function StoryHead({ story }: { story: StoryDetail }) {
  const { t } = useTranslation(["common", "stories"]);

  const span = formatPartialDateRange(
    story.chapters.find((item) => item.date)?.date ?? null,
    [...story.chapters].reverse().find((item) => item.endDate ?? item.date)?.endDate ?? null
  );

  // The story's primary location: the place its chapters name most often.
  const primaryPlace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of story.chapters) {
      if (item.place) counts.set(item.place, (counts.get(item.place) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [story]);

  // A photo cover has a larger rendition for the hero; a book's artwork is one
  // image, and it still beats falling through to a chapter's photo.
  const heroUrl = story.cover?.previewUrl
    ?? story.coverUrl
    ?? story.chapters.find((item) => item.hero?.previewUrl)?.hero?.previewUrl
    ?? null;

  return (
    <header className={`story-home-hero${heroUrl ? " has-image" : ""}`}>
      {heroUrl && <img src={heroUrl} alt="" />}
      <div className="story-home-hero-text">
        {story.status === "draft" && (
          <span className="story-draft-badge">{t("stories:status.draft")}</span>
        )}
        <h1>{story.title}</h1>
        {story.subtitle && <p className="story-read-subtitle">{story.subtitle}</p>}
        {/* Signed on the cover, the way a book is. The end of the story says it
            again (StoryColophon) — that is where you look when you have just
            finished reading and want to know whose it was. */}
        {story.authorName && (
          <p className="story-byline">{t("stories:read.byline", { name: story.authorName })}</p>
        )}
        {(span || primaryPlace || story.rating != null) && (
          <p className="story-home-meta">
            {span}
            {span && primaryPlace && <span aria-hidden="true"> · </span>}
            {primaryPlace && (
              <span className="story-chapter-place"><MapPin size={13} aria-hidden="true" /> {primaryPlace}</span>
            )}
            {story.rating != null && <StoryStars value={story.rating} />}
          </p>
        )}
      </div>
    </header>
  );
}

/** How a story ends: who wrote it, once there is nothing left to read. Shown
 *  at the foot of a one-page story and at the foot of the LAST chapter — a
 *  signature belongs where the reader finishes, not under every day of a trip. */
function StoryColophon({ name }: { name: string | null }) {
  const { t } = useTranslation(["common", "stories"]);
  if (!name) return null;
  return <p className="story-colophon">{t("stories:read.byline", { name })}</p>;
}

/** The tag chips under a story's opening, on every shape of story. */
function StoryTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="story-read-tags">
      {tags.map((tag) => (
        <li key={tag}>
          <a
            href={`/tags/${encodeURIComponent(tag)}`}
            onClick={(event) => followRoute(event, `/tags/${encodeURIComponent(tag)}`)}
          >
            {tag}
          </a>
        </li>
      ))}
    </ul>
  );
}

function StoryHome({ story, onOpenChapter }: { story: StoryDetail; onOpenChapter: (id: string) => void }) {
  const { t } = useTranslation(["common", "stories"]);

  const pins = story.chapters
    .map((item, index) => (item.placeLat != null && item.placeLng != null
      ? { id: item.id, lat: item.placeLat, lng: item.placeLng, label: String(index + 1), title: chapterLabel(story, item, index) }
      : null))
    .filter((pin): pin is NonNullable<typeof pin> => pin != null);

  return (
    <article className="story-home">
      <StoryHead story={story} />

      {story.intro && (
        <div className="story-home-intro">
          <StoryMarkdown source={story.intro} />
        </div>
      )}

      <StoryTags tags={story.tags} />

      {/* Above the chapters, not below them: the map is how a reader gets their
          bearings before choosing where to start, and a list of days is a long
          thing to scroll past to reach it. */}
      {pins.length > 0 && (
        <section className="story-home-map-section">
          <h2>{t("stories:site.mapHeading")}</h2>
          <StoryMap pins={pins} onOpen={onOpenChapter} />
        </section>
      )}

      <div className="story-home-chapters">
        {story.chapters.map((item, index) => {
          const thumb = chapterThumb(item);
          const label = chapterLabel(story, item, index);
          const dateText = chapterDateText(item, formatPartialDate, formatPartialDateRange);
          const dateLabel = dateText && item.dateApprox ? t("stories:chapter.approx", { date: dateText }) : dateText;
          return (
            <button
              key={item.id}
              type="button"
              className="story-home-card"
              onClick={() => onOpenChapter(item.id)}
            >
              {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="story-home-card-blank" aria-hidden="true" />}
              <span className="story-home-card-body">
                <span className="story-home-card-eyebrow">{label}</span>
                {/* Without a chapter noun the label already IS the title. */}
                {item.title && item.title !== label && <span className="story-home-card-title">{item.title}</span>}
                {(dateLabel || item.place) && (
                  <span className="story-home-card-meta">
                    {dateLabel}
                    {dateLabel && item.place ? " · " : ""}
                    {item.place ?? ""}
                  </span>
                )}
                {item.standfirst && <span className="story-home-card-standfirst">{item.standfirst}</span>}
              </span>
              <ChevronRight size={18} aria-hidden="true" className="story-home-card-go" />
            </button>
          );
        })}
      </div>

      {/* The family's reaction to the story belongs with the story, the way
          notes hang off a photo or a book. */}
      <NotesSection entityType="story" entityId={story.id} />
    </article>
  );
}

// ── A flat (single bare chapter) story — the v1 journal page, unchanged ────

function FlatStory({
  story,
  onOpenMedia,
  onPlaySlideshow
}: {
  story: StoryDetail;
  onOpenMedia: (assets: GalleryAsset[], index: number) => void;
  onPlaySlideshow: (block: StoryBlock) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  return (
    <article className="story-home story-read">
      {/* The same opening a chaptered story gets: a review or a single note is
          no less a story, and it used to start with bare text on white while
          its cover — the book's own artwork, often — went unshown. */}
      <StoryHead story={story} />

      {story.intro && (
        <div className="story-home-intro">
          <StoryMarkdown source={story.intro} />
        </div>
      )}

      <StoryTags tags={story.tags} />

      {story.chapters.every((item) => item.blocks.length === 0) && (
        <MessageBox tone="info" title={t("stories:read.emptyTitle")}>
          {story.canEdit ? t("stories:read.emptyAuthor") : t("stories:read.emptyReader")}
        </MessageBox>
      )}

      {story.chapters.map((item) => (
        <section className="story-chapter" key={item.id}>
          <ChapterBlocks chapter={item} onOpenMedia={onOpenMedia} onPlaySlideshow={onPlaySlideshow} />
        </section>
      ))}

      <StoryColophon name={story.authorName} />

      <NotesSection entityType="story" entityId={story.id} />
    </article>
  );
}

// ── One chapter as its own page ────────────────────────────────────────────

function ChapterPage({
  story,
  chapter,
  index,
  onOpenMedia,
  onPlaySlideshow,
  onOpenChapter
}: {
  story: StoryDetail;
  chapter: StoryChapter;
  index: number;
  onOpenMedia: (assets: GalleryAsset[], index: number) => void;
  onPlaySlideshow: (block: StoryBlock) => void;
  onOpenChapter: (id: string) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const label = chapterLabel(story, chapter, index);
  const heading = chapter.title ?? label;
  const eyebrow = label !== heading ? label : null;
  const dateText = chapterDateText(chapter, formatPartialDate, formatPartialDateRange);
  const dateLabel = dateText && chapter.dateApprox
    ? t("stories:chapter.approx", { date: dateText })
    : dateText;
  const gallery = chapterGallery(chapter);
  // "Use map as cover": the pin is drawn as the hero, and the standalone map
  // below is dropped — one chapter, one map.
  const mapCover = chapter.heroMap && chapter.placeLat != null && chapter.placeLng != null;
  // A chapter with no cover of its own wears the story's, so every chapter page
  // opens on a picture rather than on text over nothing.
  const heroUrl = chapter.hero?.previewUrl ?? story.cover?.previewUrl ?? story.coverUrl ?? null;
  const prev = index > 0 ? story.chapters[index - 1] : null;
  const next = index < story.chapters.length - 1 ? story.chapters[index + 1] : null;

  return (
    <article className="story-read story-chapter-page">
      <header className={`story-chapter-hero${heroUrl && !mapCover ? " has-image" : ""}${mapCover ? " has-map" : ""}`}>
        {mapCover
          ? (
            <StoryMap
              pins={[{ id: chapter.id, lat: chapter.placeLat!, lng: chapter.placeLng!, label: "", title: label }]}
              onOpen={() => {}}
            />
          )
          : heroUrl && <img src={heroUrl} alt="" />}
        <div className="story-chapter-hero-text">
          <p className="story-chapter-meta">
            {/* Without a chapter noun the label is the heading below — no echo. */}
            {[eyebrow, dateLabel].filter(Boolean).join(" · ")}
            {(eyebrow || dateLabel) && chapter.place && <span aria-hidden="true"> · </span>}
            {chapter.place && (
              <span className="story-chapter-place"><MapPin size={13} aria-hidden="true" /> {chapter.place}</span>
            )}
          </p>
          <h1>{heading}</h1>
          {chapter.standfirst && <p className="story-chapter-standfirst">{chapter.standfirst}</p>}
        </div>
      </header>

      {chapter.placeLat != null && chapter.placeLng != null && !mapCover && (
        <StoryMap
          pins={[{ id: chapter.id, lat: chapter.placeLat, lng: chapter.placeLng, label: String(index + 1), title: label }]}
          onOpen={() => {}}
        />
      )}

      {chapter.description && <p className="story-chapter-description">{chapter.description}</p>}

      <ChapterBlocks chapter={chapter} onOpenMedia={onOpenMedia} onPlaySlideshow={onPlaySlideshow} />

      {gallery.length > 0 && (
        <section className="story-chapter-photos">
          <h2>
            {t("stories:site.photosFrom", { label })}
            <span className="story-chapter-photos-count"> · {t("stories:site.shotCount", { count: gallery.length })}</span>
          </h2>
          <div className="story-chapter-photos-strip">
            {gallery.map((asset, assetIndex) => (
              <button key={asset.id} type="button" onClick={() => onOpenMedia(gallery, assetIndex)}>
                {asset.coverUrl && <img src={asset.coverUrl} alt={asset.title} loading="lazy" />}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Only the last chapter is signed: that is where the story ends. */}
      {!next && <StoryColophon name={story.authorName} />}

      <nav className="story-chapter-nav">
        {prev ? (
          <button type="button" onClick={() => onOpenChapter(prev.id)}>
            <ChevronLeft size={16} aria-hidden="true" />
            <span>{chapterLabel(story, prev, index - 1)}</span>
          </button>
        ) : <span />}
        {next ? (
          <button type="button" onClick={() => onOpenChapter(next.id)}>
            <span>{chapterLabel(story, next, index + 1)}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ) : <span />}
      </nav>
    </article>
  );
}

// The block stream, shared by the flat story and the chapter page.
function ChapterBlocks({
  chapter,
  onOpenMedia,
  onPlaySlideshow
}: {
  chapter: StoryChapter;
  onOpenMedia: (assets: GalleryAsset[], index: number) => void;
  onPlaySlideshow: (block: StoryBlock) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  return (
    <div className="story-blocks">
      {groupIntoRows(chapter.blocks).map((row) =>
        row.length === 1 ? (
          // A block may carry its own heading ("Photos from Day 1"); grouped
          // rows never do, since a headed block is never grouped.
          <div className="story-block-slot" key={row[0].id}>
            {row[0].heading && <h2 className="story-block-heading">{row[0].heading}</h2>}
            <StoryBlockView
              block={row[0]}
              onOpenMedia={onOpenMedia}
              onPlaySlideshow={onPlaySlideshow}
            />
          </div>
        ) : (
          // Consecutive photos read as one plate rather than a stack of
          // full-width images — the photo-essay convention.
          <div className="story-media-row" key={row[0].id} data-count={row.length}>
            {row.map((block) => (
              <StoryBlockView
                key={block.id}
                block={block}
                onOpenMedia={() => onOpenMedia(
                  row.map((item) => item.asset).filter((asset): asset is GalleryAsset => Boolean(asset)),
                  row.filter((item) => item.asset).findIndex((item) => item.id === block.id)
                )}
                onPlaySlideshow={onPlaySlideshow}
              />
            ))}
          </div>
        )
      )}
      {chapter.blocks.length === 0 && (
        <p className="muted story-chapter-empty">{t("stories:read.chapterEmpty")}</p>
      )}
    </div>
  );
}
