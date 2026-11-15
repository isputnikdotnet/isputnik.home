import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, MonitorPlay, Smartphone, Tablet, Tv } from "lucide-react";
import { api } from "../../../api";
import { GroupedList, InfoRow } from "../../../shared/GroupedList";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";

// Watching now (engine: GET /video/api/admin/watching, watching.ts and hls.ts):
// every play and download going on — a file played as it is, converted video,
// a copy fetched for offline — with who, what, how, on what device, from where
// and since when. Looked at again every few seconds while the page is open.
// An engine before it answers 404, and the group isn't shown.

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

const DEVICE_ICON: Record<string, typeof Tv> = { TV: Tv, Phone: Smartphone, Tablet };

export function WatchingNow({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { plays, missing } = useWatching(prefix);
  if (missing || plays === null) return null;

  const how = (play: Play): string => {
    if (play.kind === "download") return t("controlAdmin:diagnostics.watching.how.download");
    if (play.kind === "direct") return t("controlAdmin:diagnostics.watching.how.direct");
    if (play.kept) return t("controlAdmin:diagnostics.watching.how.kept");
    if (play.mode === "remux" || play.converter === null) return t("controlAdmin:diagnostics.watching.how.remux");
    return play.converter === "gpu" ? t("controlAdmin:diagnostics.watching.how.gpu") : t("controlAdmin:diagnostics.watching.how.cpu");
  };
  const where = (network: string | null) => (network === "internet" ? t("controlAdmin:diagnostics.watching.away") : network ? t("controlAdmin:diagnostics.watching.home") : null);

  return (
    <GroupedList id="watching" title={t("controlAdmin:diagnostics.watching.title", { count: plays.length })} note={t("controlAdmin:diagnostics.watching.note")}>
      {plays.length === 0 && <InfoRow icon={<MonitorPlay size={17} />} iconTone="muted" label={t("controlAdmin:diagnostics.watching.nobody")} />}
      {plays.map((play) => {
        const Icon = play.kind === "download" ? Download : DEVICE_ICON[play.device ?? ""] ?? MonitorPlay;
        const parts = [
          how(play),
          play.rung ? t("controlAdmin:diagnostics.watching.quality", { height: play.rung }) : null,
          play.hdr ? t("controlAdmin:diagnostics.watching.hdr") : null,
          play.shared ? t("controlAdmin:diagnostics.watching.shared") : null,
          play.device && play.device !== "Unknown" ? t(`controlAdmin:diagnostics.watching.device.${play.device}` as "controlAdmin:diagnostics.watching.device.TV", { defaultValue: play.device }) : null,
          where(play.network),
          t("controlAdmin:diagnostics.watching.since", { when: relativeTime(play.since) }),
          play.bytes ? formatBytes(play.bytes) : null
        ].filter(Boolean);
        return (
          <InfoRow
            key={`${play.kind}-${play.user}-${play.itemId ?? play.title}-${play.since}`}
            icon={<Icon size={17} />}
            iconTone={play.converting && play.converter === "cpu" ? "warn" : "ok"}
            label={`${play.user} · ${play.title}`}
            sub={parts.join(" · ")}
          />
        );
      })}
    </GroupedList>
  );
}

/** "2 watching", for a card or a tile; nothing for an engine without the route. */
export function useWatchingCount(prefix: string | null): number | null {
  const { plays } = useWatching(prefix);
  return plays ? plays.filter((play) => play.kind !== "download").length : null;
}
