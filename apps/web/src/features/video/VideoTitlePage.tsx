import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Check, CheckCheck, FolderPlus, HardDrive, Layers, Pencil, Pin, Play, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { useSession } from "../../app/SessionContext";
import { followBack, followRoute, navigate } from "../../router";
import { ActionMenu, type ActionMenuItem } from "../../shared/ActionMenu";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
// A date the .nfo gives without a time: read as a calendar date, so it never rolls back west of Greenwich.
import { formatDate } from "../../shared/dates";
import { AddToCollectionModal } from "../collections/AddToCollectionModal";
import { EditTitleModal } from "./EditTitleModal";
import { KeepReadyModal } from "./KeepReadyModal";
import { VideoDownloadButton, movieDownloadTarget, useVideoDownloadControl, type VideoDownloadTarget } from "./VideoDownloads";
import { MyListButton } from "./VideoMyList";
import { CastRow, CrewLine } from "./VideoPeople";
import { VideoSectionNav } from "./VideoSectionNav";
import { inProgress, knownDuration, markAllWatched, markWatched } from "./watched";
import { VIDEO_API, VIDEO_ENTITY_TYPE, episodeCodeValues, formatPlayTime, progressFraction, videoBrowseHref, videoHref, videoSetHref, watchHref, type VideoEpisode, type VideoKind, type VideoMovie, type VideoProgress, type VideoShow } from "./types";
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
  /** An admin's Keep ready dialog: the whole title, or one season of a show. */
  const [keeping, setKeeping] = useState<{ season?: number; name: string } | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [markError, setMarkError] = useState("");
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

  /** Marks films, episodes or parts watched (or not) in the order given, then reads
   *  the title again: what Play starts and every bar follow from the engine. */
  const mark: MarkWatched = useCallback(async (targets, watched) => {
    setMarkError("");
    try {
      for (const target of targets) await markWatched(target.id, watched, knownDuration(target.progress, target.runtimeMinutes));
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
    await api<VideoShow | VideoMovie>(`${VIDEO_API}/${kind}/${encodeURIComponent(id)}`).then(setTitle, () => undefined);
  }, [kind, id, t]);

  /** The whole show, or one season of it, in one call; then the title again. */
  const markAll: MarkAll = useCallback(async (watched, season) => {
    setMarkError("");
    try {
      await markAllWatched(kind, id, watched, season);
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
    await api<VideoShow | VideoMovie>(`${VIDEO_API}/${kind}/${encodeURIComponent(id)}`).then(setTitle, () => undefined);
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
        {markError && <MessageBox tone="error" title={t("video.mark.failedTitle")}>{markError}</MessageBox>}

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
                {title.crew && <CrewLine crew={title.crew} />}
                <div className="video-title-actions">
                  <PlayAction title={title} />
                  <MyListButton kind={kind} id={title.id} />
                  {!show && <VideoDownloadButton target={movieDownloadTarget(title as VideoMovie, t)} />}
                  <TitleMore
                    title={title}
                    mark={mark}
                    markAll={markAll}
                    onCollect={() => setCollecting(true)}
                    onEdit={user.role === "admin" ? () => setEditing(true) : null}
                    onKeepReady={user.role === "admin" ? () => setKeeping({ name: title.title }) : null}
                  />
                </div>
              </div>
            </header>
            {editing && <EditTitleModal kind={kind} title={title} onClose={() => setEditing(false)} onSaved={setTitle} />}
            {keeping && (
              <KeepReadyModal
                kind={show ? (keeping.season === undefined ? "show" : "season") : "movie"}
                id={title.id}
                season={keeping.season}
                name={keeping.name}
                onClose={() => setKeeping(null)}
              />
            )}
            {collecting && (
              <AddToCollectionModal entityType={collectAs} entityId={title.id} title={title.title} onClose={() => setCollecting(false)} />
            )}

            {title.cast && <CastRow cast={title.cast} />}

            {!show && ((title as VideoMovie).parts?.length ?? 0) > 0 && <PartList parts={(title as VideoMovie).parts!} mark={mark} />}

            {!show && (title as VideoMovie).set && <SetStrip movieId={title.id} set={(title as VideoMovie).set!} />}

            {show && (show.seasons.length === 0 ? <p className="muted">{t("video.noEpisodes")}</p> : <Seasons show={show} mark={mark} markAll={markAll} onKeepReady={user.role === "admin" ? (season, name) => setKeeping({ season, name }) : null} />)}
          </>
        )}
      </section>
    </DashboardShell>
  );
}

