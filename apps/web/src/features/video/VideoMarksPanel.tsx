import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, formatPlayTime, type VideoMarkScope, type VideoMarkers, type VideoPlayInfo } from "./types";

type Kind = "intro" | "credits";

/** Tenths of a second are as close as anyone marks by eye. */
const tenths = (seconds: number) => Math.round(seconds * 10) / 10;

// Marking by hand (admins; docs/video-skip-plan.md → K2): where the intro starts
// and ends and where the credits start, taken from where the film is now, for this
// episode alone or its whole season. The engine keeps the mark over what the
// file's .edl or chapters say; clearing it puts theirs back. Under the picture
// rather than in a dialog, so the film can be scrubbed to the spot while it is open.
export function VideoMarksPanel({ info, video, onSeek, onMarkers, onClose }: {
  info: VideoPlayInfo;
  video: RefObject<HTMLVideoElement | null>;
  onSeek: (at: number) => void;
  onMarkers: (markers: VideoMarkers) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const markers = info.markers ?? { intro: null, credits: null };
  const isEpisode = info.type === "episode" && info.show !== null && info.season !== null;
  const [scope, setScope] = useState<VideoMarkScope>(
    isEpisode && markers.intro?.scope !== "episode" && markers.credits?.scope !== "episode" ? "season" : "episode"
  );
  const [introStart, setIntroStart] = useState<number | null>(markers.intro?.start ?? null);
  const [introEnd, setIntroEnd] = useState<number | null>(markers.intro?.end ?? null);
  const [creditsStart, setCreditsStart] = useState<number | null>(markers.credits?.start ?? null);
  const [saving, setSaving] = useState<Kind | null>(null);
  const [error, setError] = useState("");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // Where the film is, for the timeline; the element changes with the sound track.
  const element = video.current;
  useEffect(() => {
    if (!element) return;
    const follow = () => {
      setPosition(element.currentTime);
      if (Number.isFinite(element.duration)) setDuration(element.duration);
    };
    follow();
    element.addEventListener("timeupdate", follow);
    element.addEventListener("durationchange", follow);
    return () => {
      element.removeEventListener("timeupdate", follow);
      element.removeEventListener("durationchange", follow);
    };
  }, [element]);

  const here = () => tenths(video.current?.currentTime ?? 0);
  const seek = (at: number | null) => {
    if (at !== null) onSeek(at);
  };

  const send = async (kind: Kind, body: { scope: VideoMarkScope; start: number | null; end?: number | null }) => {
    setSaving(kind);
    setError("");
    try {
      const answer = await api<{ markers: VideoMarkers }>(`${VIDEO_API}/admin/markers/${encodeURIComponent(info.id)}`, {
        method: "PUT",
        body: JSON.stringify({ kind, ...body })
      });
      onMarkers(answer.markers);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.marks.saveFailed"));
    } finally {
      setSaving(null);
    }
  };

  const introReady = introStart !== null && introEnd !== null && introEnd > introStart;
  const band = (from: number, to: number) => duration > 0
    ? { left: `${(from / duration) * 100}%`, width: `${(Math.max(0, Math.min(to, duration) - from) / duration) * 100}%` }
    : undefined;
  /** "Season 2" or "this episode", for the source line. */
  const sourceLabel = (marker: { source: string; scope?: VideoMarkScope } | null) => {
    if (!marker) return t("video.marks.none");
    if (marker.source !== "manual") return t(marker.source === "edl" ? "video.marks.fromEdl" : "video.marks.fromChapters");
    return marker.scope === "season" ? t("video.marks.bySeason", { season: info.season ?? 0 }) : t(isEpisode ? "video.marks.byEpisode" : "video.marks.byFilm");
  };
  const time = (at: number | null) => (at === null ? "—" : formatPlayTime(at));

  return (
    <section className="video-marks" aria-label={t("video.marks.title")}>
      <header className="video-marks-head">
        <strong><Flag size={16} aria-hidden="true" /> {t("video.marks.title")}</strong>
        <Button variant="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <p className="muted">{t("video.marks.hint")}</p>

      {/* The marks as they now stand, over the length of the film. */}
      <div className="video-marks-timeline" aria-hidden="true">
        {markers.intro && <span className="video-marks-band is-intro" style={band(markers.intro.start, markers.intro.end)} />}
        {markers.credits && <span className="video-marks-band is-credits" style={band(markers.credits.start, duration)} />}
        {duration > 0 && <span className="video-marks-now" style={{ left: `${(position / duration) * 100}%` }} />}
      </div>

      {isEpisode && (
        <div className="video-marks-scope" role="tablist" aria-label={t("video.marks.scopeLabel")}>
          <Button variant="tab" selected={scope === "season"} onClick={() => setScope("season")}>
            {t("video.marks.scopeSeason", { season: info.season ?? 0 })}
          </Button>
          <Button variant="tab" selected={scope === "episode"} onClick={() => setScope("episode")}>
            {t("video.marks.scopeEpisode")}
          </Button>
        </div>
      )}

      <div className="video-marks-row">
        <div className="video-marks-label">
          <strong>{t("video.marks.intro")}</strong>
          <small className="muted">{sourceLabel(markers.intro)}</small>
        </div>
        <div className="video-marks-times">
          <span>
            {t("video.marks.starts")}{" "}
            <Button variant="text" disabled={introStart === null} title={t("video.marks.goTo")} onClick={() => seek(introStart)}>{time(introStart)}</Button>
            <Button variant="secondary" compact onClick={() => setIntroStart(here())}>{t("video.marks.here")}</Button>
          </span>
          <span>
            {t("video.marks.ends")}{" "}
            <Button variant="text" disabled={introEnd === null} title={t("video.marks.goTo")} onClick={() => seek(introEnd)}>{time(introEnd)}</Button>
            <Button variant="secondary" compact onClick={() => setIntroEnd(here())}>{t("video.marks.here")}</Button>
          </span>
        </div>
        <div className="video-marks-actions">
          {markers.intro?.source === "manual" && (
            <Button variant="text" disabled={saving !== null} onClick={() => void send("intro", { scope: markers.intro!.scope ?? "episode", start: null })}>
              {t("video.marks.clear")}
            </Button>
          )}
          <Button variant="primary" compact disabled={!introReady || saving !== null} onClick={() => void send("intro", { scope, start: introStart, end: introEnd })}>
            {saving === "intro" ? t("video.marks.saving") : t("video.marks.saveIntro")}
          </Button>
        </div>
      </div>

      <div className="video-marks-row">
        <div className="video-marks-label">
          <strong>{t("video.marks.credits")}</strong>
          <small className="muted">{sourceLabel(markers.credits)}</small>
        </div>
        <div className="video-marks-times">
          <span>
            {t("video.marks.starts")}{" "}
            <Button variant="text" disabled={creditsStart === null} title={t("video.marks.goTo")} onClick={() => seek(creditsStart)}>{time(creditsStart)}</Button>
            <Button variant="secondary" compact onClick={() => setCreditsStart(here())}>{t("video.marks.here")}</Button>
          </span>
        </div>
        <div className="video-marks-actions">
          {markers.credits?.source === "manual" && (
            <Button variant="text" disabled={saving !== null} onClick={() => void send("credits", { scope: markers.credits!.scope ?? "episode", start: null })}>
              {t("video.marks.clear")}
            </Button>
          )}
          <Button variant="primary" compact disabled={creditsStart === null || saving !== null} onClick={() => void send("credits", { scope, start: creditsStart })}>
            {saving === "credits" ? t("video.marks.saving") : t("video.marks.saveCredits")}
          </Button>
        </div>
      </div>

      {error && <MessageBox tone="error" title={t("video.marks.failedTitle")}>{error}</MessageBox>}
    </section>
  );
}
