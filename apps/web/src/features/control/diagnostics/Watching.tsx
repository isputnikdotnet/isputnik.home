import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api";

// What is being watched (engine: GET /video/api/admin/watching, watching.ts and
// hls.ts): every play and download going on — a file played as it is, converted
// video, a copy fetched for offline — with who, what, how, on what device, from
// where, since when, and how far through. Looked at again every few seconds.
// Diagnostics › Video › Live sessions draws it (NowPlayingList); the Video card and
// the Dashboard count it. An engine before it answers 404: nothing is shown.

export interface MediaVideo {
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  bitDepth: number | null;
  hdr: "pq" | "hlg" | null;
}

export interface MediaSide {
  /** "mkv", "mp4", "webm", "ts", "avi"… or "hls" for converted segments. */
  container: string;
  video: MediaVideo | null;
  audio: { codec: string; channels: number; language: string | null; title?: string | null } | null;
  bitRate: number | null;
}

/** The engine's media-summary.ts. */
export interface PlayMedia {
  source: MediaSide;
  sent: MediaSide;
  reasons: ("container" | "audio" | "video" | "subtitles" | "size")[];
  videoCopied: boolean;
  audioCopied: boolean;
  subtitlesBurned: boolean;
  /** Engine 0.42+: the image subtitle drawn onto the picture. */
  subtitle?: { codec: string; language: string | null; title: string | null; forced: boolean } | null;
}

/** Where a conversion's picture is decoded, tone-mapped, scaled, drawn on and
 *  encoded (engine 0.42+); null for a step it doesn't take. */
export interface Pipeline {
  decode: "gpu" | "cpu" | null;
  tonemap: "gpu" | "cpu" | null;
  scale: "gpu" | "cpu" | null;
  overlay: "gpu" | "cpu" | null;
  encode: "gpu" | "cpu" | null;
}

export interface Play {
  kind: "direct" | "converted" | "download";
  user: string;
  itemId: string | null;
  title: string;
  network: string | null;
  device: string | null;
  since: string;
  /** As it is, and downloads: bytes sent so far. */
  bytes?: number;
  /** Converted: how, and where. */
  mode?: string;
  converter?: "gpu" | "cpu" | null;
  rung?: number | null;
  hdr?: boolean;
  converting?: boolean;
  shared?: boolean;
  kept?: boolean;
  /** Its rate lately, in Mbit/s (as it is, and downloads). */
  mbps?: number;
  /** Engine 0.42+: the file's picture and sound, and what reaches the player
   *  (null for a file played as it is that the engine hasn't probed). */
  media?: PlayMedia | null;
  /** A conversion running now: where each step of it runs. */
  pipeline?: Pipeline | null;
  /** Engine 0.41+, a conversion: how many times faster than real time it is
   *  converting now, from ffmpeg's progress; under 1 is falling behind. */
  speed?: number | null;
  /** For the card: what it is, its pictures, and how far through. */
  type?: "movie" | "episode";
  heading?: string;
  subheading?: string | null;
  poster?: string | null;
  backdrop?: string | null;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
}

const POLL_MS = 5000;

/** The engine's plays, looked at again every few seconds; null for an engine without the route. */
export function useWatching(prefix: string | null) {
  const [plays, setPlays] = useState<Play[] | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    if (!prefix) return;
    try {
      setPlays((await api<{ plays: Play[] }>(`${prefix}/api/admin/watching`)).plays);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [prefix]);
  useEffect(() => {
    void load();
    if (!prefix) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, prefix]);
  return { plays: missing ? null : plays, missing };
}

/** "2 watching", for a card or a tile; nothing for an engine without the route. */
export function useWatchingCount(prefix: string | null): number | null {
  const { plays } = useWatching(prefix);
  return plays ? plays.filter((play) => play.kind !== "download").length : null;
}
