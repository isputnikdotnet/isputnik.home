import { useTranslation } from "react-i18next";
import { Fingerprint, Globe2 } from "lucide-react";
import { ControlSectionHead } from "../ControlSectionHead";
import { SignInsView } from "./dashboard/SignInsView";
import { LocationsView } from "./dashboard/LocationsView";

// Security › Sign-ins and Security › Sign-in locations — were the Dashboard's
// opening two views. The dive scope stays in the query string (signInsHref).
export function SignInsSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  return (
    <>
      <ControlSectionHead
        section="signIns"
        icon={<Fingerprint size={30} />}
        description={t("controlDash:dash.signInsDescription")}
      />
      <SignInsView />
    </>
  );
}

export function SignInLocationsSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  return (
    <>
      <ControlSectionHead
        section="signInLocations"
        icon={<Globe2 size={30} />}
        description={t("controlDash:dash.locationsDescription")}
      />
      <LocationsView />
    </>
  );
}
