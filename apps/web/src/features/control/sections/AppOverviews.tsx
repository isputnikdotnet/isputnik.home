import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity, BookOpen, ChefHat, CheckCircle2, Clapperboard, Clock, Database, FileType, Film, FolderOpen, Gamepad2, Gauge, GitFork, Headphones,
  Heart, Images, Layers, Library, Link2, MapPin, Mic, MonitorPlay, Network, NotebookPen, Pen, Power, Route, Shapes, Sparkles, Tags, Timer, Users
} from "lucide-react";
import { api } from "../../../api";
import { controlHref, controlHrefFrom, diagnosticsPartHref } from "../../../router";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { formatNumber } from "../../../shared/dates";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";
import { appPageHref, librariesHref, storageHref } from "../links";
import { sectionTitle } from "../nav";
import { containerRunning, type ApplicationsData, type ApplicationState, type LibraryType } from "../applications";
import { useDiagnosticsOverview } from "../diagnostics/overview";

// Every application's Overview in Gallery's shape (owner, 2026-11-19): cards of what
// it holds across the top — the ones that list something open it — then whether it
// is in the menu and who may use it, which of its features are on, and its tools;
// beside them where its events and tasks are. Each application says only what it
// has: a library type its libraries and size, a container its connection, Stories
// and the family tree what they hold (their status summaries). Rows still only
// SHOW and LINK; each opens the page that owns the thing.

export interface OverviewProps {
  data: ApplicationsData;
  state: ApplicationState;
  /** Show in the menu, and who may use it (AppVisibility). */
  visibility: ReactNode;
  side: ReactNode;
}

/** The page: cards, then the lists under them, and the side column. */
export function OverviewLayout({ tiles, visibility, side, children }: { tiles: StatTile[]; visibility: ReactNode; side: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation(["control"]);
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
        {children}
      </div>
      <aside className="diag-video-side">{side}</aside>
    </div>
  );
}

const dash = "—";

/** On · Off as a row's value: a pill, green when on. */
function useRowState() {
  const { t } = useTranslation(["control"]);
  return (on: boolean | null | undefined, onText = t("control:appSetup.overview.on"), offText = t("control:appSetup.overview.off")) =>
    on === null || on === undefined ? {} : { value: <span className={`app-overview-tag${on ? " is-ok" : ""}`}>{on ? onText : offText}</span> };
}

