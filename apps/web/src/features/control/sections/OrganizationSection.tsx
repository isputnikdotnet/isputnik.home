import { useTranslation } from "react-i18next";
import { Copy, Film, ImageOff, Shapes, Tags, Wrench } from "lucide-react";
import { controlHref, controlHrefFrom, type ControlSection } from "../../../router";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { SettingsCard } from "../../../shared/SettingsCard";
import { ControlSectionHead } from "../ControlSectionHead";
import { appLabel } from "../nav";

type OrganizeApp = "gallery" | "ebooks" | "audiobooks";
const ORGANIZE_SECTION: Record<OrganizeApp, ControlSection> = {
  gallery: "galleryOrganize", ebooks: "ebooksOrganize", audiobooks: "audiobooksOrganize"
};

// Maintenance actions live in their editors; the workspace is a short directory of
// cards — the shared lists (categories, tags), and Gallery's clean-up pages.
export function AppOrganizeSection({ app }: { app: OrganizeApp }) {
  const { t } = useTranslation(["control"]);
  return <>
    <ControlSectionHead section={ORGANIZE_SECTION[app]} icon={<Tags size={30} />} description={t("control:organization.appDescription", { app: appLabel(app) })} />
    <div className="settings-card-grid">
      <SettingsCard icon={<Tags size={20} />}
        title={t(app === "gallery" ? "control:organization.sharedListsTitle" : "control:organization.sharedCardTitle")}
        description={t("control:organization.sharedCardBody", { app: appLabel(app) })}
        note={t("control:organization.sharedNote")}>
      <GroupedList>
        {app !== "gallery" && <NavRow icon={<Shapes size={18} />} label={t("control:nav.tabs.categories")}
          sub={t("control:organization.categoriesBody")} href={controlHrefFrom("categories", app)} />}
        <NavRow icon={<Tags size={18} />} label={t("control:nav.tabs.tags")}
          sub={t("control:organization.tagsBody")} href={controlHrefFrom("tags", app)} />
      </GroupedList>
      </SettingsCard>
      {app === "gallery" && <SettingsCard icon={<Wrench size={20} />} title={t("control:organization.cleanupTitle")} description={t("control:organization.cleanupBody")}>
      <GroupedList>
        <NavRow icon={<Copy size={18} />} label={t("control:nav.tabs.duplicateCleanup")} sub={t("control:organization.duplicatesBody")} href={controlHref("duplicateCleanup")} />
        <NavRow icon={<ImageOff size={18} />} label={t("control:nav.tabs.missingPhotos")} sub={t("control:organization.missingBody")} href={controlHref("missingPhotos")} />
        <NavRow icon={<Film size={18} />} label={t("control:nav.tabs.videoStreaming")} sub={t("control:organization.videoStreamingBody")} href={controlHref("videoStreaming")} />
      </GroupedList>
      </SettingsCard>}
    </div>
  </>;
}
