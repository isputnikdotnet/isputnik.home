import { useTranslation } from "react-i18next";
import { Bookmark, Clapperboard } from "lucide-react";
import { SectionNav } from "../../shared/SectionNav";
import { MY_LIST_HREF, VIDEO_OVERVIEW_HREF } from "./types";

// Video's nav: its one page, films and shows together, and My list
// (docs/video-home-rows-plan.md).
export function VideoSectionNav({ active = "video" }: { active?: "video" | "mylist" }) {
  const { t } = useTranslation();
  return (
    <SectionNav
      ariaLabel={t("nav.video")}
      groupLabel={t("nav.video")}
      activeKey={active}
      items={[
        { key: "video", label: t("nav.video"), href: VIDEO_OVERVIEW_HREF, icon: Clapperboard },
        { key: "mylist", label: t("video.myList.title"), href: MY_LIST_HREF, icon: Bookmark }
      ]}
    />
  );
}
