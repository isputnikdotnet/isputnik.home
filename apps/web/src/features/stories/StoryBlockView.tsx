import { useTranslation } from "react-i18next";
import { AlertTriangle, Images, MapPin, Mic, Play, Quote, UserRound } from "lucide-react";
import { GalleryMiniMap } from "../gallery/GalleryMiniMap";
import { MessageBox } from "../../shared/MessageBox";
import { followRoute } from "../../router";
import type { GalleryAsset } from "../gallery/types";
import { StoryMarkdown } from "./StoryMarkdown";
import type { StoryBlock } from "./types";

// One block, rendered read-only. The reading view uses it directly; the editor
// wraps the same component in its controls, so what an author arranges is
// literally what a reader gets.
export function StoryBlockView({
  block,
  onOpenMedia,
  onPlaySlideshow
}: {
  block: StoryBlock;
  /** Open the lightbox over a set (a media block, or an album's preview strip). */
  onOpenMedia: (assets: GalleryAsset[], index: number) => void;
  /** Fetch the slideshow's full item list and start it playing. */
  onPlaySlideshow: (block: StoryBlock) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);

  // A reference whose target was deleted, or that this viewer can't reach. The
  // block stays — silently dropping it would leave a hole in the narrative the
  // author never made.
  if (!block.available) {
    return (
      <div className="story-block story-block-unavailable">
        <MessageBox tone="info" title={t("stories:block.unavailableTitle")}>
          {t(`stories:block.unavailable.${block.kind}`)}
        </MessageBox>
      </div>
    );
  }

  if (block.kind === "text") {
    return (
      <div className="story-block story-block-text">
        <StoryMarkdown source={block.body ?? ""} />
      </div>
    );
  }

  if (block.kind === "media" && block.asset) {
    const asset = block.asset;
    return (
      <figure className={`story-block story-block-media${block.layout === "wide" ? " is-wide" : ""}`}>
        {asset.kind === "video" ? (
          <video src={asset.playbackUrl} poster={asset.previewUrl ?? undefined} controls preload="metadata" />
        ) : (
          <button
            type="button"
            className="story-media-button"
            onClick={() => onOpenMedia([asset], 0)}
            aria-label={t("stories:block.openPhoto", { title: asset.title })}
          >
            <img src={asset.previewUrl ?? asset.coverUrl ?? ""} alt={asset.title} loading="lazy" />
          </button>
        )}
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    );
  }

  if (block.kind === "map" && block.lat != null && block.lng != null) {
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

  // Someone in the family tree, as a card in the flow of the story — the
  // bridge between "who this is about" and the tree that knows them.
  if (block.kind === "person") {
    return (
      <aside className="story-block story-block-person">
        <span className="story-person-portrait" aria-hidden="true">
          {block.coverUrl ? <img src={block.coverUrl} alt="" loading="lazy" /> : <UserRound size={22} />}
        </span>
        <div className="story-person-copy">
          <strong>{block.title}</strong>
          {block.subtitle && <small>{block.subtitle}</small>}
          {block.caption && <p>{block.caption}</p>}
        </div>
        {block.href && (
          <a
            className="secondary-button compact-button"
            href={block.href}
            onClick={(event) => followRoute(event, block.href!)}
          >
            {t("stories:block.openPerson")}
          </a>
        )}
      </aside>
    );
  }

  if (block.kind === "quote") {
    return (
      <figure className="story-block story-block-quote">
        <Quote size={18} aria-hidden="true" className="story-quote-mark" />
        <blockquote>{block.title}</blockquote>
        {(block.subtitle || block.caption) && (
          <figcaption>
            {block.subtitle}
            {block.subtitle && block.caption && <span aria-hidden="true"> · </span>}
            {block.caption}
          </figcaption>
        )}
      </figure>
    );
  }

  // Narration: someone telling this part. Native controls, because a voice
  // clip wants scrubbing and speed from the browser it is played in.
  if (block.kind === "audio" && block.audio) {
    return (
      <figure className="story-block story-block-audio">
        <span className="story-audio-icon" aria-hidden="true"><Mic size={16} /></span>
        <div className="story-audio-body">
          <strong>{block.audio.title ?? t("stories:audio.defaultTitle")}</strong>
          <audio src={block.audio.url} controls preload="none" />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </div>
      </figure>
    );
  }

  if (block.kind === "album" || block.kind === "slideshow") {
    const isSlideshow = block.kind === "slideshow";
    return (
      <section className="story-block story-block-set">
        <header className="story-set-head">
          <span className="story-set-icon" aria-hidden="true">
            {isSlideshow ? <Play size={16} /> : <Images size={16} />}
          </span>
          <div className="story-set-copy">
            <strong>{block.title}</strong>
            <small>
              {isSlideshow ? t("stories:block.slideshowLabel") : t("stories:block.albumLabel")}
              {block.itemCount > 0 && ` · ${t("stories:count.photos", { count: block.itemCount })}`}
            </small>
          </div>
          <div className="story-set-actions">
            {isSlideshow && (
              <button type="button" className="primary-button compact-button" onClick={() => onPlaySlideshow(block)}>
                <Play size={15} aria-hidden="true" />
                <span>{t("stories:block.play")}</span>
              </button>
            )}
            {block.href && (
              <a
                className="secondary-button compact-button"
                href={block.href}
                onClick={(event) => followRoute(event, block.href!)}
              >
                {isSlideshow ? t("stories:block.openSlideshow") : t("stories:block.openAlbum")}
              </a>
            )}
          </div>
        </header>

        {block.preview.length > 0 && (
          <div className="story-set-strip">
            {block.preview.map((asset, index) => (
              <button
                type="button"
                key={asset.id}
                className="story-set-thumb"
                onClick={() => onOpenMedia(block.preview, index)}
                aria-label={t("stories:block.openPhoto", { title: asset.title })}
              >
                <img src={asset.coverUrl ?? ""} alt="" loading="lazy" />
              </button>
            ))}
            {block.itemCount > block.preview.length && (
              <span className="story-set-more">
                +{block.itemCount - block.preview.length}
              </span>
            )}
          </div>
        )}

        {block.caption && <p className="story-set-caption">{block.caption}</p>}
      </section>
    );
  }

  // A media block whose asset didn't resolve (deleted between list and read) —
  // available said yes, the photo says no. Rare, but never render nothing.
  return (
    <div className="story-block story-block-unavailable">
      <MessageBox tone="info" title={t("stories:block.unavailableTitle")}>
        <AlertTriangle size={14} aria-hidden="true" /> {t("stories:block.unavailable.media")}
      </MessageBox>
    </div>
  );
}
