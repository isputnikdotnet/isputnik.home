import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, Tv } from "lucide-react";
import { api } from "../../api";
import { useVideoAvailable } from "../../app/useVideoAvailable";
import { VIDEO_API, episodeCodeValues, formatPlayTime, watchHref, type VideoArt, type VideoContinueItem } from "./types";
import { PosterRow } from "./VideoPoster";
import "../../styles/video.css";

// The engine's continue list has no pictures, so each costs a request of its own.
// A row shows about this many before it scrolls.
const POSTERS_ASKED = 8;

// Continue watching: what this person left halfway, and the next episode of a
// show they finished one of — newest first, one per show, from the engine
// (GET /video/api/continue). On the overview, Shows (episodes only), Movies (films
// only) and For you (both). Nothing at all, not even a heading, when there is
// nothing to continue or no video here.
export function ContinueWatching({ only }: { only?: "episode" | "movie" }) {
  const { t } = useTranslation();
  const available = useVideoAvailable();
  const [items, setItems] = useState<VideoContinueItem[] | null>(null);
  const [posters, setPosters] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!available) return;
    let live = true;
    api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`)
      .then(async (payload) => {
        if (!live) return;
        setItems(payload.items);
        const wanted = payload.items.filter((item) => !only || item.type === only).slice(0, POSTERS_ASKED);
        const pictures = await Promise.allSettled(wanted.map(async (item) => {
          const path = item.show ? `shows/${encodeURIComponent(item.show.id)}` : `movies/${encodeURIComponent(item.id)}`;
          const detail = await api<VideoArt>(`${VIDEO_API}/${path}`);
          return [item.id, detail?.poster ?? null] as const;
        }));
        if (live) setPosters(Object.fromEntries(pictures.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []))));
      })
      // A row that cannot be read is simply not shown.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [available, only]);

  const shown = (items ?? []).filter((item) => !only || item.type === only);
  if (!available) return null;

  return (
    <PosterRow
      title={t("video.continueWatching")}
      items={shown.map((item) => {
        const code = item.season !== null && item.episode !== null ? t("video.episodeCode", episodeCodeValues(item.season, item.episode)) : null;
        const sub = item.show
          ? [code, item.title, item.resume ? null : t("video.upNextShort")].filter(Boolean).join(" · ")
          : item.resume && item.duration ? t("video.continueLeft", { time: formatPlayTime(item.duration - item.position) }) : null;
        return {
          key: item.id,
          href: watchHref(item.id),
          title: item.show ? item.show.title : item.title,
          sub,
          poster: posters[item.id] ?? null,
          icon: item.type === "episode" ? Tv : Film,
          fraction: item.resume && item.duration ? Math.min(1, item.position / item.duration) : undefined
        };
      })}
    />
  );
}
