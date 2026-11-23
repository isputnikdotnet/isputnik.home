import { useTranslation } from "react-i18next";
import { Map as MapIcon } from "lucide-react";
import { MessageBox } from "../../../../shared/MessageBox";
import { ControlSectionHead } from "../../ControlSectionHead";
import { MapFeatures } from "./MapFeatures";

// System Settings › Maps: the ONE page the map features are set on. Offline maps and
// place names serve every application that draws a map, so they are not Gallery's;
// sign-in locations and road routes each feed one page, and sit here too so that
// "where are the map settings" has one answer. Each application's page shows how
// the features it uses stand and links here (MapStatusList), with ?from=<app> for
// the way back. Before this the four cards were spread over Gallery › Settings,
// Stories › Settings and Security › Sign-in locations (2026-11-19 to 2026-11-22).
export function MapsSection() {
  const { t } = useTranslation(["control"]);
  return (
    <>
      <ControlSectionHead
        section="maps"
        icon={<MapIcon size={30} />}
        iconClassName="blue"
        description={t("control:mapsPage.description")}
      />
      <MessageBox tone="info" title={t("control:mapsPage.introTitle")}>{t("control:mapsPage.intro")}</MessageBox>
      <MapFeatures />
    </>
  );
}
