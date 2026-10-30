import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Film, Layers, Play } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followBack, followRoute } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, formatPlayTime, progressFraction, videoHref, watchHref, yearSpan, type VideoSet } from "./types";
import "../../styles/video.css";

/** Where Back goes: the Movies page on its Sets view. */
const SETS_HREF = `${videoHref("movies")}?view=sets`;

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
    <DashboardShell active="video" sideNav={<VideoSectionNav activeKey="movies" />}>
      <section className="audiobook-main-page video-title-page">
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
            {set.backdrop && (
              <div className="video-title-backdrop" aria-hidden="true">
                <img src={set.backdrop} alt="" />
              </div>
            )}
            <header className="video-title-head">
              <div className={`video-title-cover${set.poster ? " has-poster" : ""}`} aria-hidden="true">
                {set.poster ? <img src={set.poster} alt="" /> : <Layers size={34} />}
              </div>
              <div className="video-title-copy">
                <h1>{set.name}</h1>
                {facts && <p className="video-title-facts">{facts}</p>}
              </div>
            </header>

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

            {set.overview && <p className="video-plot">{set.overview}</p>}

            <ol className="video-grid video-set-films">
              {set.films.map((film) => {
                const href = videoHref("movies", film.id);
                const fraction = progressFraction(film.progress);
                return (
                  <li key={film.id}>
                    <a className="video-card" href={href} onClick={(event) => followRoute(event, href)}>
                      <div className={`video-card-cover${film.poster ? " has-poster" : ""}`} aria-hidden="true">
                        {film.poster ? (
                          <img src={film.poster} alt="" loading="lazy" />
                        ) : (
                          <>
                            <Film size={22} />
                            <strong>{film.title.slice(0, 2).toUpperCase()}</strong>
                          </>
                        )}
                      </div>
                      <div className="video-card-body">
                        <strong>
                          {film.title}
                          {film.progress?.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />}
                        </strong>
                        <span>{[film.year ? String(film.year) : null, film.runtimeMinutes ? t("video.minutes", { count: film.runtimeMinutes }) : null].filter(Boolean).join(" · ")}</span>
                        {fraction > 0 && fraction < 1 && (
                          <span className="video-progress" aria-hidden="true">
                            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
                          </span>
                        )}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>
    </DashboardShell>
  );
}
