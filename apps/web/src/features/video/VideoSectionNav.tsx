import { useTranslation } from "react-i18next";
import { Film, Tv } from "lucide-react";
import { SectionNav } from "../../shared/SectionNav";
import { videoHref } from "./types";

// Video's left nav: Shows and Movies, each a real address.
export function VideoSectionNav({ activeKey }: { activeKey: "shows" | "movies" }) {
  const { t } = useTranslation();
  return (
    <SectionNav
      ariaLabel={t("nav.video")}
      groupLabel={t("nav.video")}
      activeKey={activeKey}
      items={[
        { key: "shows", label: t("video.shows"), href: videoHref("shows"), icon: Tv },
        { key: "movies", label: t("video.movies"), href: videoHref("movies"), icon: Film }
      ]}
    />
  );
}
