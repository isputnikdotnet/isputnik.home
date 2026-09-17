import { useTranslation } from "react-i18next";
import { LayoutDashboard } from "lucide-react";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { SystemView } from "./dashboard/SystemView";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Overview › Dashboard: the server's health, and pointers to what needs attention.
// Until 4.15 this page also carried Sign-ins, Locations, Activity, Libraries and
// Tasks as a second row of views under the tab row. Each is a page of its own now,
// in the group whose question it answers; old ?view= links resolve in the router.
export function DashboardSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const { status, dbInfo, error, refresh } = useSystemStatus({ withDbInfo: true });

  return (
    <>
      <ControlSectionHead
        section="dashboard"
        icon={<LayoutDashboard size={30} />}
        description={t("controlDash:dash.description")}
      >
        <RefreshButton onRefresh={refresh} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      {status && <SystemView status={status} dbInfo={dbInfo} />}
    </>
  );
}
