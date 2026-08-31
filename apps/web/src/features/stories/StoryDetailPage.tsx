import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, MapPin, Pencil, Play, Send } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, goBack, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Button } from "../../shared/Button";
import { formatPartialDate, formatPartialDateRange } from "../../shared/utils";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { GalleryAsset } from "../gallery/types";
import type { SlideshowTransition } from "../gallery/types";
import { NotesSection } from "../social/NotesSection";
import { SendToSheet } from "../social/SendToSheet";
import { StoryBlockView } from "./StoryBlockView";
import { StoryPlayer } from "./StoryPlayer";
import { slidesFromStory, type PlayerSlide } from "./story-player";
import { chapterDateText, groupIntoRows } from "./story-layout";
import { hasChapterStructure, type StoryBlock, type StoryChapter, type StoryDetail } from "./types";

// The reading view: a story as one scrolling page. Presentation only — no
// library chrome, no selection, no editing affordances beyond the author's own
// "Edit" button.
export function StoryDetailPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [slides, setSlides] = useState<PlayerSlide[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [lightbox, setLightbox] = useState<
    { assets: GalleryAsset[]; index: number; autoPlay?: boolean; transition?: SlideshowTransition; interval?: number; transitionSeconds?: number; musicUrl?: string } | null
  >(null);

  useEffect(() => {
    setStory(null);
    setError("");
    api<{ story: StoryDetail }>(`/api/stories/${id}`)
      .then((payload) => {
        setStory(payload.story);
        document.title = `${payload.story.title} — isputnik.home`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  }, [id]);

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

  // Presentation mode. The reading view only holds a preview strip of each
  // album and slideshow, but a show should play them through — so their full
  // contents are fetched first, and the player is opened with the whole thing.
  const startPlayer = async () => {
    if (!story) return;
    setStarting(true);
    try {
      const expansions = new Map<string, GalleryAsset[]>();
      const sets = story.chapters
        .flatMap((chapter) => chapter.blocks)
        .filter((block) => block.available && block.entityId
          && (block.kind === "album" || block.kind === "slideshow"));

      await Promise.all(sets.map(async (block) => {
        const url = block.kind === "album"
          ? `/api/library/gallery/albums/${block.entityId}?limit=200`
          : `/api/library/gallery/slideshows/${block.entityId}?limit=200`;
        try {
          const payload = await api<{ assets: GalleryAsset[] }>(url);
          expansions.set(block.id, payload.assets);
        } catch {
          // One unreachable set shouldn't stop the show — it falls back to the
          // preview strip the page already has.
        }
      }));

      setSlides(slidesFromStory(story, expansions));
    } finally {
      setStarting(false);
    }
  };

  const structured = story ? hasChapterStructure(story) : false;
  const span = story
    ? formatPartialDateRange(
        story.chapters.find((chapter) => chapter.date)?.date ?? null,
        [...story.chapters].reverse().find((chapter) => chapter.endDate ?? chapter.date)?.endDate ?? null
      )
    : "";

  return (
    <DashboardShell active="stories" user={user} logout={logout}>
      <section className="work-area story-read-area">
        <div className="book-detail-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => goBack("/stories")}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("stories:backTo")}</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}
        {!story && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {story && (
          <article className="story-read">
            <header className="story-read-head">
              {story.status === "draft" && (
                <span className="story-draft-badge">{t("stories:status.draft")}</span>
              )}
              <h1>{story.title}</h1>
              {story.subtitle && <p className="story-read-subtitle">{story.subtitle}</p>}
              {span && <p className="story-read-span">{span}</p>}
              {story.tags.length > 0 && (
                <ul className="story-read-tags">
                  {story.tags.map((tag) => (
                    <li key={tag}>
                      {/* Straight into the cross-type tag browse: the photos,
                          people and other stories that share this tag. */}
                      <a
                        href={`/tags/${encodeURIComponent(tag)}`}
                        onClick={(event) => followRoute(event, `/tags/${encodeURIComponent(tag)}`)}
                      >
                        {tag}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <div className="story-read-actions">
                <Button variant="primary" compact onClick={() => void startPlayer()} disabled={starting}>
                  <Play size={15} aria-hidden="true" />
                  <span>{starting ? t("stories:player.starting") : t("stories:player.play")}</span>
                </Button>
                {story.canEdit && (
                  <Button variant="secondary" compact onClick={() => navigate(`/stories/${story.id}/edit`)}>
                    <Pencil size={15} aria-hidden="true" />
                    <span>{t("stories:actions.edit")}</span>
                  </Button>
                )}
                {/* Sending is how a story reaches one person before real story
                    shares land; a draft has nobody to send to yet. */}
                {story.status === "published" && (
                  <Button variant="secondary" compact onClick={() => setSending(true)}>
                    <Send size={15} aria-hidden="true" />
                    <span>{t("stories:actions.send")}</span>
                  </Button>
                )}
              </div>
            </header>

            {story.chapters.every((chapter) => chapter.blocks.length === 0) && (
              <MessageBox tone="info" title={t("stories:read.emptyTitle")}>
                {story.canEdit ? t("stories:read.emptyAuthor") : t("stories:read.emptyReader")}
              </MessageBox>
            )}

            {story.chapters.map((chapter) => (
              <ChapterSection
                key={chapter.id}
                chapter={chapter}
                showHeader={structured}
                onOpenMedia={openMedia}
                onPlaySlideshow={playSlideshow}
              />
            ))}

            {/* The family's reaction to the story belongs with the story, the
                way notes hang off a photo or a book. */}
            <NotesSection entityType="story" entityId={story.id} />
          </article>
        )}
      </section>

      {slides && slides.length > 0 && story && (
        <StoryPlayer slides={slides} title={story.title} onClose={() => setSlides(null)} />
      )}

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
    </DashboardShell>
  );
}

function ChapterSection({
  chapter,
  showHeader,
  onOpenMedia,
  onPlaySlideshow
}: {
  chapter: StoryChapter;
  showHeader: boolean;
  onOpenMedia: (assets: GalleryAsset[], index: number) => void;
  onPlaySlideshow: (block: StoryBlock) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const dateText = chapterDateText(chapter, formatPartialDate, formatPartialDateRange);
  const dateLabel = dateText && chapter.dateApprox
    ? t("stories:chapter.approx", { date: dateText })
    : dateText;

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
        {groupIntoRows(chapter.blocks).map((row) =>
          row.length === 1 ? (
            <StoryBlockView
              key={row[0].id}
              block={row[0]}
              onOpenMedia={onOpenMedia}
              onPlaySlideshow={onPlaySlideshow}
            />
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
        {chapter.blocks.length === 0 && showHeader && (
          <p className="muted story-chapter-empty">{t("stories:read.chapterEmpty")}</p>
        )}
      </div>
    </section>
  );
}
