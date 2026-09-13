// Free space under a folder field or beside a folder that is in use
// (docs/system-data-plan.md, decision 15): "1.6 TB free of 4 TB", a bar, and a
// flag the caller turns into a warning when less than a tenth is left.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import { formatBytes } from "../../../../shared/utils";

export interface DiskSpace {
  free: number;
  total: number;
}

/** Below this share of free space a folder earns a warning. */
export const LOW_SPACE_SHARE = 0.1;

export const isLowSpace = (space: DiskSpace | null | undefined): boolean =>
  Boolean(space && space.total > 0 && space.free / space.total < LOW_SPACE_SHARE);

/** Free space for a typed folder, asked of the server a moment after typing stops.
 *  Null while the path is empty or not absolute, or the server cannot tell. */
export function useDiskSpace(folder: string): DiskSpace | null {
  const [space, setSpace] = useState<DiskSpace | null>(null);
  useEffect(() => {
    const trimmed = folder.trim();
    // Absolute on either platform: "/x", "C:\x", "\\server\share".
    if (!/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(trimmed)) {
      setSpace(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ space: DiskSpace | null }>(`/api/storage/disk-space?path=${encodeURIComponent(trimmed)}`)
        .then((payload) => { if (!cancelled) setSpace(payload.space); })
        .catch(() => { if (!cancelled) setSpace(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [folder]);
  return space;
}

export function SpaceMeter({ space }: { space: DiskSpace | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  if (!space || space.total <= 0) return null;
  const usedShare = Math.min(1, Math.max(0, 1 - space.free / space.total));
  const low = isLowSpace(space);
  return (
    <div className={`space-meter${low ? " is-low" : ""}`}>
      <span className="space-meter-text">
        {t("controlAdmin:systemData.spaceFree", { free: formatBytes(space.free), total: formatBytes(space.total) })}
      </span>
      <span
        className="space-meter-bar"
        role="meter"
        aria-label={t("controlAdmin:systemData.spaceAria")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usedShare * 100)}
      >
        <span style={{ width: `${usedShare * 100}%` }} />
      </span>
    </div>
  );
}
