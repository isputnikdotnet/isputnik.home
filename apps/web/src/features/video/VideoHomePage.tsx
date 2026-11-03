import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clapperboard, Film, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ContinueWatching } from "./ContinueWatching";
import { VideoBanner } from "./VideoBanner";
import { PosterRow, type PosterItem } from "./VideoPoster";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, videoHref, type VideoKind, type VideoMovieSummary, type VideoPage, type VideoShowSummary } from "./types";
import "../../styles/video.css";

/** About what a row can show before it has to scroll a long way. */
const ROW_SIZE = 30;

// Video's front page, the TV app's Home: the big banner, what you were watching,
// then what's newest in each kind.
export function VideoHomePage() {
  const { t } = useTranslation();
  const [movies, setMovies] = useState<VideoMovieSummary[] | null>(null);
  const [shows, setShows] = useState<VideoShowSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const newest = <T,>(kind: VideoKind) => api<VideoPage<T>>(`${VIDEO_API}/${kind}?sort=added&pageSize=${ROW_SIZE}`).then((page) => page.items);
    Promise.all([newest<VideoMovieSummary>("movies"), newest<VideoShowSummary>("shows")])
      .then(([nextMovies, nextShows]) => {
        if (!live) return;
        setMovies(nextMovies);
        setShows(nextShows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setMovies([]);
        setShows([]);
        setError(err instanceof Error ? err.message : t("video.loadFailed"));
      });
    return () => { live = false; };
  }, [t]);

  const toItem = (kind: VideoKind, item: VideoMovieSummary | VideoShowSummary): PosterItem => ({
    key: item.id,
    href: videoHref(kind, item.id),
    title: item.title,
    sub: item.year ? String(item.year) : null,
    poster: item.poster,
    icon: kind === "shows" ? Tv : Film
  });
  const viewAll = (href: string) => (
    <a className="video-row-more" href={href} onClick={(event) => followRoute(event, href)}>
      <span>{t("common.viewAll")}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </a>
  );
  const empty = movies !== null && shows !== null && movies.length === 0 && shows.length === 0 && !error;

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav activeKey="overview" />}>
      <section className="audiobook-main-page video-page">
        <h1 className="sr-only">{t("nav.video")}</h1>
        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}
        {empty ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{t("video.emptyTitle")}</h2>
            <p className="muted">{t("video.emptyBody")}</p>
          </div>
        ) : (
          <>
            <VideoBanner kinds={["movies", "shows"]} />
            <ContinueWatching />
            <PosterRow title={t("video.recentMovies")} items={(movies ?? []).map((item) => toItem("movies", item))} action={viewAll(videoHref("movies"))} />
            <PosterRow shape="box" title={t("video.recentShows")} items={(shows ?? []).map((item) => toItem("shows", item))} action={viewAll(videoHref("shows"))} />
          </>
        )}
      </section>
    </DashboardShell>
  );
}