/** Episodes to keep on this device, under what the dialog calls them together. */
function episodesDownload(show: VideoShow, season: number, episodes: VideoEpisode[], name: string, t: TFunction): VideoDownloadTarget {
  return {
    name,
    parent: { kind: "shows", id: show.id },
    posterUrl: show.poster ?? null,
    items: episodes.map((episode) => ({
      id: episode.id,
      title: episode.title ?? t("video.episode", { number: episode.episode }),
      showTitle: show.title,
      season,
      episode: episode.episode,
      runtimeMinutes: episode.runtimeMinutes
    }))
  };
}

/** Something that can be marked watched: its id, how far this person got, how long it is. */
interface WatchTarget {
  id: string;
  progress: VideoProgress | null;
  runtimeMinutes?: number | null;
}

type MarkWatched = (targets: WatchTarget[], watched: boolean) => Promise<void>;
/** Every episode of the show, or of one season, at once. */
type MarkAll = (watched: boolean, season?: number) => Promise<void>;

const seenIn = (episodes: VideoEpisode[]) => episodes.filter((episode) => episode.progress?.watched).length;
const startedIn = (episodes: VideoEpisode[]) => episodes.some((episode) => episode.progress?.watched || inProgress(episode.progress));

/** Many episodes at once are asked about first: `ask` opens the question, and
 *  `dialog` is it. Marking unwatched forgets where each was stopped, so it says so. */
function useMarkAll(markAll: MarkAll): { ask: (name: string, watched: boolean, season?: number) => void; dialog: ReactNode } {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{ name: string; watched: boolean; season?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!pending) return;
    setBusy(true);
    await markAll(pending.watched, pending.season);
    setBusy(false);
    setPending(null);
  };
  return {
    ask: (name, watched, season) => setPending({ name, watched, season }),
    dialog: pending && (
      <ConfirmDialog
        title={pending.watched ? t("video.mark.showWatchedTitle", { name: pending.name }) : t("video.mark.showUnwatchedTitle", { name: pending.name })}
        confirmLabel={pending.watched ? t("video.mark.watched") : t("video.mark.unwatched")}
        busyLabel={t("video.mark.saving")}
        busy={busy}
        danger={!pending.watched}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      >
        {pending.watched ? t("video.mark.showWatchedBody") : t("video.mark.showUnwatchedBody")}
      </ConfirmDialog>
    )
  };
}

/** Everything about a title that is not Play, My list or Download, under one
 *  More button, so the row of actions stays one row: marking it watched or not
 *  (a whole show is asked about first), Add to collection, and an admin's Edit. */
function TitleMore({ title, mark, markAll, onCollect, onEdit, onKeepReady }: {
  title: VideoShow | VideoMovie;
  mark: MarkWatched;
  markAll: MarkAll;
  onCollect: () => void;
  onEdit: (() => void) | null;
  /** An admin's Keep ready (converted ahead of time and kept). */
  onKeepReady: (() => void) | null;
}) {
  const { t } = useTranslation();
  const confirm = useMarkAll(markAll);
  const items: ActionMenuItem[] = [];
  if ("seasons" in title) {
    const episodes = title.seasons.flatMap((season) => season.episodes);
    if (title.marksAll && episodes.length > 0) {
      if (seenIn(episodes) < episodes.length) {
        items.push({ key: "watched", label: t("video.mark.allWatched"), icon: <CheckCheck size={15} />, onSelect: () => confirm.ask(title.title, true) });
      }
      if (startedIn(episodes)) {
        items.push({ key: "unwatched", label: t("video.mark.allUnwatched"), icon: <RotateCcw size={15} />, onSelect: () => confirm.ask(title.title, false) });
      }
    }
  } else {
    const parts = title.parts ?? [];
    const targets: WatchTarget[] = parts.length > 0
      ? parts.map((part) => ({ id: part.id, progress: part.progress }))
      : [{ id: title.playId ?? title.id, progress: title.progress, runtimeMinutes: title.runtimeMinutes }];
    // The part marked last is where the engine takes this person to be: the last
    // one for a film now watched, the first for one to be watched again.
    const run = (watched: boolean) => void mark(watched ? targets : [...targets].reverse(), watched);
    const watched = title.progress?.watched === true;
    const started = parts.length > 0 ? parts.some((part) => inProgress(part.progress) || part.progress?.watched) : inProgress(title.progress);
    items.push(watched
      ? { key: "unwatched", label: t("video.mark.unwatched"), icon: <RotateCcw size={15} />, onSelect: () => run(false) }
      : { key: "watched", label: t("video.mark.watched"), icon: <CheckCheck size={15} />, onSelect: () => run(true) });
    if (!watched && started) items.push({ key: "reset", label: t("video.mark.reset"), icon: <RotateCcw size={15} />, onSelect: () => run(false) });
  }
  items.push({ key: "collect", label: t("video.addToCollection"), icon: <FolderPlus size={15} />, onSelect: onCollect });
  if (onKeepReady) items.push({ key: "keep", label: t("video.keepReady.open"), icon: <Pin size={15} />, onSelect: onKeepReady });
  if (onEdit) items.push({ key: "edit", label: t("video.edit.open"), icon: <Pencil size={15} />, onSelect: onEdit });
  return (
    <>
      <ActionMenu trigger="icon" className="video-title-more" label={t("video.mark.menu", { name: title.title })} items={items} />
      {confirm.dialog}
    </>
  );
}

