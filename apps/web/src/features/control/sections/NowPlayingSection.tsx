import { useTranslation } from "react-i18next";
import { Download, Film, MonitorPlay, Smartphone, Tablet, Tv, Wifi, Globe } from "lucide-react";
import { controlHref, followRoute } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { relativeTime } from "../../../shared/relativeTime";
import { ControlSectionHead } from "../ControlSectionHead";
import { useWatching, type MediaSide, type Play, type PlayMedia } from "../diagnostics/Watching";
import { isRunning, useAppsStatus } from "./AppsSection";

// Infrastructure › Now playing: every film and episode being played or
// downloaded right now, a card each, the way Plex's dashboard shows its streams —
// the poster, what it is and how far through, who and on what, Direct Play or
// Transcode (and on the GPU or the CPU), the quality, the bandwidth, home or
// away. From the video engine's GET /admin/watching, looked at again every few
// seconds (diagnostics/Watching.tsx).

const DEVICE_ICON: Record<string, typeof Tv> = { TV: Tv, Phone: Smartphone, Tablet };

/** 1:02:10 — or 4:05 under an hour. */
export function clockOf(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export function NowPlayingSection() {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const running = video ? isRunning(video) : false;
  const { plays, missing } = useWatching(running ? video!.prefix : null);

  return (
    <div className="now-playing">
      <ControlSectionHead section="nowPlaying" icon={<MonitorPlay size={30} />} description={t("controlAdmin:nowPlaying.description")} />

      {apps && !running && (
        <MessageBox tone="info" title={t("controlAdmin:nowPlaying.noVideoTitle")}>{t("controlAdmin:nowPlaying.noVideo")}</MessageBox>
      )}
      <NowPlayingList plays={plays} missing={running && missing} />
    </div>
  );
}

/** The plays as cards, with a line of how many and how much: Now playing's, and
 *  the Live sessions tab of Diagnostics › Video. */
export function NowPlayingList({ plays, missing }: { plays: Play[] | null; missing: boolean }) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const streams = (plays ?? []).filter((play) => play.kind !== "download");
  const converting = streams.filter((play) => play.kind === "converted" && play.converting && play.converter !== null).length;
  const bandwidth = (plays ?? []).reduce((sum, play) => sum + (play.mbps ?? 0), 0);

  return (
    <>
      {missing && (
        <MessageBox tone="info" title={t("controlAdmin:nowPlaying.oldEngineTitle")}>{t("controlAdmin:nowPlaying.oldEngine")}</MessageBox>
      )}

      {plays && (
        <>
          <p className="now-playing-summary">
            <strong>{t("controlAdmin:nowPlaying.streams", { count: streams.length })}</strong>
            {converting > 0 && <span>{t("controlAdmin:nowPlaying.converting", { count: converting })}</span>}
            {bandwidth > 0 && <span>{t("controlAdmin:nowPlaying.bandwidth", { mbps: Math.round(bandwidth * 10) / 10 })}</span>}
          </p>
          {plays.length === 0 ? (
            <div className="empty-state now-playing-empty">
              <MonitorPlay size={44} aria-hidden="true" />
              <p>{t("controlAdmin:nowPlaying.nobody")}</p>
            </div>
          ) : (
            <div className="now-playing-grid">
              {plays.map((play) => <PlayCard key={`${play.kind}-${play.user}-${play.itemId ?? play.title}-${play.since}`} play={play} />)}
            </div>
          )}
        </>
      )}
    </>
  );
}

