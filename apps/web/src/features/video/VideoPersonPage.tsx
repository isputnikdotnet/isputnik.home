import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, UserRound } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followBack } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { PosterGrid } from "./VideoPoster";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, VIDEO_OVERVIEW_HREF, videoHref, type VideoPerson } from "./types";
import "../../styles/video.css";

const BACK = VIDEO_OVERVIEW_HREF;

// One person (docs/video-people-plan.md): their picture and name over every film
// and show of theirs in the library this person may see, newest first, each
// saying the part they played or what they did.
export function VideoPersonPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const [person, setPerson] = useState<VideoPerson | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setPerson(null);
    setMissing(false);
    api<VideoPerson>(`${VIDEO_API}/people/${encodeURIComponent(id)}`)
      .then((payload) => { if (live) { setPerson(payload); setError(""); } })
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : t("video.loadFailed");
        // 404: no such person, or nothing of theirs this person may see.
        if (/not found|no such/i.test(message)) setMissing(true);
        else setError(message);
      });
    return () => { live = false; };
  }, [id, t]);

  /** What they did in a title: "as …" for a part, the jobs otherwise. */
  const roleOf = (title: VideoPerson["titles"][number]) => {
    const parts = [
      ...title.characters.map((character) => t("video.people.as", { character })),
      ...(title.actor && title.characters.length === 0 ? [t("video.people.actor")] : []),
      ...title.jobs.map((job) => t(`video.people.job.${job}`, { count: 1 }))
    ];
    return [title.year ? String(title.year) : null, parts.join(", ") || null].filter(Boolean).join(" · ");
  };

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav />}>
      <section className="audiobook-main-page video-page video-person-page">
        <div className="book-detail-topbar">
          <a className="audiobook-back-button" href={BACK} onClick={(event) => followBack(event, BACK)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("nav.video")}</span>
          </a>
        </div>

        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}
        {missing && <MessageBox tone="info" title={t("video.loadFailed")}>{t("video.people.notFound")}</MessageBox>}

        {person && (
          <>
            <header className="video-person-head">
              <span className="video-person-photo is-large" aria-hidden="true">
                {person.photo ? <img src={person.photo} alt="" /> : <UserRound size={64} />}
              </span>
              <div>
                <h1>{person.name}</h1>
                <p className="muted">{t("video.people.titleCount", { count: person.titles.length })}</p>
              </div>
            </header>
            <PosterGrid
              items={person.titles.map((title) => ({
                key: `${title.kind}-${title.id}`,
                href: videoHref(title.kind, title.id),
                title: title.title,
                sub: roleOf(title),
                poster: title.poster,
                kind: title.kind === "shows" ? "show" : "movie"
              }))}
            />
          </>
        )}
      </section>
    </DashboardShell>
  );
}
