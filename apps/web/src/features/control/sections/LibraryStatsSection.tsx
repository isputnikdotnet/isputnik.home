import { useTranslation } from "react-i18next";
import { LibraryBig } from "lucide-react";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { LibrariesView } from "./dashboard/LibrariesView";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Overview › Library statistics — was the Dashboard's Libraries view.
export function LibraryStatsSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const { status, error, refresh } = useSystemStatus();

  return (
    <>
      <ControlSectionHead
        section="libraryStats"
        icon={<LibraryBig size={30} />}
        description={t("controlDash:dash.libraryStatsDescription")}
      >
        <RefreshButton onRefresh={refresh} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      {status && <LibrariesView status={status} />}
    </>
  );
}
