import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, FolderPlus, Layers, Pencil, Play } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { useSession } from "../../app/SessionContext";
import { followBack, followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
// A date the .nfo gives without a time: read as a calendar date, so it never rolls back west of Greenwich.
import { formatDate } from "../../shared/dates";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditTitleModal } from "./EditTitleModal";
import { MyListButton } from "./VideoMyList";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, VIDEO_ENTITY_TYPE, episodeCodeValues, formatPlayTime, progressFraction, videoBrowseHref, videoHref, videoSetHref, watchHref, type VideoEpisode, type VideoKind, type VideoMovie, type VideoShow } from "./types";
import "../../styles/video.css";
import { DEFAULT_COVERS } from "../audiobooks/covers";

// One show — its seasons and episodes — or one movie, as the video engine
// catalogued it (.nfo files first, then the folder's own name, TMDB filling the
// gaps), laid out as on the TV: the title over its backdrop, Play — resumed where
// this person stopped — and the season's episodes as picture cards, with each
// one's progress. An admin edits its details, genres, TMDB match and pictures.
export function VideoTitlePage({ kind, id }: { kind: VideoKind; id: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<VideoShow | VideoMovie | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const { user } = useSession();
  const back = videoBrowseHref(kind);
  /** What Collections calls a film or a show. */
  const collectAs = VIDEO_ENTITY_TYPE[kind];

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
  const facts = title
    ? [
        title.year ? String(title.year) : null,
        title.rating ? t("video.rating", { rating: title.rating.toFixed(1) }) : null,
        show ? t("video.seasons", { count: show.seasons.length }) : null,
        show ? t("video.episodes", { count: show.seasons.reduce((sum, season) => sum + season.episodes.length, 0) }) : null,
        !show && (title as VideoMovie).runtimeMinutes ? t("video.minutes", { count: (title as VideoMovie).runtimeMinutes! }) : null,
        title.genres.slice(0, 3).join(", ") || null
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav />}>
      <section className="audiobook-main-page video-page video-title-page">
        {title?.backdrop && (
          <div className="video-title-backdrop" aria-hidden="true">
            <img src={title.backdrop} alt="" />
          </div>
        )}
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
                <img src={title.poster ?? DEFAULT_COVERS[kind === "shows" ? "show" : "movie"]} alt="" />
              </div>
              <div className="video-title-copy">
                <h1>{title.title}</h1>
                {title.originalTitle && title.originalTitle !== title.title && <p className="muted">{title.originalTitle}</p>}
                {facts && <p className="video-title-facts">{facts}</p>}
                {title.plot && <p className="video-plot">{title.plot}</p>}
                <div className="video-title-actions">
                  <PlayAction title={title} />
                  <MyListButton kind={kind} id={title.id} />
                  <Button variant="text" onClick={() => setCollecting(true)}>
                    <FolderPlus size={15} aria-hidden="true" />
                    <span>{t("video.addToCollection")}</span>
                  </Button>
                  {user.role === "admin" && (
                    <Button variant="text" className="video-fix-match" onClick={() => setEditing(true)}>
                      <Pencil size={15} aria-hidden="true" />
                      <span>{t("video.edit.open")}</span>
                    </Button>
                  )}
                </div>
              </div>
            </header>
            {editing && <EditTitleModal kind={kind} title={title} onClose={() => setEditing(false)} onSaved={setTitle} />}
            {collecting && (
              <AddToCollectionModal entityType={collectAs} entityId={title.id} title={title.title} onClose={() => setCollecting(false)} />
            )}

            {!show && ((title as VideoMovie).parts?.length ?? 0) > 0 && <PartList parts={(title as VideoMovie).parts!} />}

            {!show && (title as VideoMovie).set && <SetStrip movieId={title.id} set={(title as VideoMovie).set!} />}

            {show && (show.seasons.length === 0 ? <p className="muted">{t("video.noEpisodes")}</p> : <Seasons show={show} />)}
          </>
        )}
      </section>
    </DashboardShell>
  );
}

const seasonName = (number: number, t: (key: "video.specials" | "video.season", options?: { number: number }) => string) =>
  (number === 0 ? t("video.specials") : t("video.season", { number }));