function PlayCard({ play }: { play: Play }) {
  const { t } = useTranslation(["controlAdmin"]);
  const DeviceIcon = play.kind === "download" ? Download : DEVICE_ICON[play.device ?? ""] ?? MonitorPlay;
  const away = play.network === "internet";

  // Plex's words for how it reaches the player.
  const stream = play.kind === "download"
    ? { label: t("controlAdmin:nowPlaying.stream.download"), tone: "muted" }
    : play.kind === "direct"
      ? { label: t("controlAdmin:nowPlaying.stream.direct"), tone: "ok" }
      : play.kept
        ? { label: t("controlAdmin:nowPlaying.stream.kept"), tone: "ok" }
        : play.converter === null || play.mode === "remux"
          ? { label: t("controlAdmin:nowPlaying.stream.remux"), tone: "ok" }
          : play.converter === "gpu"
            ? { label: t("controlAdmin:nowPlaying.stream.gpu"), tone: "busy" }
            : { label: t("controlAdmin:nowPlaying.stream.cpu"), tone: "warn" };
  const quality = play.rung ? t("controlAdmin:nowPlaying.quality", { height: play.rung }) : play.kind === "direct" ? t("controlAdmin:nowPlaying.original") : null;
  const share = play.positionSeconds != null && play.durationSeconds ? Math.min(100, (play.positionSeconds / play.durationSeconds) * 100) : null;

  return (
    <article className="now-playing-card" aria-label={`${play.user} · ${play.heading ?? play.title}`}>
      {play.backdrop && <img className="now-playing-backdrop" src={play.backdrop} alt="" aria-hidden="true" loading="lazy" />}
      <div className="now-playing-body">
        <div className="now-playing-poster">
          {play.poster ? <img src={play.poster} alt="" loading="lazy" /> : <Film size={30} aria-hidden="true" />}
        </div>
        <div className="now-playing-text">
          <strong className="now-playing-title">{play.heading ?? play.title}</strong>
          {play.subheading && <span className="now-playing-sub">{play.subheading}</span>}
          <span className={`now-playing-badge is-${stream.tone}`}>{stream.label}</span>
          <dl className="now-playing-facts">
            {quality && <div><dt>{t("controlAdmin:nowPlaying.fact.quality")}</dt><dd>{quality}{play.hdr ? ` · ${t("controlAdmin:nowPlaying.hdr")}` : ""}</dd></div>}
            {play.mbps != null && play.mbps > 0 && <div><dt>{t("controlAdmin:nowPlaying.fact.bandwidth")}</dt><dd>{t("controlAdmin:nowPlaying.mbps", { mbps: play.mbps })}</dd></div>}
            {play.shared && <div><dt>{t("controlAdmin:nowPlaying.fact.shared")}</dt><dd>{t("controlAdmin:nowPlaying.sharedValue")}</dd></div>}
          </dl>
        </div>
      </div>
      {play.media && <MediaFacts media={play.media} />}
      <div className="now-playing-progress" aria-hidden={share === null}>
        <div className="now-playing-bar"><span style={{ width: `${share ?? 0}%` }} /></div>
        <span className="now-playing-time">
          {play.positionSeconds != null ? clockOf(play.positionSeconds) : "—"}
          {play.durationSeconds ? ` / ${clockOf(play.durationSeconds)}` : ""}
        </span>
      </div>
      <footer className="now-playing-who">
        <span className="now-playing-user">{play.user}</span>
        <span><DeviceIcon size={15} aria-hidden="true" /> {play.device && play.device !== "Unknown" ? t(`controlAdmin:diagnostics.watching.device.${play.device}` as "controlAdmin:diagnostics.watching.device.TV", { defaultValue: play.device }) : t("controlAdmin:nowPlaying.unknownDevice")}</span>
        <span className={away ? "is-away" : undefined}>
          {away ? <Globe size={15} aria-hidden="true" /> : <Wifi size={15} aria-hidden="true" />} {away ? t("controlAdmin:nowPlaying.away") : t("controlAdmin:nowPlaying.home")}
        </span>
        <span className="muted">{t("controlAdmin:nowPlaying.since", { when: relativeTime(play.since) })}</span>
      </footer>
    </article>
  );
}