/** What can be done about one episode or part by hand: Mark as watched until it
 *  is, Mark as unwatched once it is, and Reset progress while it is part-way. */
function watchedItems(target: WatchTarget, mark: MarkWatched, t: TFunction): ActionMenuItem[] {
  const watched = target.progress?.watched === true;
  return [
    watched
      ? { key: "unwatched", label: t("video.mark.unwatched"), icon: <RotateCcw size={15} />, onSelect: () => void mark([target], false) }
      : { key: "watched", label: t("video.mark.watched"), icon: <CheckCheck size={15} />, onSelect: () => void mark([target], true) },
    ...(inProgress(target.progress)
      ? [{ key: "reset", label: t("video.mark.reset"), icon: <RotateCcw size={15} />, onSelect: () => void mark([target], false) }]
      : [])
  ];
}

const seasonName = (number: number, t: (key: "video.specials" | "video.season", options?: { number: number }) => string) =>
  (number === 0 ? t("video.specials") : t("video.season", { number }));

/** One season at a time, opening on the one this person is up to, as on the TV.
 *  One row over its episodes: the seasons to pick from on the left; on the right
 *  how much of this one is seen, and a menu for the season as a whole. */
function Seasons({ show, mark, markAll, onKeepReady }: { show: VideoShow; mark: MarkWatched; markAll: MarkAll; onKeepReady: ((season: number, name: string) => void) | null }) {
  const { t } = useTranslation();
  const confirm = useMarkAll(markAll);
  const [chosen, setChosen] = useState<number | null>(null);
  const number = chosen ?? show.nextUp?.season ?? show.seasons[0].number;
  const current = show.seasons.find((season) => season.number === number) ?? show.seasons[0];
  const several = show.seasons.length > 1;
  const seen = seenIn(current.episodes);
  const seasonTitle = `${show.title} · ${seasonName(current.number, t)}`;
  const download = useVideoDownloadControl(episodesDownload(show, current.number, current.episodes, seasonTitle, t));
  const downloadItem = download.menuItem(t("video.download.openSeason"));
  const items: ActionMenuItem[] = [
    ...(show.marksAll && seen < current.episodes.length
      ? [{ key: "watched", label: t("video.mark.seasonWatched"), icon: <CheckCheck size={15} />, onSelect: () => confirm.ask(seasonTitle, true, current.number) }]
      : []),
    ...(show.marksAll && startedIn(current.episodes)
      ? [{ key: "unwatched", label: t("video.mark.seasonUnwatched"), icon: <RotateCcw size={15} />, onSelect: () => confirm.ask(seasonTitle, false, current.number) }]
      : []),
    ...(downloadItem ? [downloadItem] : []),
    ...(onKeepReady ? [{ key: "keep", label: t("video.keepReady.openSeason"), icon: <Pin size={15} />, onSelect: () => onKeepReady(current.number, seasonTitle) }] : [])
  ];
  return (
    <section className="video-season" aria-labelledby={`season-${current.number}`}>
      <div className="video-season-bar">
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
        {current.episodes.length > 0 && (
          <div className="video-season-seen">
            {/* How much of the season this person has seen: a count, and a bar of it. */}
            <span className="video-season-count">
              {t("video.mark.seasonCount", { watched: seen, count: current.episodes.length })}
              {seen === current.episodes.length && <Check size={15} className="video-watched-mark" aria-hidden="true" />}
            </span>
            <span className="video-progress" aria-hidden="true"><span style={{ width: `${Math.round((seen / current.episodes.length) * 100)}%` }} /></span>
            {items.length > 0 && <ActionMenu trigger="icon" label={t("video.mark.menu", { name: seasonName(current.number, t) })} items={items} />}
          </div>
        )}
      </div>
      {confirm.dialog}
      {download.dialogs}
      <ol className="video-episodes">
        {current.episodes.map((episode) => <EpisodeCard key={episode.id} show={show} season={current.number} episode={episode} mark={mark} />)}
      </ol>
    </section>
  );
}

