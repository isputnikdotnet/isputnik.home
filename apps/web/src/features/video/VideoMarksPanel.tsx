import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, formatPlayTime, type VideoMarkScope, type VideoMarkers, type VideoPlayInfo } from "./types";

type Kind = "recap" | "intro" | "credits";
type Range = { start: number | null; end: number | null };

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
  const markers: VideoMarkers = { recap: null, intro: null, credits: null, ...info.markers };
  const isEpisode = info.type === "episode" && info.show !== null && info.season !== null;
  const [scope, setScope] = useState<VideoMarkScope>(
    isEpisode && markers.intro?.scope !== "episode" && markers.credits?.scope !== "episode" ? "season" : "episode"
  );
  const [recap, setRecap] = useState<Range>({ start: markers.recap?.start ?? null, end: markers.recap?.end ?? null });
  const [intro, setIntro] = useState<Range>({ start: markers.intro?.start ?? null, end: markers.intro?.end ?? null });
  const [creditsStart, setCreditsStart] = useState<number | null>(markers.credits?.start ?? null);
  const [saving, setSaving] = useState<Kind | "detect" | null>(null);
  const [error, setError] = useState("");
  const [lookingAgain, setLookingAgain] = useState(false);
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

  /** The engine looks for this season's intros and credits again, in the background. */
  const findAgain = async () => {
    setSaving("detect");
    setError("");
    try {
      await api(`${VIDEO_API}/admin/markers/${encodeURIComponent(info.id)}/detect`, { method: "POST" });
      setLookingAgain(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.marks.findFailed"));
    } finally {
      setSaving(null);
    }
  };

  const band = (from: number, to: number) => duration > 0
    ? { left: `${(from / duration) * 100}%`, width: `${(Math.max(0, Math.min(to, duration) - from) / duration) * 100}%` }
    : undefined;
  /** "Season 2" or "this episode", for the source line. */
  const sourceLabel = (marker: { source: string; scope?: VideoMarkScope } | null) => {
    if (!marker) return t("video.marks.none");
    if (marker.source === "detected") return t("video.marks.detected");
    if (marker.source !== "manual") return t(marker.source === "edl" ? "video.marks.fromEdl" : "video.marks.fromChapters");
    return marker.scope === "season" ? t("video.marks.bySeason", { season: info.season ?? 0 }) : t(isEpisode ? "video.marks.byEpisode" : "video.marks.byFilm");
  };
  const time = (at: number | null) => (at === null ? "—" : formatPlayTime(at));

  /** A stretch with a start and an end: the recap or the intro. */
  const rangeRow = (kind: "recap" | "intro", draft: Range, setDraft: (next: Range) => void, saveScope: VideoMarkScope) => {
    const marker = markers[kind];
    const ready = draft.start !== null && draft.end !== null && draft.end > draft.start;
    return (
      <div className="video-marks-row">
        <div className="video-marks-label">
          <strong>{t(kind === "recap" ? "video.marks.recap" : "video.marks.intro")}</strong>
          <small className="muted">{marker ? sourceLabel(marker) : t(kind === "recap" ? "video.marks.recapNone" : "video.marks.none")}</small>
        </div>
        <div className="video-marks-times">
          <span>
            {t("video.marks.starts")}{" "}
            <Button variant="text" disabled={draft.start === null} title={t("video.marks.goTo")} onClick={() => seek(draft.start)}>{time(draft.start)}</Button>
            <Button variant="secondary" compact onClick={() => setDraft({ ...draft, start: here() })}>{t("video.marks.here")}</Button>
          </span>
          <span>
            {t("video.marks.ends")}{" "}
            <Button variant="text" disabled={draft.end === null} title={t("video.marks.goTo")} onClick={() => seek(draft.end)}>{time(draft.end)}</Button>
            <Button variant="secondary" compact onClick={() => setDraft({ ...draft, end: here() })}>{t("video.marks.here")}</Button>
          </span>
        </div>
        <div className="video-marks-actions">
          {marker?.source === "manual" && (
            <Button variant="text" disabled={saving !== null} onClick={() => void send(kind, { scope: marker.scope ?? "episode", start: null })}>
              {t("video.marks.clear")}
            </Button>
          )}
          <Button variant="primary" compact disabled={!ready || saving !== null} onClick={() => void send(kind, { scope: saveScope, start: draft.start, end: draft.end })}>
            {saving === kind ? t("video.marks.saving") : t(kind === "recap" ? "video.marks.saveRecap" : "video.marks.saveIntro")}
          </Button>
        </div>
      </div>
    );
  };

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
        {markers.recap && <span className="video-marks-band is-recap" style={band(markers.recap.start, markers.recap.end)} />}
        {markers.intro && <span className="video-marks-band is-intro" style={band(markers.intro.start, markers.intro.end)} />}
        {markers.credits && <span className="video-marks-band is-credits" style={band(markers.credits.start, duration)} />}
        {duration > 0 && <span className="video-marks-now" style={{ left: `${(position / duration) * 100}%` }} />}
      </div>

      {/* A recap is each episode's own length: never a season's mark. */}
      {isEpisode && rangeRow("recap", recap, setRecap, "episode")}

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

      {rangeRow("intro", intro, setIntro, scope)}

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

      <div className="video-marks-row">
        <div className="video-marks-label">
          <strong>{t("video.marks.findTitle")}</strong>
          <small className="muted">{t(isEpisode ? "video.marks.findHintSeason" : "video.marks.findHintFilm")}</small>
        </div>
        <div />
        <div className="video-marks-actions">
          <Button variant="secondary" compact disabled={saving !== null || lookingAgain} onClick={() => void findAgain()}>
            {saving === "detect" ? t("video.marks.finding") : t("video.marks.findAgain")}
          </Button>
        </div>
      </div>
      {lookingAgain && <MessageBox tone="info" title={t("video.marks.findQueuedTitle")}>{t("video.marks.findQueued")}</MessageBox>}

      {error && <MessageBox tone="error" title={t("video.marks.failedTitle")}>{error}</MessageBox>}
    </section>
  );
}
