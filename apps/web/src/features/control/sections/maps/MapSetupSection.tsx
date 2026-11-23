import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Folder, HardDrive, Map as MapIcon, MapPin } from "lucide-react";
import { GroupedList, InfoRow, NavRow } from "../../../../shared/GroupedList";
import { StatTiles, type StatTile } from "../../../../shared/StatTiles";
import { formatNumber } from "../../../../shared/dates";
import { relativeTime } from "../../../../shared/relativeTime";
import { formatBytes } from "../../../../shared/utils";
import { ControlSectionHead } from "../../ControlSectionHead";
import { storageHref } from "../../links";
import { PhotoInboxCard } from "../storage/PhotoInboxCard";
import { MapStatusList } from "./MapStatusList";
import type { MapSettingsDto, RoutingDto } from "./map-settings";

// Gallery's Settings tab, laid out as its Overview (owner, 2026-11-19): cards of
// what is kept across the top, then the Photo Inbox and, under Maps, how offline
// maps and photo place names stand — and beside them where map data lives. The
// map features themselves are set on System Settings › Maps (2026-11-22): they
// serve Stories, Family Tree and the sign-in map too, so the rows here link there.
export function MapSetupSection() {
  const { t } = useTranslation(["common", "control", "controlAdmin"]);
  const [maps, setMaps] = useState<{ status: MapSettingsDto; routing: RoutingDto["routing"] } | null>(null);
  const loaded = useCallback((status: MapSettingsDto, routing: RoutingDto["routing"]) => setMaps({ status, routing }), []);

  const dash = "—";
  const on = t("control:appSetup.overview.on");
  const off = t("control:appSetup.overview.off");
  const status = maps?.status ?? null;
  const keptBytes = status ? status.cache.bytes + status.places.sizeBytes : null;

  const tiles: StatTile[] = [
    {
      icon: <MapIcon size={19} />, iconTone: status?.settings.cache ? "ok" : "blue",
      label: t("controlAdmin:mapFeatures.offlineTitle"),
      value: status ? (status.settings.cache ? on : off) : dash,
      sub: status?.settings.cache ? t("control:settingsPage.ofLimit", { used: formatBytes(status.cache.bytes), limit: formatBytes(status.cache.limitBytes) }) : undefined
    },
    {
      icon: <MapPin size={19} />, iconTone: status?.places.present ? "ok" : "blue",
      label: t("controlAdmin:mapFeatures.placesTitle"),
      value: status ? (status.places.present ? formatNumber(status.places.places) : off) : dash,
      // Villages are part of the same list: said under it rather than a card of their own.
      sub: status?.places.present
        ? (status.places.villages ? t("control:settingsPage.andVillages", { villages: formatNumber(status.places.villages) })
          : status.places.builtAt ? t("control:settingsPage.built", { when: relativeTime(status.places.builtAt, { style: "short" }) }) : undefined)
        : undefined
    },
    {
      icon: <Database size={19} />, iconTone: "gold",
      label: t("control:settingsPage.mapData"),
      value: keptBytes !== null ? formatBytes(keptBytes) : dash,
      sub: t("control:settingsPage.mapDataSub"),
      href: storageHref("app-storage")
    }
  ];

  return (
    <>
      <ControlSectionHead
        section="mapSetup"
        icon={<MapIcon size={30} />}
        iconClassName="blue"
        title={t("controlAdmin:photoInboxCard.pageTitle")}
        description={t("controlAdmin:photoInboxCard.pageDescription")}
      />
      <div className="diag-video app-overview-v3">
        <div className="diag-video-main">
          <section className="diag-tiles" aria-labelledby="gallery-settings-tiles-title">
            <header className="diag-tiles-head">
              <h3 id="gallery-settings-tiles-title">{t("control:appSetup.overview.tilesTitle")}</h3>
            </header>
            <StatTiles tiles={tiles} label={t("control:appSetup.overview.tilesTitle")} />
          </section>
          <PhotoInboxCard plain />
          <MapStatusList show={["offline", "places"]} from="gallery" onLoaded={loaded} />
        </div>
        <aside className="diag-video-side">
          {/* Where all of it is kept: App storage's Map data, moved from Storage. */}
          <GroupedList title={t("control:settingsPage.whereTitle")} note={t("control:settingsPage.whereNote")}>
            <InfoRow icon={<Folder size={17} />} label={t("control:settingsPage.folder")} sub={status?.cache.folder ?? t("control:ui.loading")} />
            <NavRow icon={<HardDrive size={17} />} label={t("control:settingsPage.change")} href={storageHref("app-storage")} />
          </GroupedList>
        </aside>
      </div>
    </>
  );
}
