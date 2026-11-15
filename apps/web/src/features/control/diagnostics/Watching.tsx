import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api";

// What is being watched (engine: GET /video/api/admin/watching, watching.ts and
// hls.ts): every play and download going on — a file played as it is, converted
// video, a copy fetched for offline — with who, what, how, on what device, from
// where, since when, and how far through. Looked at again every few seconds.
// Infrastructure › Now playing draws it (NowPlayingSection); the Video card and
// the Dashboard count it. An engine before it answers 404: nothing is shown.

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