/** One season at a time, opening on the one this person is up to, as on the TV. */
function Seasons({ show }: { show: VideoShow }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<number | null>(null);
  const number = chosen ?? show.nextUp?.season ?? show.seasons[0].number;
  const current = show.seasons.find((season) => season.number === number) ?? show.seasons[0];
  const several = show.seasons.length > 1;
  return (
    <section className="video-season" aria-labelledby={`season-${current.number}`}>
      {several && (
        <div className="video-season-tabs" role="tablist" aria-label={t("video.seasonsAria")}>
          {show.seasons.map((season) => (
            <Button variant="tab" key={season.number} selected={season.number === current.number} onClick={() => setChosen(season.number)}>
              {seasonName(season.number, t)}
            </Button>
          ))}
        </div>
      )}
      <h2 id={`season-${current.number}`} className={several ? "sr-only" : undefined}>{seasonName(current.number, t)}</h2>
      <ol className="video-episodes">
        {current.episodes.map((episode) => <EpisodeCard key={episode.id} season={current.number} episode={episode} />)}
      </ol>
    </section>
  );
}

function EpisodeCard({ season, episode }: { season: number; episode: VideoEpisode }) {
  const { t } = useTranslation();
  const name = episode.title ?? t("video.episode", { number: episode.episode });
  const fraction = progressFraction(episode.progress);
  const href = watchHref(episode.id);
  return (
    <li className={`video-episode${episode.progress?.watched ? " is-watched" : ""}`}>
      <a className="video-episode-play" href={href} onClick={(event) => followRoute(event, href)} aria-label={t("video.playEpisode", { name })}>
        {episode.still ? <img src={episode.still} alt="" loading="lazy" /> : <span className="video-episode-number">{episode.episode}</span>}
        <Play className="video-episode-icon" size={30} fill="currentColor" aria-hidden="true" />
        {fraction > 0 && fraction < 1 && (
          <span className="video-card-progress" aria-hidden="true"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
        )}
      </a>
      <div className="video-episode-copy">
        <strong>
          {name}
          {episode.progress?.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />}
        </strong>
        <small className="muted">
          {[
            t("video.episodeCode", episodeCodeValues(season, episode.episode)),
            episode.aired ? t("video.aired", { date: formatDate(episode.aired, "medium", { utc: true }) }) : null
          ].filter(Boolean).join(" · ")}
        </small>
        {episode.plot && <p>{episode.plot}</p>}
      </div>
    </li>
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
    id = title.playId ?? title.id;
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
        <Play size={18} fill="currentColor" aria-hidden="true" />
        <span>{label}</span>
      </a>
      {fraction > 0 && fraction < 1 && <ProgressBar fraction={fraction} />}
    </div>
  );
}

/** A film in several files: each part, with how far this person got in it. Looks
 *  like a season's episodes, because it behaves like them — and a miniseries
 *  matched on TMDB as a show has its episodes' names, stills and descriptions. */
function PartList({ parts }: { parts: NonNullable<VideoMovie["parts"]> }) {
  const { t } = useTranslation();
  return (
    <section className="video-season" aria-labelledby="video-parts-title">
      <h2 id="video-parts-title">{t("video.parts")}</h2>
      <ol className="video-episodes">
        {parts.map((part) => {
          const name = part.title ?? t("video.part", { number: part.part });
          const fraction = progressFraction(part.progress);
          const href = watchHref(part.id);
          return (
            <li key={part.id} className={`video-episode${part.progress?.watched ? " is-watched" : ""}`}>
              <a className="video-episode-play" href={href} onClick={(event) => followRoute(event, href)} aria-label={t("video.playEpisode", { name })}>
                {part.still ? <img src={part.still} alt="" loading="lazy" /> : <span className="video-episode-number">{part.part}</span>}
                <Play className="video-episode-icon" size={30} fill="currentColor" aria-hidden="true" />
                {fraction > 0 && fraction < 1 && (
                  <span className="video-card-progress" aria-hidden="true"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
                )}
              </a>
              <div className="video-episode-copy">
                <strong>
                  {name}
                  {part.progress?.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />}
                </strong>
                {part.title && (
                  <small className="muted">
                    {[
                      t("video.part", { number: part.part }),
                      part.aired ? t("video.aired", { date: formatDate(part.aired, "medium", { utc: true }) }) : null
                    ].filter(Boolean).join(" · ")}
                  </small>
                )}
                {part.plot && <p>{part.plot}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
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
            const cover = <img src={film.poster ?? DEFAULT_COVERS.movie} alt="" loading="lazy" />;
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
