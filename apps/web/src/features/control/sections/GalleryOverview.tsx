import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Activity, CheckCircle2, Copy, Database, Film, ImageOff, Images, Library, ListChecks, Map as MapIcon, Power, ScanFace, ScanSearch, ScrollText, Smartphone, Stethoscope, Tags, Users } from "lucide-react";
import { api } from "../../../api";
import { controlHref, controlHrefFrom, diagnosticsPartHref } from "../../../router";
import { mapsHref } from "./maps/MapStatusList";
import { GroupedList, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { formatNumber } from "../../../shared/dates";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";
import { activityHref, librariesHref, logsHref, storageHref, tasksHref } from "../links";
import { sectionTitle, type AppKey } from "../nav";
import { APP_LOG_PREFIXES, APP_TASK_SCOPE, containerRunning } from "../applications";
import type { OverviewProps } from "./AppOverviews";

// Gallery's Overview, laid out as a Diagnostics part page (owner, 2026-11-19): cards
// of what it holds across the top — Libraries, On disk and Phones open the pages that
// list them — then whether it is in the menu and who may use it, which of its
// features are on, and its Organize tools; on the right its backup and where its
// events and tasks are. It still only SHOWS and LINKS: each row opens the page that
// owns the thing.

type Phone = { lastSeen: string | null; stale: boolean; atLimit: boolean; problem: { current: boolean } | null };

/** What the features rows say; each part null until (or unless) it answers. */
interface Features {
  phones: Phone[] | null;
  /** Phone backup is on once phones have a network and an address to use. */
  phoneBackup: { on: boolean } | null;
  personal: { on: boolean; count: number } | null;
  maps: { offline: boolean; places: boolean } | null;
  /** Search by what a photo shows: on or off, and how far the photos are described. */
  scene: { on: boolean; described: number; photos: number } | null;
}

/** Read beside the page, never needed for it: a failed part is just not shown. */
function useFeatures(): Features {
  const [features, setFeatures] = useState<Features>({ phones: null, phoneBackup: null, personal: null, maps: null, scene: null });
  useEffect(() => {
    let active = true;
    const soft = <T,>(promise: Promise<T>) => promise.catch(() => null);
    // An answer not of the shape expected is as unknown as a failed one.
    void Promise.all([
      soft(api<{ phones?: Phone[] }>("/api/photo-sync/phones")),
      soft(api<{ networks?: unknown[]; address?: string | null }>("/api/photo-sync/networks")),
      soft(api<{ settings?: { enabled: boolean }; libraries?: unknown[] }>("/api/storage/personal-libraries")),
      soft(api<{ settings?: { cache: boolean }; places?: { present: boolean } }>("/api/map/settings")),
      soft(api<{ enabled?: boolean; libraries?: { photos: number; described: number }[] }>("/api/library/gallery/scene/settings"))
    ]).then(([phones, networks, personal, maps, scene]) => {
      if (!active) return;
      setFeatures({
        phones: phones?.phones ?? null,
        phoneBackup: networks?.networks ? { on: networks.networks.length > 0 && Boolean(networks.address) } : null,
        personal: personal?.settings ? { on: personal.settings.enabled, count: personal.libraries?.length ?? 0 } : null,
        maps: maps?.settings ? { offline: maps.settings.cache, places: Boolean(maps.places?.present) } : null,
        scene: typeof scene?.enabled === "boolean" && Array.isArray(scene.libraries)
          ? { on: scene.enabled, described: scene.libraries.reduce((sum, l) => sum + l.described, 0), photos: scene.libraries.reduce((sum, l) => sum + l.photos, 0) }
          : null
      });
    });
    return () => { active = false; };
  }, []);
  return features;
}

export function GalleryOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const { phones, phoneBackup, personal, maps, scene } = useFeatures();
  const gallery = data.status?.galleryStats ?? null;
  const faces = data.status?.faceStats ?? null;
  const libraries = state.libraries ?? [];
  const dash = "—";

  const scanning = libraries.filter((library) => library.scanStatus === "scanning").length;
  const failed = libraries.filter((library) => library.scanStatus === "error").length;
  const lastScan = libraries.map((library) => library.lastScannedAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  const phonesWarn = phones?.filter((phone) => phone.stale || phone.atLimit || phone.problem?.current).length ?? 0;
  const lastBackup = phones?.map((phone) => phone.lastSeen).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  const engineOn = containerRunning(state.container);

  const tiles: StatTile[] = [
    {
      icon: state.status === "ready" ? <CheckCircle2 size={19} /> : <Power size={19} />,
      iconTone: state.status === "ready" ? "ok" : "warn",
      label: t("control:appSetup.overview.status"),
      value: state.status ? t(`control:appSetup.status.${state.status}`) : dash,
      tone: state.status === "ready" || state.status === "off" ? undefined : "warn"
    },
    {
      icon: <Library size={19} />, iconTone: failed ? "warn" : "blue",
      label: t("control:appSetup.librariesTitle"),
      value: state.libraries ? String(libraries.length) : dash,
      sub: failed ? t("control:appSetup.overview.scanFailed", { count: failed })
        : scanning ? t("control:appSetup.overview.scanning", { count: scanning })
        : lastScan ? t("control:appSetup.overview.scanned", { when: relativeTime(lastScan, { style: "short" }) }) : undefined,
      tone: failed ? "warn" : undefined,
      href: librariesHref("gallery")
    },
    {
      icon: <Images size={19} />, iconTone: "mint",
      label: t("control:appSetup.overview.photos"),
      value: gallery ? formatNumber(gallery.totalPhotos) : dash,
      sub: gallery ? t("control:appSetup.overview.videosCount", { count: gallery.totalVideos, formatted: formatNumber(gallery.totalVideos) }) : undefined
    },
    {
      // The same figure as Storage's "Library media": the shared App files library
      // is not Gallery's media, though /api/status counts it among gallery libraries.
      icon: <Database size={19} />, iconTone: "gold",
      label: t("control:appSetup.overview.size"),
      value: state.sizeBytes !== null ? formatBytes(state.sizeBytes) : dash,
      sub: t("control:appSetup.overview.sizeSub"),
      href: storageHref()
    },
    {
      icon: <Users size={19} />, iconTone: "blue",
      label: t("control:appSetup.overview.people"),
      value: faces ? formatNumber(faces.people) : dash,
      sub: faces ? (faces.enabled ? t("control:appSetup.overview.faces", { count: faces.faces }) : t("control:appSetup.overview.facesOff")) : undefined
    },
    {
      icon: <Smartphone size={19} />, iconTone: phonesWarn ? "warn" : "mint",
      label: t("control:appSetup.overview.phones"),
      value: phones ? String(phones.length) : dash,
      sub: phonesWarn ? t("control:appSetup.overview.phonesWarn", { count: phonesWarn })
        : lastBackup ? t("control:appSetup.overview.phonesLast", { when: relativeTime(lastBackup, { style: "short" }) })
        : phones?.length === 0 ? t("control:appSetup.overview.phonesNone") : undefined,
      tone: phonesWarn ? "warn" : undefined,
      href: controlHref("phoneSync")
    }
  ];

  /** On · Off as a row's value: a pill, green when on (the old Overview banner's tag). */
  const rowState = (on: boolean | null | undefined, onText = t("control:appSetup.overview.on"), offText = t("control:appSetup.overview.off")) =>
    on === null || on === undefined ? {} : { value: <span className={`app-overview-tag${on ? " is-ok" : ""}`}>{on ? onText : offText}</span> };
  const engineText = data.containers === null ? null
    : engineOn ? t("control:appSetup.connectionOkNoVersion")
    : t(state.container?.configured ? "control:appSetup.connectionDown" : "control:appSetup.connectionUnset");

  return (
    <div className="diag-video app-overview-v3">
      <div className="diag-video-main">
        <section className="diag-tiles" aria-labelledby="app-overview-tiles-title">
          <header className="diag-tiles-head">
            <h3 id="app-overview-tiles-title">{t("control:appSetup.overview.tilesTitle")}</h3>
          </header>
          <StatTiles tiles={tiles} label={t("control:appSetup.overview.tilesTitle")} />
        </section>

        {visibility}

        {/* What is switched on and what is not: ONE row per page it is switched on
            (owner, 2026-11-19) — Device Sync holds phone backup and personal
            libraries, Maps holds offline maps and place names. */}
        <GroupedList title={t("control:appSetup.overview.featuresTitle")} note={t("control:appSetup.overview.featuresNote")}>
          <NavRow summary icon={<Smartphone size={17} />} label={t("control:appSetup.overview.phoneBackup")}
            sub={personal ? (personal.on ? t("control:appSetup.overview.personalOn", { count: personal.count }) : t("control:appSetup.overview.personalOff"))
              : t("control:appSetup.cards.deviceSyncSub")}
            {...rowState(phoneBackup?.on)} href={controlHref("phoneSync")} />
          <NavRow summary icon={<ScanFace size={17} />} label={t("control:appSetup.overview.faceRecognition")}
            sub={engineText ? t("control:appSetup.overview.faceEngine", { state: engineText }) : t("control:appSetup.connectionHint.faces")}
            {...rowState(faces ? faces.enabled && engineOn : null)} href={`${controlHref("recognition")}#recognition-faces`} />
          <NavRow summary icon={<ScanSearch size={17} />} label={t("control:appSetup.overview.sceneSearchTitle")}
            sub={scene?.on ? t("control:appSetup.overview.sceneSearchOn", { described: formatNumber(scene.described), total: formatNumber(scene.photos) })
              : t("control:appSetup.overview.sceneSearchOff")}
            {...rowState(scene?.on)} href={`${controlHref("recognition")}#recognition-search`} />
          <NavRow summary icon={<MapIcon size={17} />} label={t("control:appSetup.overview.offlineMaps")}
            sub={maps ? t(maps.places ? "control:appSetup.overview.placesOn" : "control:appSetup.overview.placesOff") : t("control:appSetup.overview.offlineMapsSub")}
            {...rowState(maps?.offline)} href={mapsHref("offline", "gallery")} />
        </GroupedList>

        {/* Organize's tools: Gallery has no Organize tab, these are pages under here. */}
        <GroupedList title={t("control:nav.workspace.organize")}>
          <NavRow icon={<Copy size={17} />} label={sectionTitle("duplicateCleanup")} sub={t("control:appSetup.overview.duplicatesSub")} href={controlHref("duplicateCleanup")} />
          <NavRow icon={<ImageOff size={17} />} label={sectionTitle("missingPhotos")} sub={t("control:appSetup.overview.missingSub")} href={controlHref("missingPhotos")} />
          <NavRow icon={<Film size={17} />} label={sectionTitle("videoStreaming")} sub={t("control:appSetup.cards.streamingSub")} href={controlHref("videoStreaming")} />
          <NavRow icon={<Tags size={17} />} label={sectionTitle("tags")} sub={t("control:appSetup.overview.tagsSub")} href={controlHrefFrom("tags", "gallery")} />
        </GroupedList>
      </div>
      <aside className="diag-video-side">{side}</aside>
    </div>
  );
}

/** Whether an application is in the menu, and who may use it: the main column's
 *  first list on a workspace's Overview. */
export function AppVisibility({ name, menu, access }: {
  name: string;
  /** The Show-in-menu switch, when the application has one. */
  menu: { checked: boolean; disabled: boolean; onChange: (next: boolean) => void } | null;
  access: ReactNode;
}) {
  const { t } = useTranslation(["control"]);
  return (
    <GroupedList title={t("control:appSetup.cards.accessTitle")} note={menu ? t("control:appSetup.menuHint") : undefined}>
      {menu && (
        <ToggleRow
          label={t("control:appSetup.menuSwitch", { app: name })}
          sub={t("control:appSetup.cards.menuSwitchSub", { app: name })}
          checked={menu.checked}
          disabled={menu.disabled}
          onChange={menu.onChange}
        />
      )}
      {access}
    </GroupedList>
  );
}

/** The right-hand column of a workspace's Overview: its events, tasks and logs —
 *  each narrowed to this application. No Backup (owner, 2026-11-19): what is backed
 *  up is a server's or a container's, not an application's. */
export function AppOverviewSide({ app, name }: { app: Exclude<AppKey, "shared">; name: string }) {
  const { t } = useTranslation(["control"]);
  return (
    <>
      {APP_LOG_PREFIXES[app] && (
        <GroupedList title={t("control:appSetup.activityTitle")} note={t("control:appSetup.overview.eventsNote", { app: name })}>
          <NavRow icon={<Activity size={17} />} label={t("control:appSetup.activityLink")} href={activityHref({ application: app })} />
          {APP_TASK_SCOPE[app] && <NavRow icon={<ListChecks size={17} />} label={t("control:appSetup.tasksLink")} href={tasksHref({ application: app })} />}
          <NavRow icon={<ScrollText size={17} />} label={t("control:appSetup.logsLink")} href={logsHref({ application: app })} />
          <NavRow icon={<Stethoscope size={17} />} label={sectionTitle("diagnostics")} href={diagnosticsPartHref("home")} />
        </GroupedList>
      )}
    </>
  );
}
