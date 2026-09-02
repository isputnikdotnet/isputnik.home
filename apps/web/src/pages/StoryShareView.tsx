import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronLeft, ChevronRight, Download, Headphones, Images, MapPin, Mic, Play, Quote, Star, UserRound } from "lucide-react";
import { StoryMarkdown } from "../features/stories/StoryMarkdown";
import { GalleryMiniMap } from "../features/gallery/GalleryMiniMap";
import { formatPartialDate, formatPartialDateRange } from "../shared/utils";

// The public face of a shared story. Deliberately NOT the signed-in reading
// view: a guest has no session, so nothing here links back into the app, media
// comes only from token-scoped URLs, and an album shows exactly the photos the
// link chose to expose.
//
// The layout classes are the reading view's (styles/stories.css), so a story
// looks the same to a guest as it does to the family — including the site
// shape: a chaptered story gets a front page and per-chapter pages, navigated
// with a ?chapter= query on the one share URL (the payload already holds
// every chapter, so no extra route or request is needed).

export interface StoryShareAsset {
  id: string;
  title: string;
  kind: "photo" | "video";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  coverUrl: string;
  previewUrl: string;
  fileUrl: string;
  downloadUrl: string;
}

// Every kind may carry its own heading, so it rides alongside the union rather
// than being repeated in nine places.
export type StoryShareBlock = StoryShareBlockBody & { heading?: string | null };

type StoryShareBlockBody =
  | { kind: "text"; body: string }
  | { kind: "media"; caption: string | null; layout: string | null; asset: StoryShareAsset }
  | { kind: "album" | "slideshow"; title: string | null; caption: string | null; itemCount: number; items: StoryShareAsset[] }
  | { kind: "map"; lat: number; lng: number; zoom: number | null; label: string | null; caption: string | null }
  | { kind: "person"; name: string; birthDate: string | null; deathDate: string | null; caption: string | null }
  | { kind: "quote"; text: string; attribution: string | null; caption: string | null }
  | { kind: "audio"; title: string | null; durationSeconds: number | null; url: string; caption: string | null }
  | { kind: "book"; title: string | null; author: string | null; bookType: string; caption: string | null };

export interface StoryShareChapter {
  /** A bare handle for the guest page's own ?chapter= navigation. */
  id: string;
  title: string | null;
  date: string | null;
  endDate: string | null;
  dateApprox: boolean;
  place: string | null;
  placeLat: number | null;
  placeLng: number | null;
  standfirst: string | null;
  description: string | null;
  hero: StoryShareAsset | null;
  /** The chapter's pin is its cover — drawn instead of the hero photo. */
  heroMap?: boolean;
  blocks: StoryShareBlock[];
}

export interface StorySharePayload {
  type: "story";
  share: { label: string | null; expiresAt: string; sharedBy: string | null };
  story: {
    title: string;
    subtitle: string | null;
    chapterNoun: string | null;
    intro: string | null;
    rating: number | null;
    cover: StoryShareAsset | null;
    expandAlbums: boolean;
    chapters: StoryShareChapter[];
  };
}

/** "Day 1" / the chapter's title / its date / a number — same resolution as
 *  the signed-in site view. */
function shareChapterLabel(story: StorySharePayload["story"], chapter: StoryShareChapter, index: number): string {
  if (story.chapterNoun) return `${story.chapterNoun} ${index + 1}`;
  return chapter.title ?? chapter.date ?? String(index + 1);
}

/** Every photo a chapter's blocks show — the "Photos from Day N" strip. */
function chapterAssets(chapter: StoryShareChapter): StoryShareAsset[] {
  const seen = new Set<string>();
  const out: StoryShareAsset[] = [];
  for (const block of chapter.blocks) {
    const assets = block.kind === "media" ? [block.asset]
      : block.kind === "album" || block.kind === "slideshow" ? block.items : [];
    for (const asset of assets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      out.push(asset);
    }
  }
  return out;
}

