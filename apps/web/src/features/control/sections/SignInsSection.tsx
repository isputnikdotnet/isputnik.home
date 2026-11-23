import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, Globe2 } from "lucide-react";
import { ControlSectionHead } from "../ControlSectionHead";
import { SignInsView } from "./dashboard/SignInsView";
import { LocationsView } from "./dashboard/LocationsView";
import { MapStatusList } from "./maps/MapStatusList";
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

// The map, then how the map features it draws on stand — the location databases
// that place sign-ins, offline maps and town names — each a link to System
// Settings › Maps, where they are set (2026-11-22).
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
      <MapStatusList show={["signIns", "offline", "places"]} onLoaded={loaded} />
    </>
  );
}
