import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, Play, Tv } from "lucide-react";
import { api } from "../../api";
import { useVideoAvailable } from "../../app/useVideoAvailable";
import { followRoute } from "../../router";
import { VIDEO_API, episodeCodeValues, formatPlayTime, watchHref, type VideoContinueItem } from "./types";
import "../../styles/video.css";

// Continue watching: what this person left halfway, and the next episode of a
// show they finished one of — newest first, one per show, from the engine
// (GET /video/api/continue). On Shows (episodes only), Movies (films only) and
// For you (both). Nothing at all, not even a heading, when there is nothing to
// continue or no video here.
export function ContinueWatching({ only }: { only?: "episode" | "movie" }) {
  const { t } = useTranslation();
  const available = useVideoAvailable();
  const [items, setItems] = useState<VideoContinueItem[] | null>(null);

  useEffect(() => {
    if (!available) return;
    let live = true;
    api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`)
      .then((payload) => { if (live) setItems(payload.items); })
      // A row that cannot be read is simply not shown.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [available]);

  const shown = (items ?? []).filter((item) => !only || item.type === only);
  if (!available || shown.length === 0) return null;

  return (
    <section className="video-continue" aria-labelledby="video-continue-title">
      <h2 id="video-continue-title">{t("video.continueWatching")}</h2>
      <ul className="video-continue-list">
        {shown.map((item) => {
          const href = watchHref(item.id);
          const code = item.season !== null && item.episode !== null ? t("video.episodeCode", episodeCodeValues(item.season!, item.episode!)) : null;
          const fraction = item.resume && item.duration ? Math.min(1, item.position / item.duration) : 0;
          const Icon = item.type === "episode" ? Tv : Film;
          return (
            <li key={item.id}>
              <a className="video-continue-card" href={href} onClick={(event) => followRoute(event, href)}>
                <span className="video-continue-cover" aria-hidden="true">
                  <Icon size={20} />
                  <Play size={18} className="video-continue-play" />
                </span>
                <span className="video-continue-copy">
                  <strong>{item.show ? item.show.title : item.title}</strong>
                  <span>
                    {item.show ? [code, item.title].filter(Boolean).join(" · ") : null}
                    {!item.show && item.resume && item.duration ? t("video.continueLeft", { time: formatPlayTime(item.duration - item.position) }) : null}
                    {item.show && !item.resume ? ` · ${t("video.upNextShort")}` : null}
                  </span>
                  {fraction > 0 && (
                    <span className="video-progress" aria-hidden="true">
                      <span style={{ width: `${Math.round(fraction * 100)}%` }} />
                    </span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
