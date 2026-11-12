import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, ArrowRight, BookOpen, CheckCircle2, GitFork, Library, Link2, ListChecks, Plug, Power, ScrollText, Settings2, Users, Archive } from "lucide-react";
import { controlHref, followRoute, followReplace, type ControlSection } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { GroupedList, InfoRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { Button } from "../../../shared/Button";
import { formatBytes } from "../../../shared/utils";
import { SECTION_KEYS } from "../../../app/sections";
import { ControlSectionHead } from "../ControlSectionHead";
import { activityHref, appPageHref, backupHref, librariesHref, logsHref, tasksHref } from "../links";
import { ApplicationStorage } from "./ApplicationStorage";
import { APPLICATIONS, appDescription, appLabel, type AppKey } from "../nav";
import {
  APP_LOG_PREFIXES,
  APP_PARTS,
  APP_TASK_SCOPE,
  applicationState,
  containerRunning,
  useApplicationsData,
  type ApplicationState,
  type ApplicationStatus
} from "../applications";

// An application's Setup tab (control panel v2, phase 2), as grouped rows like a
// phone's Settings: is it on, does it work, and what it is made of. It SHOWS its libraries, connection, access and storage
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

/** The one-line summary: "3 libraries · 412 GB · connected". */
export function useSummary() {
  const { t } = useTranslation(["control"]);
  return (key: AppKey, state: ApplicationState): string => {
    const parts: string[] = [];
    if (state.libraries) parts.push(t("control:appSetup.summaryLibraries", { count: state.libraries.length }));
    if (state.sizeBytes !== null && state.sizeComplete) parts.push(formatBytes(state.sizeBytes));
    // Only a container it cannot work without: Gallery's face engine is optional.
    if (state.status !== "unavailable" && APP_PARTS[key].container && !APP_PARTS[key].containerOptional) {
      parts.push(containerRunning(state.container) ? t("control:appSetup.summaryConnected") : t("control:appSetup.summaryNotConnected"));
    }
    return parts.join(" · ");
  };
}

/** Above a workspace's other tabs: whether the application is ready, in a line,
 *  with the way back to Setup — Setup shrinks to this once it is done. */
export function WorkspaceStatusLine({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["control"]);
  const { data } = useApplicationsData();
  const summary = useSummary();
  if (!data) return null;
  const state = applicationState(app, data);
  const href = controlHref(SETUP_SECTION[app]);
  return (
    <div className={`workspace-status-line is-${state.status ?? "ready"}`}>
      <ApplicationStatusPill status={state.status} gap={state.gap} container={state.container} />
      <span>{summary(app, state)}</span>
      {APP_LOG_PREFIXES[app] && (
        <a href={activityHref({ application: app })} onClick={(event) => followRoute(event, activityHref({ application: app }))}>
          {t("control:appSetup.viewActivity", { app: appLabel(app) })}
          <ArrowRight size={14} aria-hidden="true" />
        </a>
      )}
      <a href={href} onClick={(event) => followReplace(event, href)}>
        {state.status === "ready" ? t("control:appSetup.reviewSetup") : t("control:appSetup.openSetup")}
        <ArrowRight size={14} aria-hidden="true" />
      </a>
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

  const connected = containerRunning(state.container);

  return (
    <>
      {head}
      <div className="grouped-page">
        <GroupedList>
          <InfoRow
            icon={status.tone === "ok" ? <CheckCircle2 size={17} /> : status.tone === "warn" ? <AlertTriangle size={17} /> : <Power size={17} />}
            iconTone={status.tone}
            label={status.title}
            sub={status.body}
          />
        </GroupedList>

        {sectionKey && (
          <GroupedList
            title={t("control:appSetup.menuTitle")}
            note={<>{t("control:appSetup.menuHint")}{app === "games" && <> {t("control:appearance.sectionsGamesHint")}</>}</>}
          >
            <ToggleRow
              label={t("control:appSetup.menuSwitch", { app: name })}
              checked={on}
              // One application always stays on: the menu is never empty.
              disabled={saving || loading || (on && onCount === 1)}
              onChange={(next) => void toggle(next)}
            />
          </GroupedList>
        )}
        {saveError && <MessageBox tone="error" title={t("control:appearance.errorTitle")}>{saveError}</MessageBox>}

        {((parts.libraryType && state.libraries === null) || (parts.container && data.containers === null)) && retry}
        {(parts.libraryType || parts.container) && (
          <GroupedList title={t("control:appSetup.setupTitle")}>
            {parts.libraryType && <NavRow icon={<Library size={17} />} label={t("control:appSetup.librariesTitle")}
              sub={t("control:appSetup.librarySummary")}
              value={state.libraries ? t("control:appSetup.summaryLibraries", { count: state.libraries.length }) : t("control:appSetup.status.unavailable")}
              href={librariesHref(parts.libraryType)} />}
            {parts.container && <NavRow summary icon={<Plug size={17} />}
              iconTone={connected ? "ok" : data.containers === null || parts.containerOptional ? "muted" : "warn"}
              label={t(parts.containerOptional ? "control:appSetup.optionalService" : "control:appSetup.connectionTitle")}
              sub={t(`control:appSetup.connectionHint.${parts.container}`)}
              value={data.containers === null ? t("control:appSetup.status.unavailable") : connected ? t("control:appSetup.connectionOkNoVersion") : t(state.container?.configured ? "control:appSetup.connectionDown" : "control:appSetup.connectionUnset")}
              href={appPageHref("appsSetup", parts.container)} />}
          </GroupedList>
        )}
        <GroupedList title={t("control:appSetup.manageTitle")}>
          <AccessRow app={app} />
          <NavRow icon={<Archive size={17} />} label={t("control:nav.tabs.backup")}
            sub={t(app === "videos" || app === "games" ? "control:appSetup.backupContainer" : "control:appSetup.backupHome")}
            href={backupHref(app === "videos" ? "video" : app === "games" ? "games" : undefined)} />
        </GroupedList>

        <ApplicationStorage app={app} state={state} />

        {/* Activity, tasks and logs are one page each in Infrastructure; these
            open them already narrowed to this application (phase 3). */}
        {APP_LOG_PREFIXES[app] && (
          <GroupedList title={t("control:appSetup.activityTitle")} note={t("control:appSetup.activityBody", { app: name })}>
            <NavRow icon={<Activity size={17} />} label={t("control:appSetup.activityLink")} href={activityHref({ application: app })} />
            {APP_TASK_SCOPE[app] && <NavRow icon={<ListChecks size={17} />} label={t("control:appSetup.tasksLink")} href={tasksHref({ application: app })} />}
            <NavRow icon={<ScrollText size={17} />} label={t("control:appSetup.logsLink")} href={logsHref({ application: app })} />
          </GroupedList>
        )}

        {app === "familyTree" && (
          <GroupedList title={t("control:appSetup.familyTitle")} note={t("control:appSetup.familyBody")}>
            <NavRow icon={<GitFork size={17} />} label={t("control:appSetup.familyOpen")} href="/family" />
          </GroupedList>
        )}
        {app === "stories" && (
          <GroupedList title={t("control:appSetup.storiesTitle")} note={t("control:appSetup.storiesBody")}>
            <NavRow icon={<BookOpen size={17} />} label={t("control:appSetup.storiesLink")} href={controlHref("storySettings")} />
          </GroupedList>
        )}
        {app === "games" && (
          <GroupedList title={t("control:appSetup.guestTitle")} note={t("control:appSetup.guestBody")}>
            <NavRow icon={<Link2 size={17} />} label={t("control:appSetup.guestLink")} href={`${controlHref("invites")}#games-guest-links`} />
          </GroupedList>
        )}
      </div>
    </>
  );
}

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
  return <NavRow icon={<Users size={17} />} label={t("control:appSetup.accessTitle")} sub={body} href={href} />;
}
