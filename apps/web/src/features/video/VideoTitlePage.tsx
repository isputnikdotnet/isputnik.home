import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Film, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followBack } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
// A date the .nfo gives without a time: read as a calendar date, so it never rolls back west of Greenwich.
import { formatDate } from "../../shared/dates";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, videoHref, type VideoKind, type VideoMovie, type VideoShow } from "./types";
import "../../styles/video.css";

// One show — its seasons and episodes — or one movie, as the video engine
// catalogued it (.nfo files first, then the folder's own name). Playing comes
// with V2 (docs/apps-platform-plan.md).
export function VideoTitlePage({ kind, id }: { kind: VideoKind; id: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<VideoShow | VideoMovie | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const back = videoHref(kind);

  useEffect(() => {
    let live = true;
    setTitle(null);
    setMissing(false);
    api<VideoShow | VideoMovie>(`${VIDEO_API}/${kind}/${encodeURIComponent(id)}`)
      .then((payload) => { if (live) { setTitle(payload); setError(""); } })
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : t("video.loadFailed");
        // The engine answers 404 for a title that is gone or in a library this person may not see.
        if (/not found|no such/i.test(message)) setMissing(true);
        else setError(message);
      });
    return () => { live = false; };
  }, [kind, id, t]);

  const show = title && "seasons" in title ? title : null;
  const KindIcon = kind === "shows" ? Tv : Film;
  const facts = title
    ? [
        title.year ? String(title.year) : null,
        show ? t("video.seasons", { count: show.seasons.length }) : null,
        show ? t("video.episodes", { count: show.seasons.reduce((sum, season) => sum + season.episodes.length, 0) }) : null,
        !show && (title as VideoMovie).runtimeMinutes ? t("video.minutes", { count: (title as VideoMovie).runtimeMinutes! }) : null
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav activeKey={kind} />}>
      <section className="audiobook-main-page video-title-page">
        <div className="book-detail-topbar">
          <a className="audiobook-back-button" href={back} onClick={(event) => followBack(event, back)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{kind === "shows" ? t("video.shows") : t("video.movies")}</span>
          </a>
        </div>

        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}
        {missing && <MessageBox tone="info" title={t("video.loadFailed")}>{t("video.notFound")}</MessageBox>}

        {title && (
          <>
            <header className="video-title-head">
              <div className="video-title-cover" aria-hidden="true">
                <KindIcon size={34} />
              </div>
              <div className="video-title-copy">
                <h1>{title.title}</h1>
                {title.originalTitle && title.originalTitle !== title.title && <p className="muted">{title.originalTitle}</p>}
                {facts && <p className="video-title-facts">{facts}</p>}
                {title.genres.length > 0 && (
                  <ul className="video-genres" aria-label={t("video.genres")}>
                    {title.genres.map((genre) => <li key={genre}>{genre}</li>)}
                  </ul>
                )}
              </div>
            </header>

            {title.plot && <p className="video-plot">{title.plot}</p>}
            <p className="muted video-play-soon">{t("video.playSoon")}</p>

            {show && (
              show.seasons.length === 0 ? (
                <p className="muted">{t("video.noEpisodes")}</p>
              ) : (
                show.seasons.map((season) => (
                  <section className="video-season" key={season.number} aria-labelledby={`season-${season.number}`}>
                    <h2 id={`season-${season.number}`}>{season.number === 0 ? t("video.specials") : t("video.season", { number: season.number })}</h2>
                    <ol className="video-episodes">
                      {season.episodes.map((episode) => (
                        <li key={episode.id} className="video-episode">
                          <span className="video-episode-number">{episode.episode}</span>
                          <div className="video-episode-copy">
                            <strong>{episode.title ?? t("video.episode", { number: episode.episode })}</strong>
                            {episode.aired && <small className="muted">{t("video.aired", { date: formatDate(episode.aired, "medium", { utc: true }) })}</small>}
                            {episode.plot && <p>{episode.plot}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))
              )
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
