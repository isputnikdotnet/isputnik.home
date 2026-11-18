import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react";
import { FormatChip } from "../diagnostics/FormatChip";
import type { MediaSide, Pipeline, Play, PlayMedia } from "../diagnostics/Watching";

// A stream card's Video, Audio and Subtitles (Now playing, and Diagnostics › Video's
// Live sessions), the way Plex's dashboard lays them out: what the file has, what
// the player gets of it, and each step on the way as a chip — lit where the GPU
// does it, filled where the CPU does, an outline where it is copied as it is.
// From the engine's media summary (media-summary.ts, 0.42+).

/** Codec names as people know them; the rest as the engine says, upper-cased. */
const CODEC: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", av1: "AV1", vp8: "VP8", vp9: "VP9", mpeg2video: "MPEG-2", mpeg4: "MPEG-4", vc1: "VC-1",
  aac: "AAC", ac3: "Dolby Digital", eac3: "Dolby Digital+", truehd: "TrueHD", dts: "DTS", flac: "FLAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis",
  pcm_s16le: "PCM", pcm_s24le: "PCM",
  hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub", dvb_subtitle: "DVB", subrip: "SRT", ass: "ASS", mov_text: "Timed text", webvtt: "WebVTT"
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

/** "eng" → "English", in the page's language; the code itself where the browser can't say. */
function languageName(code: string | null, locale: string): string | null {
  if (!code || code === "und") return null;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const join = (parts: (string | number | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

export function PlayStreams({ play, media }: { play: Play; media: PlayMedia }) {
  const { t, i18n } = useTranslation(["controlAdmin"]);
  const pipeline = play.pipeline ?? null;
  const direct = media.reasons.length === 0;
  const onGpu = t("controlAdmin:diagnostics.video.hw.onGpu");
  const onCpu = t("controlAdmin:diagnostics.video.hw.onCpu");
  const copied = t("controlAdmin:nowPlaying.media.copied");

  const channels = (count: number) =>
    count === 1 ? t("controlAdmin:nowPlaying.media.mono")
      : count === 2 ? t("controlAdmin:nowPlaying.media.stereo")
        : count === 6 ? "5.1" : count === 8 ? "7.1" : t("controlAdmin:nowPlaying.media.channels", { count });
  const videoLine = (side: MediaSide, withDetail: boolean) => {
    const video = side.video!;
    return join([
      `${resolutionOf(video.width, video.height)} (${codecName(video.codec)}${withDetail && video.profile ? ` ${video.profile}` : ""})`,
      withDetail && video.bitDepth && video.bitDepth > 8 && t("controlAdmin:nowPlaying.media.bits", { bits: video.bitDepth }),
      video.hdr && (video.hdr === "pq" ? "HDR10" : "HLG"),
      withDetail && `${video.width}×${video.height}`
    ]);
  };
  const audioLine = (side: MediaSide, withName: boolean) => {
    const audio = side.audio!;
    return join([withName && (languageName(audio.language, i18n.language) ?? audio.title), `${codecName(audio.codec)} ${channels(audio.channels)}`]);
  };

  /** A step of the picture's conversion: where it runs, or nothing when it isn't taken. */
  const step = (key: keyof Pipeline) => {
    const where = pipeline?.[key];
    if (!where) return null;
    const label = t(`controlAdmin:nowPlaying.media.step.${key}`);
    return <FormatChip key={key} tone={where} label={label} title={where === "gpu" ? onGpu : onCpu} />;
  };
  const copyChip = (title: string) => <FormatChip tone="copy" label={copied} title={title} />;
  const sentTo = (text: string) => (
    <span className="now-playing-to"><CornerDownRight size={14} aria-hidden="true" />{text}</span>
  );

  return (
    <div className="now-playing-streams">
      {media.source.video && (
        <StreamRow kind={t("controlAdmin:nowPlaying.media.video")} from={videoLine(media.source, true)}>
          {direct || media.videoCopied ? sentTo(t("controlAdmin:nowPlaying.media.same")) : sentTo(videoLine(media.sent, false))}
          <ul className="format-chips">
            {direct || media.videoCopied
              ? copyChip(t("controlAdmin:nowPlaying.media.copiedVideo"))
              : pipeline
                ? (["decode", "tonemap", "scale", "encode"] as const).map(step)
                : <FormatChip tone="off" label={t("controlAdmin:nowPlaying.media.ready")} title={t("controlAdmin:nowPlaying.media.readyHelp")} />}
          </ul>
        </StreamRow>
      )}
      {media.source.audio && media.sent.audio && (
        <StreamRow kind={t("controlAdmin:nowPlaying.media.audio")} from={audioLine(media.source, true)}>
          {direct || media.audioCopied ? sentTo(t("controlAdmin:nowPlaying.media.same")) : sentTo(audioLine(media.sent, false))}
          <ul className="format-chips">
            {direct || media.audioCopied
              ? copyChip(t("controlAdmin:nowPlaying.media.copiedAudio"))
              : <FormatChip tone="cpu" label={t("controlAdmin:nowPlaying.media.step.encode")} title={onCpu} />}
          </ul>
        </StreamRow>
      )}
      {media.subtitle && (
        <StreamRow
          kind={t("controlAdmin:nowPlaying.media.subtitles")}
          from={join([
            languageName(media.subtitle.language, i18n.language) ?? media.subtitle.title,
            codecName(media.subtitle.codec),
            media.subtitle.forced && t("controlAdmin:nowPlaying.media.forced")
          ])}
        >
          {sentTo(t("controlAdmin:nowPlaying.media.burnedIn"))}
          {pipeline?.overlay && <ul className="format-chips">{step("overlay")}</ul>}
        </StreamRow>
      )}
      <StreamRow kind={t("controlAdmin:nowPlaying.media.container")} from={join([media.source.container.toUpperCase(), media.source.bitRate && t("controlAdmin:nowPlaying.mbps", { mbps: Math.round(media.source.bitRate / 100_000) / 10 })])}>
        {direct ? sentTo(t("controlAdmin:nowPlaying.media.same")) : sentTo(media.sent.container === "hls" ? t("controlAdmin:nowPlaying.media.hls") : media.sent.container.toUpperCase())}
        {!direct && (
          <span className="now-playing-why">
            {t("controlAdmin:nowPlaying.media.why")} {media.reasons.map((reason) => t(`controlAdmin:nowPlaying.media.reason.${reason}`)).join(", ")}
          </span>
        )}
      </StreamRow>
    </div>
  );
}

function StreamRow({ kind, from, children }: { kind: string; from: string; children: ReactNode }) {
  return (
    <section className="now-playing-stream">
      <span className="now-playing-kind">{kind}</span>
      <div className="now-playing-stream-body">
        <span className="now-playing-from">{from}</span>
        {children}
      </div>
    </section>
  );
}

