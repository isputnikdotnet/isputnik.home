import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Play } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followBack, followRoute } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { PosterGrid } from "./VideoPoster";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, formatPlayTime, progressFraction, videoBrowseHref, videoHref, watchHref, yearSpan, type VideoSet } from "./types";
import "../../styles/video.css";
import { DEFAULT_COVERS } from "../audiobooks/covers";

/** Where Back goes: the Movies page on its Sets view. */
const SETS_HREF = videoBrowseHref("movies", "sets");

// One film set (docs/video-sets-plan.md): films that belong together, in order —
// TMDB's release dates, else the years — with one Play that starts the first
// film this person hasn't watched yet. Only the films they may see are here.
export function VideoSetPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const [set, setSet] = useState<VideoSet | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setSet(null);
    setMissing(false);
    api<VideoSet>(`${VIDEO_API}/sets/${encodeURIComponent(id)}`)
      .then((payload) => { if (live) { setSet(payload); setError(""); } })
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : t("video.loadFailed");
        // 404: no such set, or none of its films in a library this person may see.
        if (/not found|no such/i.test(message)) setMissing(true);
        else setError(message);
      });
    return () => { live = false; };
  }, [id, t]);

  const watched = set ? set.films.filter((film) => film.progress?.watched).length : 0;
  const years = set ? set.films.map((film) => film.year).filter((year): year is number => year !== null) : [];
  const facts = set
    ? [
        t("video.films", { count: set.films.length }),
        yearSpan(years.length > 0 ? Math.min(...years) : null, years.length > 0 ? Math.max(...years) : null),
        watched > 0 ? t("video.set.watched", { count: set.films.length, watched }) : null
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav />}>
      <section className="audiobook-main-page video-page video-title-page">
        {set?.backdrop && (
          <div className="video-title-backdrop" aria-hidden="true">
            <img src={set.backdrop} alt="" />
          </div>
        )}
        <div className="book-detail-topbar">
          <a className="audiobook-back-button" href={SETS_HREF} onClick={(event) => followBack(event, SETS_HREF)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("video.set.back")}</span>
          </a>
        </div>

        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}
        {missing && <MessageBox tone="info" title={t("video.loadFailed")}>{t("video.notFound")}</MessageBox>}

        {set && (
          <>
            <header className="video-title-head">
              <div className="video-title-cover" aria-hidden="true">
                <img src={set.poster ?? DEFAULT_COVERS.movie} alt="" />
              </div>
              <div className="video-title-copy">
                <h1>{set.name}</h1>
                {facts && <p className="video-title-facts">{facts}</p>}
                {set.overview && <p className="video-plot">{set.overview}</p>}
                <div className="video-title-actions">
                {set.next ? (
                  <div className="video-play-action">
                    {/* A link, so it opens in a new tab like any address; it wears Button's primary look. */}
                    <a className="primary-button video-play-button" href={watchHref(set.next.id)} onClick={(event) => followRoute(event, watchHref(set.next!.id))}>
                      <Play size={18} aria-hidden="true" />
                      <span>
                        {set.next.position > 0
                          ? t("video.set.resume", { title: set.next.title, time: formatPlayTime(set.next.position) })
                          : t("video.set.play", { title: set.next.title })}
                      </span>
                    </a>
                  </div>
                ) : (
                  <p className="muted video-play-note">{t("video.set.allWatched")}</p>
                )}
                </div>
              </div>
            </header>

            <PosterGrid
              items={set.films.map((film) => ({
                key: film.id,
                href: videoHref("movies", film.id),
                title: film.title,
                sub: [film.year ? String(film.year) : null, film.runtimeMinutes ? t("video.minutes", { count: film.runtimeMinutes }) : null].filter(Boolean).join(" · "),
                poster: film.poster,
                kind: "movie",
                fraction: progressFraction(film.progress),
                watched: film.progress?.watched
              }))}
            />
          </>
        )}
      </section>
    </DashboardShell>
  );
}