/** The cards every application with a status starts with. */
function useCommonTiles() {
  const { t } = useTranslation(["control"]);
  return {
    status: (state: ApplicationState): StatTile => ({
      icon: state.status === "ready" ? <CheckCircle2 size={19} /> : <Power size={19} />,
      iconTone: state.status === "ready" ? "ok" : "warn",
      label: t("control:appSetup.overview.status"),
      value: state.status ? t(`control:appSetup.status.${state.status}`) : dash,
      tone: state.status === "ready" || state.status === "off" ? undefined : "warn"
    }),
    libraries: (state: ApplicationState, type: LibraryType): StatTile => {
      const libraries = state.libraries ?? [];
      const failed = libraries.filter((library) => library.scanStatus === "error").length;
      const scanning = libraries.filter((library) => library.scanStatus === "scanning").length;
      const lastScan = libraries.map((library) => library.lastScannedAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
      return {
        icon: <Library size={19} />, iconTone: failed ? "warn" : "blue",
        label: t("control:appSetup.librariesTitle"),
        value: state.libraries ? String(libraries.length) : dash,
        sub: failed ? t("control:appSetup.overview.scanFailed", { count: failed })
          : scanning ? t("control:appSetup.overview.scanning", { count: scanning })
          : lastScan ? t("control:appSetup.overview.scanned", { when: relativeTime(lastScan, { style: "short" }) }) : undefined,
        tone: failed ? "warn" : undefined,
        href: librariesHref(type)
      };
    },
    onDisk: (state: ApplicationState): StatTile => ({
      icon: <Database size={19} />, iconTone: "gold",
      label: t("control:appSetup.overview.size"),
      value: state.sizeBytes !== null ? formatBytes(state.sizeBytes) : dash,
      sub: t("control:appSetup.overview.sizeSub"),
      href: storageHref()
    })
  };
}

const hours = (seconds: number) => Math.round(seconds / 3600);

// ── Videos ──────────────────────────────────────────────────────────────────────

interface VideoFeatures {
  hasKey: boolean | null;
  detection: boolean | null;
  remoteQuality: number | null | undefined;
  hardware: { encode: boolean; mode: string } | null;
  copiesGb: number | null;
  watching: number | null;
}

/** What the engine says about its settings, read beside the page. */
function useVideoFeatures(prefix: string | null): VideoFeatures {
  const [features, setFeatures] = useState<VideoFeatures>({ hasKey: null, detection: null, remoteQuality: undefined, hardware: null, copiesGb: null, watching: null });
  useEffect(() => {
    if (!prefix) return;
    let active = true;
    const soft = <T,>(promise: Promise<T>) => promise.catch(() => null);
    void Promise.all([
      soft(api<{ hasKey?: boolean }>(`${prefix}/api/admin/metadata`)),
      soft(api<{ enabled?: boolean }>(`${prefix}/api/admin/detection`)),
      soft(api<{ settings?: { remoteQuality?: number | null; hardware?: string }; hardware?: { encode: boolean } | null }>(`${prefix}/api/admin/conversion`)),
      soft(api<{ settings?: { limitGb: number } }>(`${prefix}/api/admin/copies`)),
      soft(api<{ plays?: unknown[] }>(`${prefix}/api/admin/watching`))
    ]).then(([metadata, detection, conversion, copies, watching]) => {
      if (!active) return;
      setFeatures({
        hasKey: typeof metadata?.hasKey === "boolean" ? metadata.hasKey : null,
        detection: typeof detection?.enabled === "boolean" ? detection.enabled : null,
        remoteQuality: conversion?.settings ? conversion.settings.remoteQuality ?? null : undefined,
        hardware: conversion?.hardware ? { encode: conversion.hardware.encode, mode: conversion.settings?.hardware ?? "auto" } : null,
        copiesGb: copies?.settings ? copies.settings.limitGb : null,
        watching: watching?.plays ? watching.plays.length : null
      });
    });
    return () => { active = false; };
  }, [prefix]);
  return features;
}

export function VideosOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const rowState = useRowState();
  const engine = state.container;
  const running = containerRunning(engine);
  const features = useVideoFeatures(running && engine ? engine.prefix : null);
  const titles = state.libraries?.every((library) => library.items !== null)
    ? state.libraries.reduce((sum, library) => sum + (library.items ?? 0), 0) : null;
  const engineText = data.containers === null ? dash
    : running ? t("control:appSetup.connectionOkNoVersion")
    : t(engine?.configured ? "control:appSetup.connectionDown" : "control:appSetup.connectionUnset");

  const tiles: StatTile[] = [
    common.status(state),
    common.libraries(state, "video"),
    { icon: <Film size={19} />, iconTone: "mint", label: t("control:appSetup.overview.titles"), value: titles !== null ? formatNumber(titles) : dash },
    common.onDisk(state),
    {
      icon: <Clapperboard size={19} />, iconTone: running ? "ok" : "warn", label: t("control:appSetup.overview.videoEngine"),
      value: engineText, sub: engine?.server?.version ? `v${engine.server.version}` : undefined, tone: running ? undefined : "warn",
      href: diagnosticsPartHref("video")
    },
    {
      icon: <MonitorPlay size={19} />, iconTone: "rose", label: t("control:appSetup.overview.watching"),
      value: features.watching !== null ? String(features.watching) : dash, href: diagnosticsPartHref("video", "sessions")
    }
  ];
  const quality = features.remoteQuality === undefined ? null
    : features.remoteQuality === null ? t("control:appSetup.overview.qualityOriginal") : t("control:appSetup.overview.qualityUpTo", { height: features.remoteQuality });

  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      {running && (
        <GroupedList title={t("control:appSetup.overview.featuresTitle")} note={t("control:appSetup.overview.featuresNote")}>
          <NavRow summary icon={<Sparkles size={17} />} label={t("control:appSetup.overview.posters")} sub={t("control:appSetup.overview.postersSub")}
            {...rowState(features.hasKey)} href={controlHref("videoSettings")} />
          <NavRow summary icon={<Timer size={17} />} label={t("control:appSetup.overview.skipping")} sub={t("control:appSetup.overview.skippingSub")}
            {...rowState(features.detection)} href={controlHref("videoSettings")} />
          <NavRow summary icon={<Gauge size={17} />} label={t("control:appSetup.overview.quality")} sub={t("control:appSetup.overview.qualitySub")}
            value={quality ?? undefined} href={controlHref("videoSettings")} />
          <NavRow summary icon={<Layers size={17} />} label={t("control:appSetup.overview.conversion")}
            sub={t("control:appSetup.overview.conversionSub")}
            {...rowState(features.hardware ? features.hardware.encode && features.hardware.mode !== "cpu" : null, t("control:appSetup.overview.gpu"), t("control:appSetup.overview.cpu"))}
            href={controlHref("videoSettings")} />
          <NavRow summary icon={<FolderOpen size={17} />} label={t("control:appSetup.overview.copies")} sub={t("control:appSetup.overview.copiesSub")}
            {...rowState(features.copiesGb === null ? null : features.copiesGb > 0, features.copiesGb ? t("control:appSetup.overview.upToGb", { gb: features.copiesGb }) : undefined)}
            href={controlHref("videoSettings")} />
        </GroupedList>
      )}
      <GroupedList title={t("control:nav.workspace.organize")}>
        <NavRow icon={<Shapes size={17} />} label={sectionTitle("genres")} sub={t("control:appSetup.overview.genresSub")} href={controlHref("genres")} />
        <NavRow icon={<MonitorPlay size={17} />} label={t("control:appSetup.overview.liveSessions")} sub={t("control:appSetup.overview.liveSessionsSub")} href={diagnosticsPartHref("video", "sessions")} />
      </GroupedList>
    </OverviewLayout>
  );
}

