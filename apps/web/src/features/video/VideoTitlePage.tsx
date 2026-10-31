import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Film, Layers, Play, Search, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { useSession } from "../../app/SessionContext";
import { followBack, followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
// A date the .nfo gives without a time: read as a calendar date, so it never rolls back west of Greenwich.
import { formatDate } from "../../shared/dates";
import { FixMatchModal } from "./FixMatchModal";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, episodeCodeValues, formatPlayTime, progressFraction, videoHref, videoSetHref, watchHref, type VideoKind, type VideoMovie, type VideoShow } from "./types";
import "../../styles/video.css";

// One show — its seasons and episodes — or one movie, as the video engine
// catalogued it (.nfo files first, then the folder's own name, TMDB filling the
// gaps), with Play — resumed where this person stopped — and each episode's
// progress. An admin can fix which TMDB title it was matched to.
export function VideoTitlePage({ kind, id }: { kind: VideoKind; id: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<VideoShow | VideoMovie | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [fixing, setFixing] = useState(false);
  const { user } = useSession();
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
        title.rating ? t("video.rating", { rating: title.rating.toFixed(1) }) : null,
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
            {title.backdrop && (
              <div className="video-title-backdrop" aria-hidden="true">
                <img src={title.backdrop} alt="" />
              </div>
            )}
            <header className="video-title-head">
              <div className={`video-title-cover${title.poster ? " has-poster" : ""}`} aria-hidden="true">
                {title.poster ? <img src={title.poster} alt="" /> : <KindIcon size={34} />}
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
                {user.role === "admin" && (
                  <Button variant="text" className="video-fix-match" onClick={() => setFixing(true)}>
                    <Search size={15} aria-hidden="true" />
                    <span>{t("video.match.open")}</span>
                  </Button>
                )}
              </div>
            </header>
            {fixing && <FixMatchModal kind={kind} title={title} onClose={() => setFixing(false)} onMatched={setTitle} />}

            <PlayAction title={title} />

            {title.plot && <p className="video-plot">{title.plot}</p>}

            {!show && (title as VideoMovie).set && <SetStrip movieId={title.id} set={(title as VideoMovie).set!} />}

            {show && (
              show.seasons.length === 0 ? (
                <p className="muted">{t("video.noEpisodes")}</p>
              ) : (
                show.seasons.map((season) => (
                  <section className="video-season" key={season.number} aria-labelledby={`season-${season.number}`}>
                    <h2 id={`season-${season.number}`}>{season.number === 0 ? t("video.specials") : t("video.season", { number: season.number })}</h2>
                    <ol className="video-episodes">
                      {season.episodes.map((episode) => {
                        const name = episode.title ?? t("video.episode", { number: episode.episode });
                        const fraction = progressFraction(episode.progress);
                        const href = watchHref(episode.id);
                        return (
                          <li key={episode.id} className={`video-episode${episode.progress?.watched ? " is-watched" : ""}`}>
                            <a
                              className="video-episode-play"
                              href={href}
                              onClick={(event) => followRoute(event, href)}
                              aria-label={t("video.playEpisode", { name })}
                            >
                              {episode.still && (
                                <span className="video-episode-still">
                                  <img src={episode.still} alt="" loading="lazy" />
                                </span>
                              )}
                              <span className="video-episode-number">{episode.episode}</span>
                              <Play size={16} aria-hidden="true" />
                            </a>
                            <div className="video-episode-copy">
                              <strong>
                                {name}
                                {episode.progress?.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />}
                              </strong>
                              {episode.aired && <small className="muted">{t("video.aired", { date: formatDate(episode.aired, "medium", { utc: true }) })}</small>}
                              {episode.plot && <p>{episode.plot}</p>}
                              {fraction > 0 && fraction < 1 && <ProgressBar fraction={fraction} />}
                            </div>
                          </li>
                        );
                      })}
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

/** Play on a title: the movie, or the show's next episode — resumed where this
 *  person stopped. Nothing to play once every episode is watched. */
function PlayAction({ title }: { title: VideoShow | VideoMovie }) {
  const { t } = useTranslation();
  let id: string;
  let position: number;
  let label: string;
  if ("seasons" in title) {
    const next = title.nextUp;
    if (!next) {
      const total = title.seasons.reduce((sum, season) => sum + season.episodes.length, 0);
      return total > 0 ? <p className="muted video-play-note">{t("video.allWatched")}</p> : null;
    }
    id = next.id;
    position = next.position;
    const code = t("video.episodeCode", episodeCodeValues(next.season!, next.episode!));
    label = position > 0 ? t("video.resumeEpisode", { code, time: formatPlayTime(position) }) : t("video.playEpisodeCode", { code });
  } else {
    id = title.id;
    const progress = title.progress;
    position = progress && !progress.watched && progress.position >= 30 ? progress.position : 0;
    label = position > 0 ? t("video.resumeAt", { time: formatPlayTime(position) }) : t("video.play");
  }
  const href = watchHref(id);
  const fraction = "seasons" in title ? 0 : progressFraction(title.progress);
  return (
    <div className="video-play-action">
      {/* A link, so it opens in a new tab like any address; it wears Button's primary look. */}
      <a className="primary-button video-play-button" href={href} onClick={(event) => followRoute(event, href)}>
        <Play size={18} aria-hidden="true" />
        <span>{label}</span>
      </a>
      {fraction > 0 && fraction < 1 && <ProgressBar fraction={fraction} />}
    </div>
  );
}

/** "Part of The Matrix set": the set's name, linking to it, over its films in
 *  order, this one marked. */
function SetStrip({ movieId, set }: { movieId: string; set: NonNullable<VideoMovie["set"]> }) {
  const { t } = useTranslation();
  const setHref = videoSetHref(set.id);
  return (
    <section className="video-set-strip" aria-labelledby="video-set-strip-title">
      <h2 id="video-set-strip-title">
        <Layers size={17} aria-hidden="true" />
        <a href={setHref} onClick={(event) => followRoute(event, setHref)}>{t("video.set.partOf", { name: set.name })}</a>
      </h2>
      {set.films.length > 1 && (
        <ol>
          {set.films.map((film) => {
            const current = film.id === movieId;
            const href = videoHref("movies", film.id);
            const cover = film.poster ? <img src={film.poster} alt="" loading="lazy" /> : <Film size={20} aria-hidden="true" />;
            return (
              <li key={film.id} className={current ? "is-current" : undefined}>
                {current ? (
                  <span aria-current="page" title={t("video.set.current")}>
                    <span className="video-set-strip-cover">{cover}</span>
                    <small>{film.title}</small>
                  </span>
                ) : (
                  <a href={href} onClick={(event) => followRoute(event, href)}>
                    <span className="video-set-strip-cover">{cover}</span>
                    <small>{film.title}</small>
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <span className="video-progress" aria-hidden="true">
      <span style={{ width: `${Math.round(fraction * 100)}%` }} />
    </span>
  );
}
