import { useTranslation } from "react-i18next";
import { LayoutDashboard } from "lucide-react";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { Overview } from "./dashboard/Overview";
import { useDashboardOverview } from "./dashboard/useDashboardOverview";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Overview › Dashboard: Home and the containers beside it, what needs a look,
// and pointers to the pages that deal with it (docs/dashboard-and-backups-plan.md).
// Until 4.15 this page also carried Sign-ins, Locations, Activity, Libraries and
// Tasks as a second row of views under the tab row. Each is a page of its own now,
// in the group whose question it answers; old ?view= links resolve in the router.
export function DashboardSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const { status, error, refresh } = useSystemStatus();
  const { overview, apps, lastBackup, appErrors, reload } = useDashboardOverview();

  return (
    <>
      <ControlSectionHead
        section="dashboard"
        icon={<LayoutDashboard size={30} />}
        description={t("controlDash:dash.description")}
      >
        <RefreshButton onRefresh={() => Promise.all([refresh(), reload()]).then(() => undefined)} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      {status && <Overview status={status} overview={overview} apps={apps} lastBackup={lastBackup} appErrors={appErrors} />}
    </>
  );
}