export function StoryShareView({ token, payload }: { token: string; payload: StorySharePayload }) {
  const { t } = useTranslation(["common", "user", "stories"]);
  const { story, share } = payload;

  // One flat list of every photo the page shows, so the viewer can step through
  // the whole story rather than being trapped inside one block.
  const gallery: StoryShareAsset[] = story.chapters.flatMap(chapterAssets);
  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = openId == null ? -1 : gallery.findIndex((asset) => asset.id === openId);
  const open = openIndex >= 0 ? gallery[openIndex] : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
      else if (event.key === "ArrowRight" && openIndex < gallery.length - 1) setOpenId(gallery[openIndex + 1].id);
      else if (event.key === "ArrowLeft" && openIndex > 0) setOpenId(gallery[openIndex - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openIndex, gallery]);

  const hasStructure = story.chapters.length > 1
    || Boolean(story.chapters[0] && (story.chapters[0].title || story.chapters[0].date || story.chapters[0].place));

  // Which chapter page the guest is on (null = the front page). Kept in the
  // URL's ?chapter= so a guest can share or reload a specific day; Back works
  // because the browser's history carries the query.
  const [chapterId, setChapterId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("chapter")
  );
  const goTo = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("chapter", id);
    else url.searchParams.delete("chapter");
    window.history.pushState({}, "", url);
    setChapterId(id);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const onPop = () => setChapterId(new URLSearchParams(window.location.search).get("chapter"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const chapterIndex = chapterId ? story.chapters.findIndex((chapter) => chapter.id === chapterId) : -1;
  const chapter = chapterIndex >= 0 ? story.chapters[chapterIndex] : null;

  return (
    <div className="share-page">
      <div className="share-card share-card--story">
        {hasStructure && (
          <nav className="story-site-strip" aria-label={t("stories:site.stripAria")}>
            <button type="button" className={chapter ? "" : "is-current"} onClick={() => goTo(null)}>
              {t("stories:site.overview")}
            </button>
            {story.chapters.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={item.id === chapterId ? "is-current" : ""}
                onClick={() => goTo(item.id)}
              >
                {shareChapterLabel(story, item, index)}
              </button>
            ))}
          </nav>
        )}

        {hasStructure && chapter ? (
          <ShareChapterPage
            story={story}
            chapter={chapter}
            index={chapterIndex}
            onOpen={setOpenId}
            onGoTo={goTo}
          />
        ) : hasStructure ? (
          <ShareStoryHome
            story={story}
            sharedBy={share.sharedBy}
            token={token}
            galleryCount={gallery.length}
            onGoTo={goTo}
          />
        ) : (
          <article className="story-read">
            <header className="story-read-head">
              <h1>{story.title}</h1>
              {story.subtitle && <p className="story-read-subtitle">{story.subtitle}</p>}
              {story.rating != null && <ShareStars value={story.rating} />}
              {story.intro && <StoryMarkdown source={story.intro} />}
              {share.sharedBy && (
                <p className="share-shared-by">{t("user:sharePage.sharedBy", { name: share.sharedBy })}</p>
              )}
              <div className="story-read-actions">
                {gallery.length > 0 && (
                  <a className="secondary-button compact-button" href={`/api/share/${token}/download-all`} download>
                    <Download size={15} aria-hidden="true" />
                    <span>{t("user:sharePage.downloadAll")}</span>
                  </a>
                )}
              </div>
            </header>

            {story.chapters.every((item) => item.blocks.length === 0) && (
              <p className="muted">{t("stories:read.emptyReader")}</p>
            )}

            {story.chapters.map((item, index) => (
              <ChapterSection key={index} chapter={item} showHeader={false} onOpen={setOpenId} />
            ))}
          </article>
        )}
      </div>

      {open && (
        <div className="share-viewer" role="dialog" aria-modal="true" onClick={() => setOpenId(null)}>
          <div className="share-viewer-inner" onClick={(event) => event.stopPropagation()}>
            {open.kind === "video" ? (
              <video src={open.fileUrl} poster={open.previewUrl} controls autoPlay />
            ) : (
              <img src={open.previewUrl} alt={open.title} />
            )}
            <div className="share-viewer-bar">
              <span>{open.title}</span>
              <a className="secondary-button compact-button" href={open.downloadUrl} download>
                <Download size={15} aria-hidden="true" />
                <span>{t("user:sharePage.download")}</span>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShareStars({ value }: { value: number }) {
  const { t } = useTranslation(["stories"]);
  return (
    <span className="story-stars" role="img" aria-label={t("stories:rating.aria", { count: value })}>
      {[1, 2, 3, 4, 5].map((step) => (
        <Star key={step} size={14} aria-hidden="true" fill={step <= value ? "currentColor" : "none"} />
      ))}
    </span>
  );
}

// The guest front page — the same shape the family sees: hero, intro, a card
// per chapter, the download of everything the link exposes.
function ShareStoryHome({
  story,
  sharedBy,
  token,
  galleryCount,
  onGoTo
}: {
  story: StorySharePayload["story"];
  sharedBy: string | null;
  token: string;
  galleryCount: number;
  onGoTo: (id: string) => void;
}) {
  const { t } = useTranslation(["common", "user", "stories"]);
  const heroUrl = story.cover?.previewUrl
    ?? story.chapters.find((chapter) => chapter.hero)?.hero?.previewUrl
    ?? null;

  return (
    <article className="story-home">
      <header className={`story-home-hero${heroUrl ? " has-image" : ""}`}>
        {heroUrl && <img src={heroUrl} alt="" />}
        <div className="story-home-hero-text">
          <h1>{story.title}</h1>
          {story.subtitle && <p className="story-read-subtitle">{story.subtitle}</p>}
          {story.rating != null && <p className="story-home-meta"><ShareStars value={story.rating} /></p>}
        </div>
      </header>

      {story.intro && <div className="story-home-intro"><StoryMarkdown source={story.intro} /></div>}

      {sharedBy && <p className="share-shared-by">{t("user:sharePage.sharedBy", { name: sharedBy })}</p>}

      <div className="story-home-chapters">
        {story.chapters.map((chapter, index) => {
          const label = shareChapterLabel(story, chapter, index);
          const thumb = chapter.hero?.coverUrl ?? chapterAssets(chapter)[0]?.coverUrl ?? null;
          const dateText = chapter.date
            ? (chapter.endDate ? formatPartialDateRange(chapter.date, chapter.endDate) : formatPartialDate(chapter.date))
            : "";
          const dateLabel = dateText && chapter.dateApprox ? t("stories:chapter.approx", { date: dateText }) : dateText;
          return (
            <button key={chapter.id} type="button" className="story-home-card" onClick={() => onGoTo(chapter.id)}>
              {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="story-home-card-blank" aria-hidden="true" />}
              <span className="story-home-card-body">
                <span className="story-home-card-eyebrow">{label}</span>
                {chapter.title && chapter.title !== label && (
                  <span className="story-home-card-title">{chapter.title}</span>
                )}
                {(dateLabel || chapter.place) && (
                  <span className="story-home-card-meta">
                    {dateLabel}
                    {dateLabel && chapter.place ? " · " : ""}
                    {chapter.place ?? ""}
                  </span>
                )}
                {chapter.standfirst && <span className="story-home-card-standfirst">{chapter.standfirst}</span>}
              </span>
              <ChevronRight size={18} aria-hidden="true" className="story-home-card-go" />
            </button>
          );
        })}
      </div>

      {galleryCount > 0 && (
        <div className="story-read-actions">
          <a className="secondary-button compact-button" href={`/api/share/${token}/download-all`} download>
            <Download size={15} aria-hidden="true" />
            <span>{t("user:sharePage.downloadAll")}</span>
          </a>
        </div>
      )}
    </article>
  );
}

// One chapter as its own guest page: hero band, blocks, the photo strip,
// and a way to the day before and after.
function ShareChapterPage({
  story,
  chapter,
  index,
  onOpen,
  onGoTo
}: {
  story: StorySharePayload["story"];
  chapter: StoryShareChapter;
  index: number;
  onOpen: (id: string) => void;
  onGoTo: (id: string | null) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const label = shareChapterLabel(story, chapter, index);
  const heading = chapter.title ?? label;
  // "Use map as cover": the chapter's pin is drawn as the hero band.
  const mapCover = Boolean(chapter.heroMap && chapter.placeLat != null && chapter.placeLng != null);
  // Failing a cover of its own, a chapter wears the story's — the same
  // token-scoped picture the front page opens on.
  const heroUrl = chapter.hero?.previewUrl ?? story.cover?.previewUrl ?? null;
  const eyebrow = label !== heading ? label : null;
  const dateText = chapter.date
    ? (chapter.endDate ? formatPartialDateRange(chapter.date, chapter.endDate) : formatPartialDate(chapter.date))
    : "";
  const dateLabel = dateText && chapter.dateApprox ? t("stories:chapter.approx", { date: dateText }) : dateText;
  const photos = chapterAssets(chapter);
  const prev = index > 0 ? story.chapters[index - 1] : null;
  const next = index < story.chapters.length - 1 ? story.chapters[index + 1] : null;

  return (
    <article className="story-read story-chapter-page">
      <header className={`story-chapter-hero${heroUrl && !mapCover ? " has-image" : ""}${mapCover ? " has-map" : ""}`}>
        {mapCover
          ? <GalleryMiniMap lat={chapter.placeLat!} lng={chapter.placeLng!} zoom={12} title={chapter.place ?? label} />
          : heroUrl && <img src={heroUrl} alt="" />}
        <div className="story-chapter-hero-text">
          <p className="story-chapter-meta">
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

      {chapter.description && <p className="story-chapter-description">{chapter.description}</p>}

      <div className="story-blocks">
        {chapter.blocks.map((block, blockIndex) => (
          <div className="story-block-slot" key={blockIndex}>
            {block.heading && <h2 className="story-block-heading">{block.heading}</h2>}
            <ShareBlock block={block} onOpen={onOpen} />
          </div>
        ))}
      </div>

      {photos.length > 0 && (
        <section className="story-chapter-photos">
          <h2>
            {t("stories:site.photosFrom", { label })}
            <span className="story-chapter-photos-count"> · {t("stories:site.shotCount", { count: photos.length })}</span>
          </h2>
          <div className="story-chapter-photos-strip">
            {photos.map((asset) => (
              <button key={asset.id} type="button" onClick={() => onOpen(asset.id)}>
                <img src={asset.coverUrl} alt={asset.title} loading="lazy" />
              </button>
            ))}
          </div>
        </section>
      )}

      <nav className="story-chapter-nav">
        {prev ? (
          <button type="button" onClick={() => onGoTo(prev.id)}>
            <ChevronLeft size={16} aria-hidden="true" />
            <span>{shareChapterLabel(story, prev, index - 1)}</span>
          </button>
        ) : <span />}
        {next ? (
          <button type="button" onClick={() => onGoTo(next.id)}>
            <span>{shareChapterLabel(story, next, index + 1)}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ) : <span />}
      </nav>
    </article>
  );
}

function ChapterSection({
  chapter,
  showHeader,
  onOpen
}: {
  chapter: StoryShareChapter;
  showHeader: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const dateText = chapter.date
    ? (chapter.endDate ? formatPartialDateRange(chapter.date, chapter.endDate) : formatPartialDate(chapter.date))
    : "";
  const dateLabel = dateText && chapter.dateApprox ? t("stories:chapter.approx", { date: dateText }) : dateText;

  return (
    <section className="story-chapter">
      {showHeader && (
        <header className="story-chapter-head">
          {(dateLabel || chapter.place) && (
            <p className="story-chapter-meta">
              {dateLabel}
              {dateLabel && chapter.place && <span aria-hidden="true"> · </span>}
              {chapter.place && (
                <span className="story-chapter-place">
                  <MapPin size={13} aria-hidden="true" /> {chapter.place}
                </span>
              )}
            </p>
          )}
          {chapter.title && <h2>{chapter.title}</h2>}
          {chapter.description && <p className="story-chapter-description">{chapter.description}</p>}
        </header>
      )}
      <div className="story-blocks">
        {chapter.blocks.map((block, index) => (
          <ShareBlock key={index} block={block} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ShareBlock({ block, onOpen }: { block: StoryShareBlock; onOpen: (id: string) => void }) {
  const { t } = useTranslation(["common", "stories"]);

  if (block.kind === "text") {
    return <div className="story-block story-block-text"><StoryMarkdown source={block.body} /></div>;
  }

  if (block.kind === "media") {
    const { asset } = block;
    return (
      <figure className={`story-block story-block-media${block.layout === "wide" ? " is-wide" : ""}`}>
        {asset.kind === "video" ? (
          <video src={asset.fileUrl} poster={asset.previewUrl} controls preload="metadata" />
        ) : (
          <button type="button" className="story-media-button" onClick={() => onOpen(asset.id)}>
            <img src={asset.previewUrl} alt={asset.title} loading="lazy" />
          </button>
        )}
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    );
  }

  if (block.kind === "map") {
    return (
      <figure className="story-block story-block-map">
        <GalleryMiniMap
          lat={block.lat}
          lng={block.lng}
          zoom={block.zoom ?? 12}
          title={block.label ?? t("stories:block.mapFallbackTitle")}
          className="story-map"
        />
        <figcaption>
          <MapPin size={14} aria-hidden="true" />
          <span>{block.label ?? block.caption ?? t("stories:block.mapFallbackTitle")}</span>
        </figcaption>
      </figure>
    );
  }

  if (block.kind === "album" || block.kind === "slideshow") {
    const hidden = block.itemCount - block.items.length;
    return (
      <section className="story-block story-block-set">
        <header className="story-set-head">
          <span className="story-set-icon" aria-hidden="true">
            {block.kind === "slideshow" ? <Play size={16} /> : <Images size={16} />}
          </span>
          <div className="story-set-copy">
            <strong>{block.title}</strong>
            <small>
              {block.kind === "slideshow" ? t("stories:block.slideshowLabel") : t("stories:block.albumLabel")}
              {block.itemCount > 0 && ` · ${t("stories:count.photos", { count: block.itemCount })}`}
            </small>
          </div>
        </header>
        <div className="story-set-strip">
          {block.items.map((asset) => (
            <button type="button" key={asset.id} className="story-set-thumb" onClick={() => onOpen(asset.id)}>
              <img src={asset.coverUrl} alt="" loading="lazy" />
            </button>
          ))}
          {/* Honest about the ones this link doesn't open, rather than pretending
              the album is only this big. */}
          {hidden > 0 && <span className="story-set-more">+{hidden}</span>}
        </div>
        {block.caption && <p className="story-set-caption">{block.caption}</p>}
      </section>
    );
  }

  if (block.kind === "audio") {
    return (
      <figure className="story-block story-block-audio">
        <span className="story-audio-icon" aria-hidden="true"><Mic size={16} /></span>
        <div className="story-audio-body">
          <strong>{block.title ?? t("stories:audio.defaultTitle")}</strong>
          <audio src={block.url} controls preload="none" />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </div>
      </figure>
    );
  }

  if (block.kind === "person") {
    const years = [block.birthDate, block.deathDate].filter(Boolean).join(" – ");
    return (
      <aside className="story-block story-block-person">
        <span className="story-person-portrait" aria-hidden="true"><UserRound size={22} /></span>
        <div className="story-person-copy">
          <strong>{block.name}</strong>
          {years && <small>{years}</small>}
          {block.caption && <p>{block.caption}</p>}
        </div>
      </aside>
    );
  }

  // A book card for a guest: text only — no cover route through the token,
  // and no in-app link a guest could follow.
  if (block.kind === "book") {
    return (
      <aside className="story-block story-block-person story-block-book">
        <span className="story-person-portrait story-book-cover" aria-hidden="true">
          {block.bookType === "audiobook" ? <Headphones size={22} /> : <BookOpen size={22} />}
        </span>
        <div className="story-person-copy">
          <strong>{block.title}</strong>
          {block.author && <small>{block.author}</small>}
          <small className="muted">
            {block.bookType === "audiobook" ? t("stories:block.audiobookLabel") : t("stories:block.ebookLabel")}
          </small>
          {block.caption && <p>{block.caption}</p>}
        </div>
      </aside>
    );
  }

  if (block.kind === "quote") {
    return (
      <figure className="story-block story-block-quote">
        <Quote size={18} aria-hidden="true" className="story-quote-mark" />
        <blockquote>{block.text}</blockquote>
        {(block.attribution || block.caption) && (
          <figcaption>
            {block.attribution}
            {block.attribution && block.caption && <span aria-hidden="true"> · </span>}
            {block.caption}
          </figcaption>
        )}
      </figure>
    );
  }

  // A kind this build doesn't know how to draw is skipped rather than guessed
  // at — an old link should never render a broken frame.
  return null;
}
