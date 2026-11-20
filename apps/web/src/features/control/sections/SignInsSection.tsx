import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, Globe2 } from "lucide-react";
import { ControlSectionHead } from "../ControlSectionHead";
import { SignInsView } from "./dashboard/SignInsView";
import { LocationsView } from "./dashboard/LocationsView";
import { MapFeatures } from "./maps/MapFeatures";
import type { MapSettingsDto } from "./maps/map-settings";

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

// The map, then the setting that places sign-ins on it — the location databases,
// moved here from Gallery › Settings (2026-11-19). When they change, the map is
// read again so it shows what the new database places.
export function SignInLocationsSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const [databases, setDatabases] = useState("");
  const loaded = useCallback((status: MapSettingsDto) => {
    setDatabases(status.locations.databases.map((database) => `${database.name}:${database.sizeBytes}`).join(","));
  }, []);
  return (
    <>
      <ControlSectionHead
        section="signInLocations"
        icon={<Globe2 size={30} />}
        description={t("controlDash:dash.locationsDescription")}
      />
      <LocationsView key={databases} />
      <MapFeatures only={["signIns"]} onLoaded={loaded} />
    </>
  );
}
