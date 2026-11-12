import { useTranslation } from "react-i18next";
import { LayoutGrid, Shapes, Tags } from "lucide-react";
import { controlHref, controlHrefFrom } from "../../../router";
import { Button } from "../../../shared/Button";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";
import { APPLICATIONS, appDescription, appLabel } from "../nav";
import { applicationState, useApplicationsData } from "../applications";
import { ApplicationStatusPill } from "./AppSetupSection";

export function ApplicationsSection() {
  const { t } = useTranslation(["control"]);
  const { data, error, loading, reload } = useApplicationsData();
  const unavailable = data && APPLICATIONS.some((app) => applicationState(app.key, data).status === "unavailable");
  return (
    <>
      <ControlSectionHead section="applications" icon={<LayoutGrid size={30} />} description={t("control:applications.description")} />
      <div className="grouped-page">
        {(error || unavailable) && <MessageBox tone="warning" title={t("control:appSetup.loadFailed")}>
          <p>{error || t("control:appSetup.unavailableBody")}</p>
          <Button variant="secondary" compact disabled={loading} onClick={() => void reload(true)}>{t(loading ? "control:ui.loading" : "control:ui.retry")}</Button>
        </MessageBox>}
        <GroupedList title={t("control:applications.yourApps")}>
          {APPLICATIONS.filter((app) => app.key !== "shared").map((app) => {
            const Icon = app.icon;
            const state = data ? applicationState(app.key, data) : null;
            return <NavRow key={app.key} summary icon={<Icon size={22} />}
              iconTone={app.key === "videos" || app.key === "stories" ? "rose" : app.key === "ebooks" || app.key === "audiobooks" ? "gold" : app.key === "familyTree" ? "ok" : "blue"}
              label={appLabel(app.key)} sub={appDescription(app.key)} href={controlHref(app.tabs[0].section)}
              value={loading ? t("control:ui.loading") : <ApplicationStatusPill status={state?.status ?? "unavailable"} gap={state?.gap} container={state?.container} />} />;
          })}
        </GroupedList>
        <GroupedList title={t("control:applications.sharedTools")}>
          <NavRow icon={<Tags size={18} />} label={t("control:nav.tabs.tags")} sub={t("control:applications.tagsScope")} href={controlHrefFrom("tags", "shared")} />
          <NavRow icon={<Shapes size={18} />} label={t("control:nav.tabs.categories")} sub={t("control:organization.categoriesAppliesTo")} href={controlHrefFrom("categories", "shared")} />
        </GroupedList>
      </div>
    </>
  );
}