/** An episode, or one part of a film, as a card: its picture — a check in the
 *  corner once it is watched, a bar while it is part-way — then its name with a
 *  menu beside it, a line about it, and what it is about. */
function MediaCard({ name, href, still, number, progress, meta, saved, status, plot, items, children }: {
  name: string;
  href: string;
  still?: string | null;
  number: number;
  progress: VideoProgress | null;
  /** "S02E04 · 52 min". */
  meta: string;
  /** Kept on this device. */
  saved?: boolean;
  /** On its way to this device: what it is doing. */
  status?: string;
  plot?: string | null;
  items: ActionMenuItem[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const fraction = progressFraction(progress);
  const watched = progress?.watched === true;
  return (
    <li className={`video-episode${watched ? " is-watched" : ""}`}>
      <a className="video-episode-play" href={href} onClick={(event) => followRoute(event, href)} aria-label={t("video.playEpisode", { name })}>
        {still ? <img src={still} alt="" loading="lazy" /> : <span className="video-episode-number">{number}</span>}
        <Play className="video-episode-icon" size={30} fill="currentColor" aria-hidden="true" />
        {watched && (
          <span className="video-card-watched" role="img" aria-label={t("video.watched")}>
            <Check size={14} strokeWidth={3} aria-hidden="true" />
          </span>
        )}
        {fraction > 0 && fraction < 1 && (
          <span className="video-card-progress" aria-hidden="true"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
        )}
      </a>
      <div className="video-episode-copy">
        <div className="video-episode-head">
          <strong>{name}</strong>
          <ActionMenu trigger="icon" label={t("video.mark.menu", { name })} items={items} />
        </div>
        <small className="muted video-episode-meta">
          {meta && <span>{meta}</span>}
          {saved && (
            <span className="video-episode-saved">
              <HardDrive size={13} aria-hidden="true" />
              {t("video.download.onDevice")}
            </span>
          )}
          {status && <span>{status}</span>}
        </small>
        {plot && <p>{plot}</p>}
      </div>
      {children}
    </li>
  );
}

function EpisodeCard({ show, season, episode, mark }: { show: VideoShow; season: number; episode: VideoEpisode; mark: MarkWatched }) {
  const { t } = useTranslation();
  const name = episode.title ?? t("video.episode", { number: episode.episode });
  const href = watchHref(episode.id);
  const download = useVideoDownloadControl(episodesDownload(show, season, [episode], name, t));
  const downloadItem = download.menuItem(t("video.download.episode"));
  return (
    <MediaCard
      name={name}
      href={href}
      still={episode.still}
      number={episode.episode}
      progress={episode.progress}
      meta={[
        t("video.episodeCode", episodeCodeValues(season, episode.episode)),
        episode.runtimeMinutes ? t("video.minutes", { count: episode.runtimeMinutes }) : null,
        episode.aired ? t("video.aired", { date: formatDate(episode.aired, "medium", { utc: true }) }) : null
      ].filter(Boolean).join(" · ")}
      saved={download.state === "done"}
      status={download.state === "active" ? download.text : undefined}
      plot={episode.plot}
      items={[
        { key: "play", label: t("video.playEpisodeItem"), icon: <Play size={15} />, onSelect: () => navigate(href) },
        ...watchedItems(episode, mark, t),
        ...(downloadItem ? [downloadItem] : [])
      ]}
    >
      {download.dialogs}
    </MediaCard>
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
function PartList({ parts, mark }: { parts: NonNullable<VideoMovie["parts"]>; mark: MarkWatched }) {
  const { t } = useTranslation();
  return (
    <section className="video-season" aria-labelledby="video-parts-title">
      <h2 id="video-parts-title">{t("video.parts")}</h2>
      <ol className="video-episodes">
        {parts.map((part) => {
          const name = part.title ?? t("video.part", { number: part.part });
          const href = watchHref(part.id);
          return (
            <MediaCard
              key={part.id}
              name={name}
              href={href}
              still={part.still}
              number={part.part}
              progress={part.progress}
              meta={part.title
                ? [t("video.part", { number: part.part }), part.aired ? t("video.aired", { date: formatDate(part.aired, "medium", { utc: true }) }) : null].filter(Boolean).join(" · ")
                : ""}
              plot={part.plot}
              items={[
                { key: "play", label: t("video.play"), icon: <Play size={15} />, onSelect: () => navigate(href) },
                ...watchedItems(part, mark, t)
              ]}
            />
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