// ── Ebooks and Audiobooks ──────────────────────────────────────────────────────

/** Book categories and Tags: the lists books are sorted by, shared by both. */
function BookOrganize({ app }: { app: "ebooks" | "audiobooks" }) {
  const { t } = useTranslation(["control"]);
  return (
    <GroupedList title={t("control:nav.workspace.organize")}>
      <NavRow icon={<Shapes size={17} />} label={sectionTitle("categories")} sub={t("control:organization.categoriesBody")} href={controlHrefFrom("categories", app)} />
      <NavRow icon={<Tags size={17} />} label={sectionTitle("tags")} sub={t("control:organization.tagsBody")} href={controlHrefFrom("tags", app)} />
    </GroupedList>
  );
}

export function EbooksOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const stats = data.status?.ebookStats ?? null;
  const formats = [...(stats?.formats ?? [])].sort((a, b) => b.count - a.count);
  const author = stats?.topAuthors[0] ?? null;
  const tiles: StatTile[] = [
    common.status(state),
    common.libraries(state, "ebook"),
    { icon: <BookOpen size={19} />, iconTone: "mint", label: t("control:appSetup.overview.books"), value: stats ? formatNumber(stats.totalBooks) : dash },
    common.onDisk(state),
    {
      icon: <FileType size={19} />, iconTone: "blue", label: t("control:appSetup.overview.formats"),
      value: stats ? String(formats.length) : dash, sub: formats.slice(0, 3).map((format) => format.format).join(" · ") || undefined
    },
    {
      icon: <Pen size={19} />, iconTone: "rose", label: t("control:appSetup.overview.topAuthor"),
      value: author ? author.name : dash, sub: author ? t("control:appSetup.overview.bookCount", { count: author.bookCount }) : undefined
    }
  ];
  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      <BookOrganize app="ebooks" />
    </OverviewLayout>
  );
}