/** Codec names as people know them; the rest as the engine says, upper-cased. */
const CODEC: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", av1: "AV1", vp8: "VP8", vp9: "VP9", mpeg2video: "MPEG-2", mpeg4: "MPEG-4", vc1: "VC-1",
  aac: "AAC", ac3: "Dolby Digital", eac3: "Dolby Digital+", truehd: "TrueHD", dts: "DTS", flac: "FLAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", pcm_s16le: "PCM", pcm_s24le: "PCM"
};
const codecName = (codec: string) => CODEC[codec] ?? codec.toUpperCase();

/** "4K", "1080p": by height, or by width for a wide film (3840×1600 is 4K, 1920×800 is 1080p). */
export function resolutionOf(width: number, height: number): string {
  if (width >= 3200 || height >= 2000) return "4K";
  if (height >= 1300) return "1440p";
  if (width >= 1800 || height >= 1000) return "1080p";
  if (width >= 1200 || height >= 700) return "720p";
  return `${height}p`;
}

/** "4K (3840×1600) · HEVC Main 10 · 10-bit · HDR10 · TrueHD 7.1 · MKV · 60 Mbit/s". */
export function useMediaLine() {
  const { t } = useTranslation(["controlAdmin"]);
  const channels = (count: number) =>
    count === 1 ? t("controlAdmin:nowPlaying.media.mono")
      : count === 2 ? t("controlAdmin:nowPlaying.media.stereo")
        : count === 6 ? "5.1" : count === 8 ? "7.1" : t("controlAdmin:nowPlaying.media.channels", { count });
  return (side: MediaSide) => {
    const parts: string[] = [];
    const video = side.video;
    if (video) {
      parts.push(`${resolutionOf(video.width, video.height)} (${video.width}×${video.height})`);
      parts.push([codecName(video.codec), video.profile].filter(Boolean).join(" "));
      if (video.bitDepth && video.bitDepth > 8) parts.push(t("controlAdmin:nowPlaying.media.bits", { bits: video.bitDepth }));
      if (video.hdr) parts.push(video.hdr === "pq" ? "HDR10" : "HLG");
    }
    if (side.audio) parts.push(`${codecName(side.audio.codec)} ${channels(side.audio.channels)}`);
    parts.push(side.container === "hls" ? t("controlAdmin:nowPlaying.media.hls") : side.container.toUpperCase());
    if (side.bitRate) parts.push(t("controlAdmin:nowPlaying.mbps", { mbps: Math.round(side.bitRate / 100_000) / 10 }));
    return parts.join(" · ");
  };
}

/** What the file is, what is sent of it, and why it is converted. */
function MediaFacts({ media }: { media: PlayMedia }) {
  const { t } = useTranslation(["controlAdmin"]);
  const line = useMediaLine();
  const same = media.sent === media.source || media.reasons.length === 0;
  return (
    <dl className="now-playing-media">
      <div><dt>{t("controlAdmin:nowPlaying.media.file")}</dt><dd>{line(media.source)}</dd></div>
      <div><dt>{t("controlAdmin:nowPlaying.media.sent")}</dt><dd>{same ? t("controlAdmin:nowPlaying.media.same") : line(media.sent)}</dd></div>
      {media.reasons.length > 0 && (
        <div>
          <dt>{t("controlAdmin:nowPlaying.media.why")}</dt>
          <dd>{media.reasons.map((reason) => t(`controlAdmin:nowPlaying.media.reason.${reason}`)).join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}

/** "Now playing · 2 watching" for another page: the way to this one. */
export function NowPlayingLink({ count }: { count: number | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  const href = controlHref("nowPlaying");
  return (
    <a className="now-playing-link" href={href} onClick={(event) => followRoute(event, href)}>
      <MonitorPlay size={18} aria-hidden="true" />
      <span>
        <strong>{t("controlAdmin:nowPlaying.linkTitle")}</strong>
        <small>{count === null ? t("controlAdmin:nowPlaying.linkSub") : t("controlAdmin:diagnostics.watching.count", { count })}</small>
      </span>
    </a>
  );
}
