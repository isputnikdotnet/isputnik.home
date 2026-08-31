import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Images, MapPin, Play, Quote, UserRound } from "lucide-react";
import { StoryMarkdown } from "../features/stories/StoryMarkdown";
import { GalleryMiniMap } from "../features/gallery/GalleryMiniMap";
import { formatPartialDate, formatPartialDateRange } from "../shared/utils";

// The public face of a shared story. Deliberately NOT the signed-in reading
// view: a guest has no session, so nothing here links back into the app, media
// comes only from token-scoped URLs, and an album shows exactly the photos the
// link chose to expose.
//
// The layout classes are the reading view's (styles/stories.css), so a story
// looks the same to a guest as it does to the family.

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

export type StoryShareBlock =
  | { kind: "text"; body: string }
  | { kind: "media"; caption: string | null; layout: string | null; asset: StoryShareAsset }
  | { kind: "album" | "slideshow"; title: string | null; caption: string | null; itemCount: number; items: StoryShareAsset[] }
  | { kind: "map"; lat: number; lng: number; zoom: number | null; label: string | null; caption: string | null }
  | { kind: "person"; name: string; birthDate: string | null; deathDate: string | null; caption: string | null }
  | { kind: "quote"; text: string; attribution: string | null; caption: string | null };

export interface StoryShareChapter {
  title: string | null;
  date: string | null;
  endDate: string | null;
  dateApprox: boolean;
  place: string | null;
  description: string | null;
  blocks: StoryShareBlock[];
}

export interface StorySharePayload {
  type: "story";
  share: { label: string | null; expiresAt: string; sharedBy: string | null };
  story: {
    title: string;
    subtitle: string | null;
    expandAlbums: boolean;
    chapters: StoryShareChapter[];
  };
}

export function StoryShareView({ token, payload }: { token: string; payload: StorySharePayload }) {
  const { t } = useTranslation(["common", "user", "stories"]);
  const { story, share } = payload;

  // One flat list of every photo the page shows, so the viewer can step through
  // the whole story rather than being trapped inside one block.
  const gallery: StoryShareAsset[] = story.chapters.flatMap((chapter) =>
    chapter.blocks.flatMap((block) =>
      block.kind === "media" ? [block.asset] : block.kind === "album" || block.kind === "slideshow" ? block.items : []
    )
  );
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

  return (
    <div className="share-page">
      <div className="share-card share-card--story">
        <article className="story-read">
          <header className="story-read-head">
            <h1>{story.title}</h1>
            {story.subtitle && <p className="story-read-subtitle">{story.subtitle}</p>}
            {share.sharedBy && (
              <p className="share-shared-by">{t("user:sharePage.sharedBy", { name: share.sharedBy })}</p>
            )}
            {gallery.length > 0 && (
              <div className="story-read-actions">
                <a className="secondary-button compact-button" href={`/api/share/${token}/download-all`} download>
                  <Download size={15} aria-hidden="true" />
                  <span>{t("user:sharePage.downloadAll")}</span>
                </a>
              </div>
            )}
          </header>

          {story.chapters.every((chapter) => chapter.blocks.length === 0) && (
            <p className="muted">{t("stories:read.emptyReader")}</p>
          )}

          {story.chapters.map((chapter, index) => (
            <ChapterSection
              key={index}
              chapter={chapter}
              showHeader={hasStructure}
              onOpen={setOpenId}
            />
          ))}
        </article>
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
