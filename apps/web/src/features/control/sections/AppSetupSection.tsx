import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, BarChart3, Database, Layers, Library, Link2, Settings2, Users } from "lucide-react";
import { controlHref, followRoute, followReplace, type ControlSection } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { NavRow } from "../../../shared/GroupedList";
import { Button } from "../../../shared/Button";
import { formatBytes } from "../../../shared/utils";
import { SECTION_KEYS } from "../../../app/sections";
import { ControlSectionHead } from "../ControlSectionHead";
import { activityHref, appPageHref, librariesHref } from "../links";
import { AppOverviewSide, AppVisibility, GalleryOverviewBody } from "./GalleryOverview";
import { AudiobooksOverviewBody, EbooksOverviewBody, FamilyTreeOverviewBody, GamesOverviewBody, StoriesOverviewBody, VideosOverviewBody, type OverviewProps } from "./AppOverviews";
import { APPLICATIONS, appDescription, appLabel, type AppKey } from "../nav";
import {
  APP_LOG_PREFIXES,
  APP_PARTS,
  applicationState,
  containerRunning,
  useApplicationsData,
  type ApplicationState,
  type ApplicationStatus
} from "../applications";

// An application's Overview tab: since 2026-11-19 in the Diagnostics shape, one body
// per application (AppOverviews.tsx, Gallery's in GalleryOverview.tsx) — cards across
// the top, its menu switch and access, what is on, its tools, and the shared side
// column; a banner only when something is missing. Is it on, does it work, and what it is made of. It SHOWS its libraries, connection, access and storage
// and LINKS to their owners — Libraries & Scanning, Infrastructure, Security &
// Members, System Settings — rather than editing them here. The one switch it does
// own is whether the application is in the menu, which was Appearance's Sections
// card until v2.

export const SETUP_SECTION: Record<Exclude<AppKey, "shared">, ControlSection> = {
  gallery: "gallerySetup",
  videos: "videosSetup",
  ebooks: "ebooksSetup",
  audiobooks: "audiobooksSetup",
  stories: "storiesSetup",
  familyTree: "familyTreeSetup",
  games: "gamesSetup"
};

/** Ready · Needs setup · Turned off, as a small pill. */
export function ApplicationStatusPill({ status, gap, container }: {
  status: ApplicationStatus | null;
  gap?: ApplicationState["gap"];
  container?: ApplicationState["container"];
}) {
  const { t } = useTranslation(["control"]);
  if (!status) return null;
  const label = status === "needsSetup" && gap === "libraries" ? t("control:appSetup.noLibraries")
    : status === "needsSetup" && gap === "connection" ? t(container?.configured ? "control:appSetup.serviceUnavailable" : "control:appSetup.notConnected")
    : t(`control:appSetup.status.${status}`);
  return <span className={`app-status-pill is-${status}`}>{label}</span>;
}

/** The summary's parts — libraries, size, connection — each with what it is. */
type SummaryPart = { kind: "libraries" | "size" | "connection"; text: string; tone?: "warn" };
function useSummaryParts() {
  const { t } = useTranslation(["control"]);
  return (key: AppKey, state: ApplicationState): SummaryPart[] => {
    const parts: SummaryPart[] = [];
    if (state.libraries) parts.push({ kind: "libraries", text: t("control:appSetup.summaryLibraries", { count: state.libraries.length }) });
    if (state.sizeBytes !== null && state.sizeComplete) parts.push({ kind: "size", text: formatBytes(state.sizeBytes) });
    // Only a container it cannot work without: Gallery's face engine is optional.
    if (state.status !== "unavailable" && APP_PARTS[key].container && !APP_PARTS[key].containerOptional) {
      const running = containerRunning(state.container);
      parts.push({ kind: "connection", text: running ? t("control:appSetup.summaryConnected") : t("control:appSetup.summaryNotConnected"), tone: running ? undefined : "warn" });
    }
    return parts;
  };
}

/** The one-line summary: "3 libraries · 412 GB · connected". */
export function useSummary() {
  const parts = useSummaryParts();
  return (key: AppKey, state: ApplicationState): string => parts(key, state).map((part) => part.text).join(" · ");
}

const SUMMARY_ICONS: Record<SummaryPart["kind"], typeof Layers> = { libraries: Layers, size: Database, connection: Link2 };

/** Above a workspace's other tabs: whether the application is ready and what it
 *  holds — a segment each, with its icon — then its activity and the way back to
 *  the Overview. The Overview shrinks to this once it is done. */
export function WorkspaceStatusLine({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["control"]);
  const { data } = useApplicationsData();
  const parts = useSummaryParts();
  if (!data) return null;
  const state = applicationState(app, data);
  const href = controlHref(SETUP_SECTION[app]);
  return (
    <div className={`workspace-status-line is-${state.status ?? "ready"}`}>
      <span className="workspace-status-state">
        <ApplicationStatusPill status={state.status} gap={state.gap} container={state.container} />
      </span>
      <ul className="workspace-status-parts">
        {parts(app, state).map((part) => {
          const Icon = SUMMARY_ICONS[part.kind];
          return <li key={part.kind} className={part.tone ? `is-${part.tone}` : undefined}><Icon size={16} aria-hidden="true" />{part.text}</li>;
        })}
      </ul>
      <span className="workspace-status-links">
        {APP_LOG_PREFIXES[app] && (
          <a href={activityHref({ application: app })} onClick={(event) => followRoute(event, activityHref({ application: app }))}>
            <BarChart3 size={15} aria-hidden="true" />
            {t("control:appSetup.viewActivity", { app: appLabel(app) })}
            <ArrowRight size={14} aria-hidden="true" />
          </a>
        )}
        <a href={href} onClick={(event) => followReplace(event, href)}>
          <ArrowLeft size={15} aria-hidden="true" />
          {state.status === "ready" ? t("control:appSetup.reviewSetup") : t("control:appSetup.openSetup")}
        </a>
      </span>
    </div>
  );
}

