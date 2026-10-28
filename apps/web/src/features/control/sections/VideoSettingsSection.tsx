import { useTranslation } from "react-i18next";
import { Clapperboard } from "lucide-react";
import { controlHref } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";
import { isRunning, useAppsStatus, VideoConversion, VideoMetadata } from "./AppsSection";

// Settings › Video: the video engine's own settings — how it converts films a
// browser cannot play, and where posters and descriptions come from. Both live
// in the engine and are read and saved through the gateway, so the page needs
// the engine answering; it says so instead of drawing empty forms when it isn't.
// They were cards under Apps › Installed until the Apps group was folded in.
export function VideoSettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const { apps, error } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;

  return (
    <>
      <ControlSectionHead
        section="videoSettings"
        icon={<Clapperboard size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:apps.videoSettings.description")}
      />
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{error}</MessageBox>}
      {!apps && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}
      {apps && video && isRunning(video) && (
        <>
          <VideoConversion prefix={video.prefix} />
          <VideoMetadata prefix={video.prefix} />
        </>
      )}
      {apps && (!video || !isRunning(video)) && (
        <MessageBox tone="info" title={t("controlAdmin:apps.videoSettings.unavailableTitle")}>
          {video?.configured ? t("controlAdmin:apps.videoSettings.notAnswering") : t("controlAdmin:apps.videoSettings.notSetUp")}{" "}
          <a href={controlHref(video?.configured ? "dashboard" : "appsSetup")}>
            {video?.configured ? t("controlAdmin:apps.videoSettings.openDashboard") : t("controlAdmin:apps.videoSettings.openSetup")}
          </a>
        </MessageBox>
      )}
    </>
  );
}
