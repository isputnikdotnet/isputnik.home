import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Map as MapIcon, MapPin, Route, ShieldCheck } from "lucide-react";
import { api } from "../../../../api";
import { controlHrefFrom } from "../../../../router";
import { GroupedList, NavRow } from "../../../../shared/GroupedList";
import type { AppKey } from "../../nav";
import { loadMapSettings, type MapSettingsDto, type RoutingDto } from "./map-settings";

// What an application's page says about maps. The map features are set once, on
// System Settings › Maps, because most of them serve several applications; a page
// that draws a map (Gallery, Stories, Family Tree, Sign-in locations) shows how the
// ones it uses stand and links to that page, opened at the feature — it holds no
// switch of its own.

export type MapFeatureKey = "offline" | "places" | "signIns" | "routes";

/** Each feature's card on the Maps page: where search and these rows land. */
export const MAP_FEATURE_ANCHORS: Record<MapFeatureKey, string> = {
  offline: "offline-maps",
  places: "named-places",
  signIns: "sign-in-locations",
  routes: "road-routes"
};

/** The Maps page, at one feature, and — from a workspace — with the way back to it. */
export function mapsHref(feature?: MapFeatureKey | null, from?: AppKey | null): string {
  return `${controlHrefFrom("maps", from)}${feature ? `#${MAP_FEATURE_ANCHORS[feature]}` : ""}`;
}

/** Whether a feature is on, from what the Maps page itself reads. */
export function mapFeatureOn(feature: MapFeatureKey, status: MapSettingsDto, routing: RoutingDto["routing"]): boolean {
  switch (feature) {
    case "offline": return status.settings.cache;
    case "places": return status.places.present || status.places.build.running;
    case "signIns": return status.locations.databases.length > 0;
    case "routes": return routing.hasApiKey;
  }
}

export function MapStatusList({ show, from, onLoaded }: {
  /** The features this page's maps use, in the order to list them. */
  show: MapFeatureKey[];
  /** The workspace the rows are on, so the Maps page offers the way back. */
  from?: AppKey;
  /** What was read, for the page's own cards across the top. */
  onLoaded?: (status: MapSettingsDto, routing: RoutingDto["routing"]) => void;
}) {
  const { t } = useTranslation(["control", "controlAdmin"]);
  const [maps, setMaps] = useState<{ status: MapSettingsDto; routing: RoutingDto["routing"] } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([loadMapSettings(), api<RoutingDto>("/api/config/routing")])
      .then(([status, routes]) => {
        if (!active) return;
        setMaps({ status, routing: routes.routing });
        onLoaded?.(status, routes.routing);
      })
      // The rows still lead to the Maps page, which says what went wrong.
      .catch(() => undefined);
    return () => { active = false; };
  }, [onLoaded]);

  const text: Record<MapFeatureKey, { icon: ReactNode; label: string; sub: string }> = {
    offline: { icon: <MapIcon size={17} />, label: t("controlAdmin:mapFeatures.offlineTitle"), sub: t("controlAdmin:mapFeatures.offlineDescription") },
    places: { icon: <MapPin size={17} />, label: t("controlAdmin:mapFeatures.placesTitle"), sub: t("controlAdmin:mapFeatures.placesDescription") },
    signIns: { icon: <ShieldCheck size={17} />, label: t("controlAdmin:mapFeatures.signInsTitle"), sub: t("controlAdmin:mapFeatures.signInsDescription") },
    routes: { icon: <Route size={17} />, label: t("controlAdmin:mapFeatures.routesTitle"), sub: t("controlAdmin:mapFeatures.routesDescription") }
  };

  return (
    <GroupedList id="maps" title={t("control:settingsPage.mapsTitle")} note={t("control:settingsPage.mapsSharedNote")}>
      {show.map((feature) => {
        const on = maps ? mapFeatureOn(feature, maps.status, maps.routing) : null;
        return (
          <NavRow
            key={feature}
            summary
            icon={text[feature].icon}
            iconTone={on === null ? undefined : on ? "ok" : "muted"}
            label={text[feature].label}
            sub={text[feature].sub}
            value={on === null ? undefined : (
              <span className={`app-overview-tag${on ? " is-ok" : ""}`}>{on ? t("control:appSetup.overview.on") : t("control:appSetup.overview.off")}</span>
            )}
            href={mapsHref(feature, from)}
          />
        );
      })}
    </GroupedList>
  );
}