export function AppSetupSection({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["common", "control"]);
  const { data, error, loading, reload, setSection } = useApplicationsData();
  const summary = useSummary();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const name = appLabel(app);
  const parts = APP_PARTS[app];

  const Icon = APPLICATIONS.find((entry) => entry.key === app)?.icon ?? Settings2;
  const retry = <Button variant="secondary" compact disabled={loading || saving} onClick={() => void reload(true)}>{t(loading ? "control:ui.loading" : "control:ui.retry")}</Button>;
  const head = <ControlSectionHead section={SETUP_SECTION[app]} title={name} icon={<Icon size={30} />} description={appDescription(app)} />;
  if (!data) {
    return (
      <>
        {head}
        {error
          ? <MessageBox tone="error" title={t("control:appSetup.loadFailed")}><p>{error}</p>{retry}</MessageBox>
          : <p className="muted">{t("control:ui.loading")}</p>}
      </>
    );
  }

  const state = applicationState(app, data);
  const sectionKey = parts.section;
  const on = sectionKey ? data.sections[sectionKey] : true;
  const onCount = SECTION_KEYS.filter((key) => data.sections[key]).length;

  const toggle = async (next: boolean) => {
    if (!sectionKey) return;
    setSaving(true);
    setSaveError("");
    try {
      await setSection(sectionKey, next);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("control:appearance.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  // The top row says the first thing missing, or that all is well.
  const status: { tone: "ok" | "warn" | "muted"; title: string; body: string } =
    state.status === "off"
      ? { tone: "muted", title: t("control:appSetup.offTitle", { app: name }), body: t("control:appSetup.offBody") }
      : state.status === "unavailable"
        ? { tone: "muted", title: t("control:appSetup.status.unavailable"), body: t("control:appSetup.unavailableBody") }
      : state.gap === "connection"
        ? { tone: "warn", title: t("control:appSetup.needsConnectionTitle", { app: name }), body: t("control:appSetup.needsConnectionBody") }
        : state.gap === "libraries"
          ? { tone: "warn", title: t("control:appSetup.needsLibrariesTitle", { app: name }), body: t("control:appSetup.needsLibrariesBody") }
          : { tone: "ok", title: t("control:appSetup.readyTitle", { app: name }), body: summary(app, state) || t("control:appSetup.readyBody") };

  // Every application in the Diagnostics shape (owner, 2026-11-19; Gallery first):
  // cards, its menu switch and access, what is on, its tools, and the shared side
  // column. Healthy, it needs no banner — the Status card says so; otherwise the
  // banner says what is missing.
  const Body = OVERVIEW_BODIES[app];
  return (
    <>
      {head}
      {status.tone !== "ok" && (
        <MessageBox tone={status.tone === "warn" ? "warning" : "info"} title={status.title}>{status.body}</MessageBox>
      )}
      {saveError && <MessageBox tone="error" title={t("control:appearance.errorTitle")}>{saveError}</MessageBox>}
      {((parts.libraryType && state.libraries === null) || (parts.container && data.containers === null)) && retry}
      <Body
        data={data}
        state={state}
        visibility={(
          <AppVisibility
            name={name}
            // One application always stays on: the menu is never empty.
            menu={sectionKey ? { checked: on, disabled: saving || loading || (on && onCount === 1), onChange: (next) => void toggle(next) } : null}
            access={<AccessRow app={app} />}
          />
        )}
        side={<AppOverviewSide app={app} name={name} />}
      />
    </>
  );
}

const OVERVIEW_BODIES: Record<Exclude<AppKey, "shared">, (props: OverviewProps) => ReactNode> = {
  gallery: GalleryOverviewBody,
  videos: VideosOverviewBody,
  ebooks: EbooksOverviewBody,
  audiobooks: AudiobooksOverviewBody,
  stories: StoriesOverviewBody,
  familyTree: FamilyTreeOverviewBody,
  games: GamesOverviewBody
};

// Who may use it lives with Security & Members, or on each library: this says
// which, and leads there.
function AccessRow({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["control"]);
  const parts = APP_PARTS[app];
  if (app === "stories") return null;
  const [body, href] =
    parts.container && !parts.containerOptional
      ? [t("control:appSetup.accessContainer", { app: appLabel(app) }), appPageHref("appsAccess", parts.container)]
      : app === "familyTree"
        ? [t("control:appSetup.accessFamily"), controlHref("users")]
        : [t("control:appSetup.accessLibraries"), librariesHref(parts.libraryType)];
  // An application whose access is its libraries names the row for where it goes
  // (owner, 2026-11-19): who sees what is set on each library.
  if (parts.libraryType && !(parts.container && !parts.containerOptional)) {
    return <NavRow icon={<Library size={17} />} label={t("control:appSetup.manageLibraries")} sub={body} href={href} />;
  }
  return <NavRow icon={<Users size={17} />} label={t("control:appSetup.accessTitle")} sub={body} href={href} />;
}
