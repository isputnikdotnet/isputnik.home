import { useTranslation } from "react-i18next";
import { Clapperboard } from "lucide-react";
import { SectionNav } from "../../shared/SectionNav";
import { VIDEO_OVERVIEW_HREF } from "./types";

// Video's nav: its one page, films and shows together (docs/video-home-rows-plan.md).
// My list joins it when there is one.
export function VideoSectionNav() {
  const { t } = useTranslation();
  return (
    <SectionNav
      ariaLabel={t("nav.video")}
      groupLabel={t("nav.video")}
      activeKey="video"
      items={[{ key: "video", label: t("nav.video"), href: VIDEO_OVERVIEW_HREF, icon: Clapperboard }]}
    />
  );
}
