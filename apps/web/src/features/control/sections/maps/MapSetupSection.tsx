import { useTranslation } from "react-i18next";
import { Map as MapIcon } from "lucide-react";
import { ControlSectionHead } from "../../ControlSectionHead";
import { MapFeatures } from "./MapFeatures";

// Maps — the one page of the Maps group (docs/map-approach-proposal.md, "One Maps page
// of four cards"): offline maps, photo place names, sign-in locations and road
// routes, each a card with a switch. Data and Routing used to be tabs of their
// own; both are cards here now, and their old addresses land on this page.
export function MapSetupSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  return (
    <>
      <ControlSectionHead
        section="mapSetup"
        icon={<MapIcon size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:mapFeatures.headDescription")}
      />
      <MapFeatures />
    </>
  );
}
