import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Info, ListVideo, Play } from "lucide-react";
import { api } from "../../api";
import { followRoute } from "../../router";
import {
  VIDEO_API, episodeCodeValues, formatPlayTime, videoHref, watchHref,
  type VideoContinueItem, type VideoKind, type VideoMovie, type VideoPage, type VideoShow
} from "./types";

interface Banner {
  title: string;
  line: string | null;
  backdrop: string | null;
  details: string;
  fraction: number | null;
  inProgress: boolean;
  /** What the main button plays; null when there's nothing to start, a finished show. */
  playHref: string | null;
  moreHref: string;
  isShow: boolean;
}

const title = (kind: VideoKind, id: string) => api<VideoShow | VideoMovie>(`${VIDEO_API}/${kind}/${encodeURIComponent(id)}`);

function fromContinue(item: VideoContinueItem, detail: VideoShow | VideoMovie, t: TFunction): Banner {
  const code = item.season !== null && item.episode !== null ? t("video.episodeCode", episodeCodeValues(item.season, item.episode)) : null;
  const started = item.resume && Boolean(item.duration);
  const left = started ? t("video.continueLeft", { time: formatPlayTime(item.duration! - item.position) }) : null;
  return {
    title: detail.title,
    line: detail.plot ?? (item.show ? item.title : null),
    backdrop: detail.backdrop ?? null,
    details: [code, left].filter(Boolean).join(" · "),
    fraction: started ? Math.min(1, item.position / item.duration!) : null,
    inProgress: item.resume,
    playHref: watchHref(item.id),
    moreHref: item.show ? videoHref("shows", item.show.id) : videoHref("movies", detail.id),
    isShow: Boolean(item.show)
  };
}

function fromNewest(detail: VideoShow | VideoMovie, t: TFunction): Banner {
  const show = "seasons" in detail ? detail : null;
  const next = show?.nextUp ?? null;
  return {
    title: detail.title,
    line: detail.plot,
    backdrop: detail.backdrop ?? null,
    details: next ? t("video.episodeCode", episodeCodeValues(next.season!, next.episode!)) : "",
    fraction: null,
    inProgress: false,
    playHref: show ? (next ? watchHref(next.id) : null) : watchHref((detail as VideoMovie).playId ?? detail.id),
    moreHref: videoHref(show ? "shows" : "movies", detail.id),
    isShow: Boolean(show)
  };
}

async function newest(kind: VideoKind): Promise<VideoShow | VideoMovie | null> {
  const page = await api<VideoPage<{ id: string }>>(`${VIDEO_API}/${kind}?sort=added&pageSize=1`);
  return page.items[0] ? title(kind, page.items[0].id) : null;
}

// What's in progress here, else the newest: the same choice the TV app makes.
// Nothing at all when it can't be read: a banner must not cost the page its rows.
async function loadBanner(kinds: VideoKind[], t: TFunction): Promise<Banner | null> {
  const { items } = await api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`).catch(() => ({ items: [] as VideoContinueItem[] }));
  const resume = items.find((item) => (item.show ? kinds.includes("shows") : kinds.includes("movies")));
  if (resume) {
    const detail = await (resume.show ? title("shows", resume.show.id) : title("movies", resume.id)).catch(() => null);
    if (detail) return fromContinue(resume, detail, t);
  }
  for (const kind of kinds) {
    const detail = await newest(kind).catch(() => null);
    if (detail) return fromNewest(detail, t);
  }
  return null;
}

/** The big picture at the top of the video pages. `kinds` says what it may show. */
export function VideoBanner({ kinds }: { kinds: VideoKind[] }) {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<Banner | null>(null);
  const kindsKey = kinds.join(",");

  useEffect(() => {
    let live = true;
    setBanner(null);
    void loadBanner(kindsKey.split(",") as VideoKind[], t).then((next) => { if (live) setBanner(next); });
    return () => { live = false; };
  }, [kindsKey, t]);

  if (!banner) return null;
  const MoreIcon = banner.isShow ? ListVideo : Info;
  return (
    <section className="video-banner" aria-label={banner.title}>
      {banner.backdrop && <img className="video-banner-picture" src={banner.backdrop} alt="" />}
      <div className="video-banner-copy">
        <h2>{banner.title}</h2>
        {banner.line && <p className="video-banner-line">{banner.line}</p>}
        {(banner.fraction !== null || banner.details) && (
          <div className="video-banner-progress">
            {banner.fraction !== null && (
              <span className="video-banner-bar" aria-hidden="true"><span style={{ width: `${Math.round(banner.fraction * 100)}%` }} /></span>
            )}
            {banner.details && <span>{banner.details}</span>}
          </div>
        )}
        <div className="video-banner-actions">
          {banner.playHref && (
            <a className="primary-button video-banner-play" href={banner.playHref} onClick={(event) => followRoute(event, banner.playHref!)}>
              <Play size={18} fill="currentColor" aria-hidden="true" />
              <span>{banner.inProgress ? t("video.continue") : t("video.play")}</span>
            </a>
          )}
          <a className="video-banner-more" href={banner.moreHref} onClick={(event) => followRoute(event, banner.moreHref)}>
            <MoreIcon size={18} aria-hidden="true" />
            <span>{banner.isShow ? t("video.episodesButton") : t("video.more")}</span>
          </a>
        </div>
      </div>
    </section>
  );
}
