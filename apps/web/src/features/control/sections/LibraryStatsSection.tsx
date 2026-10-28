import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { LibraryBig } from "lucide-react";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { LibrariesView, type VideoLibraryStats } from "./dashboard/LibrariesView";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Overview › Library statistics — was the Dashboard's Libraries view. Video's
// libraries come from the Libraries page's own admin list, whose counts are the
// video engine's; a failure there costs the Video numbers, never the page.
export function LibraryStatsSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const { status, error, refresh } = useSystemStatus();
  const [video, setVideo] = useState<VideoLibraryStats | null>(null);
  const loadVideo = useCallback(
    () => api<VideoLibraryStats>("/api/library/video-libraries?manage=1").then(setVideo).catch(() => setVideo(null)),
    []
  );
  useEffect(() => {
    void loadVideo();
  }, [loadVideo]);

  return (
    <>
      <ControlSectionHead
        section="libraryStats"
        icon={<LibraryBig size={30} />}
        description={t("controlDash:dash.libraryStatsDescription")}
      >
        <RefreshButton onRefresh={() => Promise.all([refresh(), loadVideo()]).then(() => undefined)} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      {status && <LibrariesView status={status} video={video} />}
    </>
  );
}