export function AudiobooksOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const stats = data.status?.libraryStats ?? null;
  const narrator = stats?.topNarrators[0] ?? null;
  const tiles: StatTile[] = [
    common.status(state),
    common.libraries(state, "audiobook"),
    { icon: <Headphones size={19} />, iconTone: "mint", label: t("control:appSetup.overview.books"), value: stats ? formatNumber(stats.totalBooks) : dash },
    common.onDisk(state),
    {
      icon: <Clock size={19} />, iconTone: "blue", label: t("control:appSetup.overview.listening"),
      value: stats ? t("control:appSetup.overview.hoursValue", { count: hours(stats.totalDurationSeconds) }) : dash
    },
    {
      icon: <Mic size={19} />, iconTone: "rose", label: t("control:appSetup.overview.topNarrator"),
      value: narrator ? narrator.name : dash, sub: narrator ? t("control:appSetup.overview.bookCount", { count: narrator.bookCount }) : undefined
    }
  ];
  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      <BookOrganize app="audiobooks" />
    </OverviewLayout>
  );
}

// ── Stories ─────────────────────────────────────────────────────────────────────

/** Story settings and road routes, read beside the page. */
function useStoryFeatures() {
  const [features, setFeatures] = useState<{ library: string | null | undefined; recipes: boolean | null; routes: boolean | null }>({ library: undefined, recipes: null, routes: null });
  useEffect(() => {
    let active = true;
    const soft = <T,>(promise: Promise<T>) => promise.catch(() => null);
    void Promise.all([
      soft(api<{ recordingsLibrary?: { name: string } | null; recipeImportEnabled?: boolean }>("/api/stories/settings")),
      soft(api<{ routing?: { hasApiKey: boolean } }>("/api/config/routing"))
    ]).then(([settings, routing]) => {
      if (!active) return;
      setFeatures({
        library: settings ? settings.recordingsLibrary?.name ?? null : undefined,
        recipes: typeof settings?.recipeImportEnabled === "boolean" ? settings.recipeImportEnabled : null,
        routes: routing?.routing ? routing.routing.hasApiKey : null
      });
    });
    return () => { active = false; };
  }, []);
  return features;
}

export function StoriesOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const rowState = useRowState();
  const stats = data.status?.storyStats ?? null;
  const features = useStoryFeatures();
  const tiles: StatTile[] = [
    common.status(state),
    {
      icon: <NotebookPen size={19} />, iconTone: "mint", label: t("control:appSetup.overview.stories"),
      value: stats ? formatNumber(stats.stories) : dash, sub: stats ? t("control:appSetup.overview.published", { count: stats.published }) : undefined,
      href: "/stories"
    },
    { icon: <Pen size={19} />, iconTone: "blue", label: t("control:appSetup.overview.drafts"), value: stats ? formatNumber(stats.stories - stats.published) : dash },
    { icon: <ChefHat size={19} />, iconTone: "gold", label: t("control:appSetup.overview.recipes"), value: stats ? formatNumber(stats.recipes) : dash },
    { icon: <Layers size={19} />, iconTone: "blue", label: t("control:appSetup.overview.collections"), value: stats ? formatNumber(stats.collections) : dash },
    {
      icon: <Mic size={19} />, iconTone: "rose", label: t("control:appSetup.overview.narration"),
      value: stats ? formatNumber(stats.recordings) : dash,
      sub: stats && stats.recordingSeconds > 0 ? t("control:appSetup.overview.minutes", { count: Math.max(1, Math.round(stats.recordingSeconds / 60)) }) : undefined
    }
  ];
  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      <GroupedList title={t("control:appSetup.overview.featuresTitle")} note={t("control:appSetup.overview.featuresNote")}>
        <NavRow summary icon={<Mic size={17} />} label={t("control:appSetup.overview.recordingsTo")}
          sub={t("control:appSetup.overview.recordingsToSub")}
          value={features.library === undefined ? undefined : features.library ?? <span className="app-overview-tag is-warn">{t("control:appSetup.overview.notSet")}</span>}
          href={controlHref("storySettings")} />
        <NavRow summary icon={<ChefHat size={17} />} label={t("control:appSetup.overview.recipeImport")} sub={t("control:appSetup.overview.recipeImportSub")}
          {...rowState(features.recipes)} href={controlHref("storySettings")} />
        <NavRow summary icon={<Route size={17} />} label={t("control:appSetup.overview.roadRoutes")} sub={t("control:appSetup.overview.roadRoutesSub")}
          {...rowState(features.routes)} href={`${controlHref("storySettings")}#road-routes`} />
      </GroupedList>
      <GroupedList title={t("control:appSetup.overview.toolsTitle")}>
        <NavRow icon={<NotebookPen size={17} />} label={t("control:appSetup.storiesOpen")} sub={t("control:appSetup.storiesOpenSub")} href="/stories" />
      </GroupedList>
    </OverviewLayout>
  );
}

