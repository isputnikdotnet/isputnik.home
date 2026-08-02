import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, BookOpen, Headphones, Image } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { controlHref } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";
import type { SystemStatus } from "../types";
import { AudiobookStats } from "./AudiobookStats";
import { EbookStats } from "./EbookStats";
import { GalleryStats } from "./GalleryStats";

// Overview › Statistics. This used to be three tabs — "Audiobook stats",
// "Ebook stats", "Gallery stats" — which meant the tab row grew by one every
// time a media type was added. It's one page with a type filter now, and the
// three panels share the single /api/status call they were each making.
type StatsType = "audiobook" | "ebook" | "gallery";

const STATS_TYPES: { value: StatsType; label: string; icon: ReactNode }[] = [
  { value: "audiobook", label: "Audiobooks", icon: <Headphones size={16} /> },
  { value: "ebook", label: "Ebooks", icon: <BookOpen size={16} /> },
  { value: "gallery", label: "Gallery", icon: <Image size={16} /> }
];

function typeFromUrl(): StatsType {
  const value = new URLSearchParams(window.location.search).get("type");
  return STATS_TYPES.some((entry) => entry.value === value) ? (value as StatsType) : "audiobook";
}

export function StatisticsSection() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");
  const [type, setType] = useState<StatsType>(typeFromUrl);

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setStatus(payload.status);
  };

  useEffect(() => {
    loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to load stats"));
  }, []);

  // Keep the chosen type in the URL so a particular set of numbers can be
  // linked to, without making it a route of its own.
  const chooseType = (next: StatsType) => {
    setType(next);
    const href = next === "audiobook" ? controlHref("stats") : `${controlHref("stats")}?type=${next}`;
    window.history.replaceState({}, "", href);
  };

  return (
    <>
      <ControlSectionHead
        section="stats"
        icon={<BarChart3 size={30} />}
        description="What is in the catalogue, by media type."
      >
        <div className="row-actions">
          <SelectMenu label="Media type" value={type} options={STATS_TYPES} onChange={chooseType} />
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadStatus();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to refresh stats");
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title="Stats error">{error}</MessageBox>}

      {status && type === "audiobook" && <AudiobookStats status={status} />}
      {status && type === "ebook" && <EbookStats status={status} />}
      {status && type === "gallery" && <GalleryStats status={status} />}
    </>
  );
}
