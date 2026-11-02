import { useTranslation } from "react-i18next";
import { Clapperboard, Film, Tv } from "lucide-react";
import { SectionNav } from "../../shared/SectionNav";
import { VIDEO_OVERVIEW_HREF, videoHref } from "./types";

// Video's nav: its front page, Shows and Movies, each a real address.
export function VideoSectionNav({ activeKey }: { activeKey: "overview" | "shows" | "movies" }) {
  const { t } = useTranslation();
  return (
    <SectionNav
      ariaLabel={t("nav.video")}
      groupLabel={t("nav.video")}
      activeKey={activeKey}
      items={[
        { key: "overview", label: t("video.overview"), href: VIDEO_OVERVIEW_HREF, icon: Clapperboard },
        { key: "shows", label: t("video.shows"), href: videoHref("shows"), icon: Tv },
        { key: "movies", label: t("video.movies"), href: videoHref("movies"), icon: Film }
      ]}
    />
  );
}
