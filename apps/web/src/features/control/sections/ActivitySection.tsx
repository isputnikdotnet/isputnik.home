import { useTranslation } from "react-i18next";
import { LineChart } from "lucide-react";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { ActivityView } from "./dashboard/ActivityView";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Overview › Activity — was the Dashboard's Activity view.
export function ActivitySection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const { status, error, refresh } = useSystemStatus();

  return (
    <>
      <ControlSectionHead
        section="activity"
        icon={<LineChart size={30} />}
        description={t("controlDash:dash.activityDescription")}
      >
        <RefreshButton onRefresh={refresh} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      {status && <ActivityView status={status} />}
    </>
  );
}