// ── Family Tree ─────────────────────────────────────────────────────────────────

export function FamilyTreeOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const stats = data.status?.familyTreeStats ?? null;
  const tiles: StatTile[] = [
    common.status(state),
    { icon: <Users size={19} />, iconTone: "mint", label: t("control:appSetup.overview.people"), value: stats ? formatNumber(stats.people) : dash, href: "/family" },
    { icon: <Heart size={19} />, iconTone: "rose", label: t("control:appSetup.overview.couples"), value: stats ? formatNumber(stats.couples) : dash },
    { icon: <Images size={19} />, iconTone: "blue", label: t("control:appSetup.overview.photos"), value: stats ? formatNumber(stats.photos) : dash },
    { icon: <MapPin size={19} />, iconTone: "gold", label: t("control:appSetup.overview.places"), value: stats ? formatNumber(stats.places) : dash },
    { icon: <BookOpen size={19} />, iconTone: "blue", label: t("control:appSetup.overview.sources"), value: stats ? formatNumber(stats.sources) : dash }
  ];
  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      <GroupedList title={t("control:appSetup.overview.toolsTitle")}>
        <NavRow icon={<GitFork size={17} />} label={t("control:appSetup.familyOpen")} sub={t("control:appSetup.familyBody")} href="/family" />
      </GroupedList>
    </OverviewLayout>
  );
}

// ── Games ───────────────────────────────────────────────────────────────────────

export function GamesOverviewBody({ data, state, visibility, side }: OverviewProps) {
  const { t } = useTranslation(["control"]);
  const common = useCommonTiles();
  const { parts } = useDiagnosticsOverview();
  const part = parts?.find((entry) => entry.id === "games") ?? null;
  const running = containerRunning(state.container);
  const tiles: StatTile[] = [
    common.status(state),
    {
      icon: <Gamepad2 size={19} />, iconTone: running ? "ok" : "warn", label: t("control:appSetup.overview.gamesContainer"),
      value: data.containers === null ? dash : running ? t("control:appSetup.connectionOkNoVersion") : t(state.container?.configured ? "control:appSetup.connectionDown" : "control:appSetup.connectionUnset"),
      sub: state.container?.server?.version ? `v${state.container.server.version}` : undefined, tone: running ? undefined : "warn",
      href: appPageHref("appsSetup", "games")
    },
    {
      icon: <Activity size={19} />, iconTone: "gold", label: t("control:appSetup.overview.requests"),
      value: part?.calls ? formatNumber(part.calls.count) : dash,
      sub: part?.calls ? t("control:appSetup.overview.failed", { count: part.calls.failed }) : undefined,
      tone: part?.calls?.failed ? "warn" : undefined,
      href: diagnosticsPartHref("games")
    }
  ];
  return (
    <OverviewLayout tiles={tiles} visibility={visibility} side={side}>
      <GroupedList title={t("control:appSetup.overview.featuresTitle")}>
        <NavRow summary icon={<Link2 size={17} />} label={t("control:appSetup.guestTitle")} sub={t("control:appSetup.guestBody")} href={`${controlHref("invites")}#games-guest-links`} />
        <NavRow summary icon={<Network size={17} />} label={t("control:appSetup.connectionTitle")} sub={t("control:appSetup.connectionHint.games")}
          value={data.containers === null ? undefined : running ? t("control:appSetup.connectionOkNoVersion") : t(state.container?.configured ? "control:appSetup.connectionDown" : "control:appSetup.connectionUnset")}
          href={appPageHref("appsSetup", "games")} />
      </GroupedList>
    </OverviewLayout>
  );
}
