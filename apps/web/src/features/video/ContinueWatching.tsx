import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, Info, Play } from "lucide-react";
import { api } from "../../api";
import { useVideoAvailable } from "../../app/useVideoAvailable";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, episodeCodeValues, videoHref, watchHref, type VideoArt, type VideoContinueItem, type VideoShow } from "./types";
import { PosterRow } from "./VideoPoster";
import { useWatchedStamp } from "./watched";
import "../../styles/video.css";

// The engine's continue list has no pictures, so each costs a request of its own:
// a few at a time, each card filled as its picture arrives.
const PICTURES_AT_ONCE = 4;

/** A wide card wants a frame of the film: the episode's own still, else the
 *  show's or film's backdrop, else its poster (cropped). */
async function pictureOf(item: VideoContinueItem): Promise<string | null> {
  if (item.show) {
    const show = await api<VideoShow>(`${VIDEO_API}/shows/${encodeURIComponent(item.show.id)}`);
    const still = show?.seasons?.flatMap((season) => season.episodes).find((episode) => episode.id === item.id)?.still;
    return still ?? show?.backdrop ?? show?.poster ?? null;
  }
  const movie = await api<VideoArt & { backdrop?: string | null }>(`${VIDEO_API}/movies/${encodeURIComponent(item.id)}`);
  return movie?.backdrop ?? movie?.poster ?? null;
}

// Continue watching: what this person left halfway, and the next episode of a
// show they finished one of — newest first, one per show, from the engine
// (GET /video/api/continue). On the overview, Shows (episodes only), Movies (films
// only) and For you (both). Nothing at all, not even a heading, when there is
// nothing to continue or no video here. Each card's menu can take its show or
// film off the row (engine 0.34+); the place in it is kept, and playing it again
// brings it back.
export function ContinueWatching({ only, title }: { only?: "episode" | "movie"; /** The row's own name, when the household gave it one. */ title?: string }) {
  const { t } = useTranslation();
  const available = useVideoAvailable();
  const [items, setItems] = useState<VideoContinueItem[] | null>(null);
  const [posters, setPosters] = useState<Record<string, string | null>>({});
  const [error, setError] = useState("");
  /** Something was marked watched by hand: what comes next has changed. */
  const marked = useWatchedStamp();

  useEffect(() => {
    if (!available) return;
    let live = true;
    api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`)
      .then(async (payload) => {
        if (!live) return;
        setItems(payload.items);
        const queue = payload.items.filter((item) => !only || item.type === only);
        // Every card gets its picture, not only the first screenful.
        const worker = async () => {
          for (let item = queue.shift(); item && live; item = queue.shift()) {
            const id = item.id;
            const picture = await pictureOf(item).catch(() => null);
            if (live) setPosters((current) => ({ ...current, [id]: picture }));
          }
        };
        await Promise.all(Array.from({ length: PICTURES_AT_ONCE }, worker));
      })
      // A row that cannot be read is simply not shown.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [available, only, marked]);

  /** Off the row at once; back again if the engine couldn't keep it off. */
  const remove = async (item: VideoContinueItem) => {
    setError("");
    setItems((current) => current?.filter((entry) => entry.id !== item.id) ?? current);
    try {
      await api(`${VIDEO_API}/continue/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    } catch (err) {
      setItems((current) => (current && !current.some((entry) => entry.id === item.id) ? [...current, item] : current));
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
  };

  const shown = (items ?? []).filter((item) => !only || item.type === only);
  if (!available) return null;

  return (
    <>
      {error && <MessageBox tone="error" title={t("video.continueRemoveFailed")}>{error}</MessageBox>}
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
          const name = item.show ? item.show.title : item.title;
          return {
            key: item.id,
            href: watchHref(item.id),
            title: name,
            sub,
            poster: posters[item.id] ?? null,
            kind: item.type === "episode" ? "show" : "movie",
            fraction: item.resume && item.duration ? Math.min(1, item.position / item.duration) : undefined,
            menu: [
              { key: "play", label: item.resume ? t("video.continueResume") : t("video.play"), icon: <Play size={15} />, onSelect: () => navigate(watchHref(item.id)) },
              {
                key: "details",
                label: t("video.continueDetails"),
                icon: <Info size={15} />,
                onSelect: () => navigate(item.show ? videoHref("shows", item.show.id) : videoHref("movies", item.id))
              },
              { key: "remove", label: t("video.continueRemove"), icon: <EyeOff size={15} />, onSelect: () => void remove(item) }
            ]
          };
        })}
      />
    </>
  );
}
