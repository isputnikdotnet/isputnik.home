import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Settings2 } from "lucide-react";
import { controlHref, followRoute, libraryManageHref, type ControlSection } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { formatDateTime, formatNumber } from "../../../shared/dates";
import { formatBytes } from "../../../shared/utils";
import { SECTION_KEYS } from "../../../app/sections";
import { ControlSectionHead } from "../ControlSectionHead";
import { activityHref, appPageHref, logsHref, storageHref, tasksHref } from "../links";
import { appLabel, type AppKey } from "../nav";
import {
  APP_LOG_PREFIXES,
  APP_PARTS,
  APP_TASK_SCOPE,
  applicationState,
  containerRunning,
  useApplicationsData,
  type AppLibrary,
  type ApplicationState,
  type ApplicationStatus
} from "../applications";

// An application's Setup tab (control panel v2, phase 2): is it on, does it work,
// and what it is made of. It SHOWS its libraries, connection, access and storage
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
export function ApplicationStatusPill({ status }: { status: ApplicationStatus | null }) {
  const { t } = useTranslation(["control"]);
  if (!status) return null;
  return <span className={`app-status-pill is-${status}`}>{t(`control:appSetup.status.${status}`)}</span>;
}

/** The one-line summary: "3 libraries · 412 GB · connected". */
export function useSummary() {
  const { t } = useTranslation(["control"]);
  return (key: AppKey, state: ApplicationState): string => {
    const parts: string[] = [];
    if (state.libraries) parts.push(t("control:appSetup.summaryLibraries", { count: state.libraries.length }));
    if (state.sizeBytes) parts.push(formatBytes(state.sizeBytes));
    // Only a container it cannot work without: Gallery's face engine is optional.
    if (APP_PARTS[key].container && !APP_PARTS[key].containerOptional) {
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
      <ApplicationStatusPill status={state.status} />
      <span>{summary(app, state)}</span>
      {APP_LOG_PREFIXES[app] && (
        <a href={activityHref({ application: app })} onClick={(event) => followRoute(event, activityHref({ application: app }))}>
          {t("control:appSetup.viewActivity", { app: appLabel(app) })}
          <ArrowRight size={14} aria-hidden="true" />
        </a>
      )}
      <a href={href} onClick={(event) => followRoute(event, href)}>
        {state.status === "ready" ? t("control:appSetup.reviewSetup") : t("control:appSetup.openSetup")}
        <ArrowRight size={14} aria-hidden="true" />
      </a>
    </div>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
      {children}
      <ArrowRight size={15} aria-hidden="true" />
    </a>
  );
}

function SetupCard({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="organization-card app-setup-card">
      <h2>{title}</h2>
      {children}
      {actions && <div className="organization-actions">{actions}</div>}
    </section>
  );
}

export function AppSetupSection({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["common", "control"]);
  const { data, error, setSection } = useApplicationsData();
  const summary = useSummary();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const name = appLabel(app);
  const parts = APP_PARTS[app];

  const head = <ControlSectionHead section={SETUP_SECTION[app]} icon={<Settings2 size={30} />} description={t("control:appSetup.description", { app: name })} />;
  if (!data) {
    return (
      <>
        {head}
        {error
          ? <MessageBox tone="error" title={t("control:appSetup.loadFailed")}>{error}</MessageBox>
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

  // What the top of the page says: the first thing missing, or that all is well.
  let banner: ReactNode;
  if (state.status === "off") {
    banner = <MessageBox tone="info" title={t("control:appSetup.offTitle", { app: name })}>{t("control:appSetup.offBody")}</MessageBox>;
  } else if (state.gap === "connection") {
    banner = <MessageBox tone="warning" title={t("control:appSetup.needsConnectionTitle", { app: name })}>{t("control:appSetup.needsConnectionBody")}</MessageBox>;
  } else if (state.gap === "libraries") {
    banner = <MessageBox tone="warning" title={t("control:appSetup.needsLibrariesTitle", { app: name })}>{t("control:appSetup.needsLibrariesBody")}</MessageBox>;
  } else {
    banner = <MessageBox tone="success" title={t("control:appSetup.readyTitle", { app: name })}>{summary(app, state) || t("control:appSetup.readyBody")}</MessageBox>;
  }

  return (
    <>
      {head}
      {banner}
      <div className="organization-grid">
        {sectionKey && (
          <SetupCard title={t("control:appSetup.menuTitle")}>
            <ToggleSwitch
              checked={on}
              onChange={(next) => void toggle(next)}
              // One application always stays on: the menu is never empty.
              disabled={saving || (on && onCount === 1)}
              label={t("control:appSetup.menuSwitch", { app: name })}
              ariaLabel={t("control:appSetup.menuSwitch", { app: name })}
            />
            <p className="muted">{t("control:appSetup.menuHint")}</p>
            {app === "games" && <p className="muted">{t("control:appearance.sectionsGamesHint")}</p>}
            {saveError && <MessageBox tone="error" title={t("control:appearance.errorTitle")}>{saveError}</MessageBox>}
          </SetupCard>
        )}

        {state.libraries && (
          <SetupCard
            title={t("control:appSetup.librariesTitle")}
            actions={<Link href={controlHref("libraries")}>{t("control:appSetup.librariesLink")}</Link>}
          >
            <p className="muted">{t("control:appSetup.librariesBody", { app: name })}</p>
            {state.libraries.length === 0
              ? <p>{t("control:appSetup.librariesNone")}</p>
              : <ul className="app-setup-list">{state.libraries.map((library) => <LibraryRow key={library.id} library={library} />)}</ul>}
          </SetupCard>
        )}

        {parts.container && (
          <SetupCard
            title={t("control:appSetup.connectionTitle")}
            actions={<Link href={appPageHref("appsSetup", parts.container)}>{t("control:appSetup.connectionLink")}</Link>}
          >
            <p className={containerRunning(state.container) ? "app-setup-ok" : "app-setup-warn"}>
              {!state.container?.configured
                ? t("control:appSetup.connectionUnset")
                : containerRunning(state.container)
                  ? (state.container.server?.version
                    ? t("control:appSetup.connectionOk", { version: state.container.server.version })
                    : t("control:appSetup.connectionOkNoVersion"))
                  : t("control:appSetup.connectionDown")}
            </p>
            <p className="muted">{t(`control:appSetup.connectionHint.${parts.container}`)}</p>
          </SetupCard>
        )}

        <AccessCard app={app} />

        {state.libraries && (
          <SetupCard
            title={t("control:appSetup.storageTitle")}
            actions={<Link href={storageHref()}>{t("control:appSetup.storageLink")}</Link>}
          >
            <p className="app-setup-figure">{state.sizeBytes !== null ? formatBytes(state.sizeBytes) : t("control:appSetup.storageUnknown")}</p>
            <p className="muted">{t("control:appSetup.storageBody")}</p>
          </SetupCard>
        )}

        {/* Activity, tasks and logs are one page each in Infrastructure; this
            opens them already narrowed to this application (phase 3). */}
        {APP_LOG_PREFIXES[app] && (
          <SetupCard
            title={t("control:appSetup.activityTitle")}
            actions={
              <>
                <Link href={activityHref({ application: app })}>{t("control:appSetup.activityLink")}</Link>
                {APP_TASK_SCOPE[app] && <Link href={tasksHref({ application: app })}>{t("control:appSetup.tasksLink")}</Link>}
                <Link href={logsHref({ application: app })}>{t("control:appSetup.logsLink")}</Link>
              </>
            }
          >
            <p className="muted">{t("control:appSetup.activityBody", { app: name })}</p>
          </SetupCard>
        )}

        {app === "familyTree" && (
          <SetupCard title={t("control:appSetup.familyTitle")} actions={<Link href="/family">{t("control:appSetup.familyOpen")}</Link>}>
            <p className="muted">{t("control:appSetup.familyBody")}</p>
          </SetupCard>
        )}
        {app === "stories" && (
          <SetupCard title={t("control:appSetup.storiesTitle")} actions={<Link href={controlHref("storySettings")}>{t("control:appSetup.storiesLink")}</Link>}>
            <p className="muted">{t("control:appSetup.storiesBody")}</p>
          </SetupCard>
        )}
        {app === "games" && (
          <SetupCard title={t("control:appSetup.guestTitle")} actions={<Link href={`${controlHref("invites")}#games-guest-links`}>{t("control:appSetup.guestLink")}</Link>}>
            <p className="muted">{t("control:appSetup.guestBody")}</p>
          </SetupCard>
        )}
      </div>
    </>
  );
}

function LibraryRow({ library }: { library: AppLibrary }) {
  const { t } = useTranslation(["control"]);
  const href = libraryManageHref(library.id);
  const scan = library.scanStatus === "scanning"
    ? t("control:appSetup.scanning")
    : library.scanStatus === "error"
      ? t("control:appSetup.scanFailed")
      : library.lastScannedAt
        ? t("control:appSetup.scanned", { when: formatDateTime(library.lastScannedAt) })
        : t("control:appSetup.neverScanned");
  const facts = [
    library.items !== null ? t("control:appSetup.items", { count: library.items, formatted: formatNumber(library.items) }) : null,
    library.sizeBytes ? formatBytes(library.sizeBytes) : null,
    scan
  ].filter(Boolean).join(" · ");
  return (
    <li>
      <a href={href} onClick={(event) => followRoute(event, href)}>{library.name}</a>
      {library.personal && <span className="app-setup-tag">{t("control:appSetup.personal")}</span>}
      <small className={library.scanStatus === "error" ? "app-setup-warn" : undefined}>{facts}</small>
    </li>
  );
}

// Who may use it lives with Security & Members, or on each library: this says
// which, and links there.
function AccessCard({ app }: { app: Exclude<AppKey, "shared"> }) {
  const { t } = useTranslation(["control"]);
  const parts = APP_PARTS[app];
  if (app === "stories") return null;
  if (parts.container && !parts.containerOptional) {
    return (
      <SetupCard
        title={t("control:appSetup.accessTitle")}
        actions={<Link href={appPageHref("appsAccess", parts.container)}>{t("control:appSetup.accessLink")}</Link>}
      >
        <p className="muted">{t("control:appSetup.accessContainer", { app: appLabel(app) })}</p>
      </SetupCard>
    );
  }
  if (app === "familyTree") {
    return (
      <SetupCard title={t("control:appSetup.accessTitle")} actions={<Link href={controlHref("users")}>{t("control:appSetup.accessMembersLink")}</Link>}>
        <p className="muted">{t("control:appSetup.accessFamily")}</p>
      </SetupCard>
    );
  }
  return (
    <SetupCard title={t("control:appSetup.accessTitle")} actions={<Link href={controlHref("libraries")}>{t("control:appSetup.librariesLink")}</Link>}>
      <p className="muted">{t("control:appSetup.accessLibraries")}</p>
    </SetupCard>
  );
}
