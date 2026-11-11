import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { useVideoAvailable } from "../../app/useVideoAvailable";
import { VIDEO_API, episodeCodeValues, watchHref, type VideoArt, type VideoContinueItem, type VideoShow } from "./types";
import { PosterRow } from "./VideoPoster";
import { useWatchedStamp } from "./watched";
import "../../styles/video.css";

// The engine's continue list has no pictures, so each costs a request of its own.
// A row shows about this many before it scrolls.
const POSTERS_ASKED = 8;

// Continue watching: what this person left halfway, and the next episode of a
// show they finished one of — newest first, one per show, from the engine
// (GET /video/api/continue). On the overview, Shows (episodes only), Movies (films
// only) and For you (both). Nothing at all, not even a heading, when there is
// nothing to continue or no video here.
export function ContinueWatching({ only, title }: { only?: "episode" | "movie"; /** The row's own name, when the household gave it one. */ title?: string }) {
  const { t } = useTranslation();
  const available = useVideoAvailable();
  const [items, setItems] = useState<VideoContinueItem[] | null>(null);
  const [posters, setPosters] = useState<Record<string, string | null>>({});
  /** Something was marked watched by hand: what comes next has changed. */
  const marked = useWatchedStamp();

  useEffect(() => {
    if (!available) return;
    let live = true;
    api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`)
      .then(async (payload) => {
        if (!live) return;
        setItems(payload.items);
        const wanted = payload.items.filter((item) => !only || item.type === only).slice(0, POSTERS_ASKED);
        // A wide card wants a frame of the film: the episode's own still, else the
        // show's or film's backdrop, else its poster (cropped).
        const pictures = await Promise.allSettled(wanted.map(async (item) => {
          if (item.show) {
            const show = await api<VideoShow>(`${VIDEO_API}/shows/${encodeURIComponent(item.show.id)}`);
            const still = show?.seasons?.flatMap((season) => season.episodes).find((episode) => episode.id === item.id)?.still;
            return [item.id, still ?? show?.backdrop ?? show?.poster ?? null] as const;
          }
          const movie = await api<VideoArt & { backdrop?: string | null }>(`${VIDEO_API}/movies/${encodeURIComponent(item.id)}`);
          return [item.id, movie?.backdrop ?? movie?.poster ?? null] as const;
        }));
        if (live) setPosters(Object.fromEntries(pictures.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []))));
      })
      // A row that cannot be read is simply not shown.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [available, only, marked]);

  const shown = (items ?? []).filter((item) => !only || item.type === only);
  if (!available) return null;

  return (
    <PosterRow
      shape="wide"
      title={title ?? t("video.continueWatching")}
      items={shown.map((item) => {
        const code = item.season !== null && item.episode !== null ? t("video.episodeCode", episodeCodeValues(item.season, item.episode)) : null;
        const minutes = item.resume && item.duration ? Math.max(1, Math.ceil((item.duration - item.position) / 60)) : null;
        const left = minutes === null ? null
          : minutes < 60 ? t("video.leftMinutes", { minutes }) : t("video.leftHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
        // "S01E01 · 47 min left"; an episode not started yet, "S01E03 · next".
        const sub = item.show ? [code, left ?? t("video.upNextShort")].filter(Boolean).join(" · ") : left;
        return {
          key: item.id,
          href: watchHref(item.id),
          title: item.show ? item.show.title : item.title,
          sub,
          poster: posters[item.id] ?? null,
          kind: item.type === "episode" ? "show" : "movie",
          fraction: item.resume && item.duration ? Math.min(1, item.position / item.duration) : undefined
        };
      })}
    />
  );
}
