import { useTranslation } from "react-i18next";
import {
  Archive,
  ChevronRight,
  Gamepad2,
  House,
  KeyRound,
  ScanFace,
  Tv,
  type LucideIcon
} from "lucide-react";
import { controlHref, followRoute } from "../../../../router";
import { CurrentWorkPanel, DASH_ICONS, DashSectionHead, StoragePanel, UsagePanel } from "./DashboardPanels";
import { MessageBox } from "../../../../shared/MessageBox";
import { formatBytes, formatManagedDate, formatUptime } from "../../../../shared/utils";
import { relativeTime } from "../../../../shared/relativeTime";
import { formatNumber } from "../../../../shared/dates";
import { appPageHref, backupHref, logsHref, storageHref, tasksHref } from "../../links";
import { signInsHref } from "./SignInsView";
import type { AppStatus } from "../AppsSection";
import type { SystemStatus } from "../../types";
import { isStaleBackup, type AppBackupSummary, type DashboardDisk, type DashboardOverview, type DiskHolding, type LastBackup, type OwnedDisk } from "./useDashboardOverview";

// The Dashboard (docs/dashboard-and-backups-plan.md; reshaped in control panel v2,
// docs/control-panel-v2-plan.md "Dashboard"): where an admin lands. It reads and
// points; every setting stays on its own page. Needs attention (each with the
// button that acts on it), Home with its gateway and a branch per container,
// storage by drive and what uses it, usage, and the work in progress.

type Tone = "success" | "warning" | "danger" | "muted";

/** One or two failed sign-ins is a typo; this many is worth a look. */
const FAILED_SIGN_INS_NOTICE = 5;

// Free space keeps the tones the old System view gave it: fine until a fifth is
// left, amber below that, red below a tenth.
function diskTone(disk: Pick<DashboardDisk, "freeBytes" | "totalBytes">): Tone {
  if (disk.totalBytes <= 0) return "muted";
  const share = disk.freeBytes / disk.totalBytes;
  if (share < 0.1) return "danger";
  if (share < 0.2) return "warning";
  return "success";
}

type AppState = "running" | "down" | "secret" | "unset";

function appState(app: AppStatus): AppState {
  if (!app.configured) return "unset";
  if (!app.server?.ok) return "down";
  if (app.secretAccepted === false) return "secret";
  return "running";
}

const STATE_TONE: Record<AppState, Tone> = { running: "success", down: "danger", secret: "warning", unset: "muted" };

function portOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

function useAppName() {
  const { t } = useTranslation("common");
  return (id: string) => (id === "games" ? t("nav.games") : id === "video" ? t("nav.video") : id === "faces" ? t("nav.faces") : id);
}

const APP_ICONS: Record<string, LucideIcon> = { games: Gamepad2, video: Tv, faces: ScanFace };

const containerBackupHref = backupHref;

/** One filesystem and the folders mapped from it, in every container: one bar, since
 *  they all show the same numbers. Within a container the device id says it is one
 *  filesystem; across two (home and Video on one Unraid user share) the id must match
 *  AND the size, so a coincidence between two hosts' device numbers never merges them. */
interface DiskGroup {
  key: string;
  freeBytes: number;
  totalBytes: number;
  folders: OwnedDisk[];
}

function groupDisks(overview: DashboardOverview | null, appDisks: OwnedDisk[]): DiskGroup[] {
  const groups = new Map<string, DiskGroup>();
  for (const disk of [...(overview?.disks ?? []).map((disk) => ({ ...disk, owner: "home" })), ...appDisks]) {
    const key = `${disk.filesystem}:${disk.totalBytes}`;
    const group = groups.get(key);
    if (group) group.folders.push(disk);
    else groups.set(key, { key, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, folders: [disk] });
  }
  return [...groups.values()];
}

/** The folders of a disk by their paths, each once: home and Video may both say /media. */
const folderNames = (group: DiskGroup) => [...new Set(group.folders.map((folder) => folder.mount))].join(", ");

interface Issue {
  tone: Tone;
  /** The row's bold line: what is wrong. */
  text: string;
  /** One line under it: the number or the place that says how bad. */
  detail?: string;
  href: string;
  /** The button that acts on it: "Open connection", "Open sign-ins". */
  action: string;
  /** A second way to deal with it: the logs, the recycle bin, the block list. */
  second?: { href: string; label: string };
}

export function Overview({
  status,
  overview,
  apps,
  lastBackup,
  appErrors,
  appDisks,
  appBackups
}: {
  status: SystemStatus;
  overview: DashboardOverview | null;
  apps: AppStatus[] | null;
  lastBackup: LastBackup | null | undefined;
  appErrors: Record<string, number | null>;
  appDisks: OwnedDisk[];
  appBackups?: AppBackupSummary[];
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();

  // ── What needs a look, worst first ─────────────────────────────────────────
  const issues: Issue[] = [];
  for (const app of apps ?? []) {
    const state = appState(app);
    if (state === "down") issues.push({ tone: "danger", text: t("controlDash:overview.issueAppDown", { app: appName(app.id) }), href: appPageHref("appsSetup", app.id), action: t("controlDash:dashboard.actionConnection"), detail: app.url ? t("controlDash:dashboard.detailAppDown", { url: app.url }) : undefined, second: { href: logsHref({ app: app.id }), label: t("controlDash:dashboard.actionLogs") } });
    if (state === "secret") issues.push({ tone: "danger", text: t("controlDash:overview.issueAppSecret", { app: appName(app.id) }), href: appPageHref("appsSetup", app.id), action: t("controlDash:dashboard.actionConnection"), second: { href: logsHref({ app: app.id }), label: t("controlDash:dashboard.actionLogs") } });
  }
  const disks = groupDisks(overview, appDisks);
  for (const disk of disks) {
    const tone = diskTone(disk);
    if (tone === "danger" || tone === "warning") {
      issues.push({
        tone,
        text: t("controlDash:overview.issueDiskLow", { mount: folderNames(disk), share: Math.round((disk.freeBytes / disk.totalBytes) * 100) }),
        href: storageHref(),
        action: t("controlDash:dashboard.actionStorage"),
        detail: t("controlDash:dashboard.detailDisk", { free: formatBytes(disk.freeBytes), total: formatBytes(disk.totalBytes) }),
        second: { href: controlHref("recycleBin"), label: t("controlDash:dashboard.actionRecycle") }
      });
    }
  }
  if (lastBackup === null) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueNoBackup"), href: controlHref("backup"), action: t("controlDash:dashboard.actionBackups") });
  } else if (lastBackup?.stale) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueOldBackup", { when: relativeTime(lastBackup.createdAt) }), href: controlHref("backup"), action: t("controlDash:dashboard.actionBackups") });
  }
  // A container left out of the backups on purpose has nothing to warn about.
  for (const app of appBackups ?? []) {
    if (!app.configured || !app.include) continue;
    const newest = app.files[0];
    if (!newest) {
      issues.push({ tone: "warning", text: t("controlDash:overview.issueAppNoBackup", { app: appName(app.id) }), href: containerBackupHref(app.id), action: t("controlDash:dashboard.actionBackups") });
    } else if (isStaleBackup(newest.createdAt)) {
      issues.push({ tone: "warning", text: t("controlDash:overview.issueAppOldBackup", { app: appName(app.id), when: relativeTime(newest.createdAt) }), href: containerBackupHref(app.id), action: t("controlDash:dashboard.actionBackups") });
    }
  }
  if (overview && overview.failedTasks24h > 0) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueFailedTasks", { count: overview.failedTasks24h }), href: tasksHref({ status: "failed" }), action: t("controlDash:dashboard.actionTasks"), detail: t("controlDash:dashboard.detailLastDay") });
  }
  for (const app of apps ?? []) {
    const errors = appErrors[app.id];
    if (errors) issues.push({ tone: "warning", text: t("controlDash:overview.issueAppErrors", { app: appName(app.id), count: errors }), href: logsHref({ app: app.id, level: "error" }), action: t("controlDash:dashboard.actionLogs"), detail: t("controlDash:dashboard.detailLastDay") });
  }
  if (overview && overview.failedSignIns24h >= FAILED_SIGN_INS_NOTICE) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueFailedSignIns", { count: overview.failedSignIns24h }), href: signInsHref({}), action: t("controlDash:dashboard.actionSignIns"), detail: t("controlDash:dashboard.detailLastDay"), second: { href: controlHref("securityBlocked"), label: t("controlDash:dashboard.actionBlocked") } });
  }
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));

  const folderOwner = (folder: OwnedDisk) => (folder.owner === "home" ? t("controlDash:overview.homeShort") : appName(folder.owner));
  const holdingsOf = (folder: OwnedDisk) => describeHoldings(folder.holds, {
    database: t("controlDash:overview.holdDatabase"),
    systemData: t("controlDash:overview.holdSystemData"),
    thumbnails: t("controlDash:overview.holdThumbnails"),
    backups: t("controlDash:overview.holdBackups"),
    appFiles: t("controlDash:overview.holdAppFiles"),
    trash: t("controlDash:overview.holdTrash"),
    artwork: t("controlDash:overview.holdArtwork"),
    transcode: t("controlDash:overview.holdTranscode")
  }, (names) => t("controlDash:overview.holdLibraries", { names }));

  // Control panel v2 (phase 4): five sections in the order an admin asks them —
  // what needs me, what is running, how much room is left, how it is used, what it
  // is doing now. Every summary leads to the page that acts on it.
  return (
    <div className="dash">
      <section className="dash-section" aria-labelledby="dash-attention">
        <div className="dash-section-head">
          <h2 id="dash-attention">{t("controlDash:dashboard.attentionTitle")}{issues.length > 0 && <span className="dash-count">{issues.length}</span>}</h2>
        </div>
        {issues.length > 0 ? (
          <ul className="dash-attention">
            {issues.map((issue) => (
              <li key={issue.text}>
                <span className={`dash-severity tone-${issue.tone}`}>
                  {issue.tone === "danger" ? t("controlDash:dashboard.severity.urgent") : t("controlDash:dashboard.severity.warning")}
                </span>
                <span className="dash-issue-text">
                  <strong>{issue.text}</strong>
                  {issue.detail && <small>{issue.detail}</small>}
                </span>
                <span className="dash-issue-actions">
                  {issue.second && (
                    <a href={issue.second.href} className="secondary-button compact-button" onClick={(event) => followRoute(event, issue.second!.href)}>
                      {issue.second.label}
                    </a>
                  )}
                  <a href={issue.href} className="primary-button compact-button" onClick={(event) => followRoute(event, issue.href)}>
                    {issue.action}
                    <ChevronRight size={15} aria-hidden="true" />
                  </a>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <MessageBox tone="success" title={t("controlDash:overview.allClearTitle")}>
            {t("controlDash:overview.allClearBody")}
          </MessageBox>
        )}
      </section>

      <ServiceTiles status={status} overview={overview} apps={apps} />

      <section className="dash-section" aria-labelledby="dash-storage">
        <DashSectionHead id="dash-storage" icon={DASH_ICONS.storage} title={t("controlDash:overview.storageTitle")} link={{ href: storageHref(), label: t("controlDash:dashboard.storageSettingsLink") }} />
        {overview === null
          ? <p className="muted">{t("controlDash:overview.disksUnknown")}</p>
          : <StoragePanel drives={disks} status={status} describe={holdingsOf} folderLabel={folderOwner} />}
        <div className="dash-backup">
          <span className="dash-backup-label"><Archive size={16} aria-hidden="true" />{t("controlDash:system.lastBackup")}</span>
          <BackupRow
            name={t("controlDash:overview.homeShort")}
            href={controlHref("backup")}
            when={lastBackup === undefined ? "…" : lastBackup ? relativeTime(lastBackup.createdAt) : t("controlDash:system.noneYet")}
            stale={Boolean(lastBackup?.stale)}
            detail={lastBackup
              ? `${lastBackup.kind === "full" ? t("controlDash:system.fullBackup") : lastBackup.kind === "minimal" ? t("controlDash:overview.minimalBackup") : t("controlDash:system.databaseOnly")} · ${formatManagedDate(lastBackup.createdAt)}`
              : t("controlDash:system.backupHint")}
          />
          {(appBackups ?? []).filter((app) => app.configured || app.files.length > 0).map((app) => (
            <AppBackupRow key={app.id} app={app} />
          ))}
        </div>
      </section>

      <section className="dash-section" aria-labelledby="dash-usage">
        <DashSectionHead id="dash-usage" icon={DASH_ICONS.usage} title={t("controlDash:dashboard.usageTitle")} />
        <UsagePanel />
      </section>

      <section className="dash-section" aria-labelledby="dash-work">
        <DashSectionHead id="dash-work" icon={DASH_ICONS.work} title={t("controlDash:dashboard.workTitle")} />
        <CurrentWorkPanel />
      </section>
    </div>
  );
}

// ── Services: Home, its gateway, a branch per container ──────────────────────

/** The Dashboard's Running services: a tile per service — its state, version, where
 *  it is (addresses with their ports) and how fast it answers. A tile opens that
 *  service's card on Infrastructure › Services. */
function ServiceTiles({ status, overview, apps }: { status: SystemStatus; overview: DashboardOverview | null; apps: AppStatus[] | null }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();
  const servicesHref = controlHref("services");
  const lan = overview?.home.addresses.length
    ? overview.home.addresses.map((address) => `${address}:${overview.home.port}`).join(", ")
    : overview ? `:${overview.home.port}` : "…";
  const homeHref = `${servicesHref}#service-home`;
  return (
    <section className="dash-section" aria-labelledby="dash-services">
      <div className="dash-section-head">
        <h2 id="dash-services">{t("controlDash:dashboard.servicesTitle")}</h2>
        <a href={servicesHref} onClick={(event) => followRoute(event, servicesHref)}>{t("controlDash:dashboard.servicesDetail")}</a>
      </div>
      <div className="dash-tiles">
        <a className="dash-tile" href={homeHref} onClick={(event) => followRoute(event, homeHref)}>
          <span className="dash-tile-head">
            <House size={18} aria-hidden="true" />
            <strong>{t("controlDash:overview.homeName")}</strong>
            <StateLabel tone="success" label={t("controlDash:overview.stateRunning")} />
          </span>
          <dl className="dash-facts dash-tile-facts">
            <Fact label={t("controlDash:overview.ipAddress")} value={lan} line />
            {overview?.home.publicUrl && <Fact label={t("controlDash:overview.publicAddress")} value={overview.home.publicUrl} line />}
            <Fact label={t("controlDash:dashboard.version")} value={`v${status.version}`} />
            <Fact label={t("controlDash:system.uptime")} value={formatUptime(status.uptimeSeconds)} />
            <Fact label={t("controlDash:overview.signedIn")} value={formatNumber(status.activeSessions)} />
            <Fact label={t("controlDash:system.memory")} value={formatBytes(status.memory.rssBytes)} />
            <Fact label={t("controlDash:system.database")} value={formatBytes(status.databaseBytes)} />
          </dl>
        </a>
        {apps === null && <p className="muted">{t("controlDash:overview.appsLoading")}</p>}
        {(apps ?? []).map((app) => {
          const state = appState(app);
          const tone = STATE_TONE[state];
          const Icon = APP_ICONS[app.id] ?? House;
          const href = `${servicesHref}#service-${app.id}`;
          const label = {
            running: t("controlDash:overview.stateRunning"),
            down: t("controlDash:overview.stateDown"),
            secret: t("controlDash:overview.stateSecret"),
            unset: t("controlDash:overview.stateUnset")
          }[state];
          return (
            <a key={app.id} className={`dash-tile tone-${tone}`} href={href} onClick={(event) => followRoute(event, href)}>
              <span className="dash-tile-head">
                <Icon size={18} aria-hidden="true" />
                <strong>{appName(app.id)}</strong>
                <StateLabel tone={tone} label={label} />
              </span>
              {state === "unset" ? (
                <span className="muted">{t("controlDash:overview.unsetNote")}</span>
              ) : (
                <dl className="dash-facts dash-tile-facts">
                  <Fact label={t("controlDash:overview.address")} value={app.url ?? "—"} line />
                  <Fact label={t("controlDash:dashboard.membersReach")} value={app.prefix} />
                  <Fact label={t("controlDash:dashboard.version")} value={app.server?.version ? `v${app.server.version}` : "—"} />
                  <Fact
                    label={t("controlDash:dashboard.answersIn")}
                    value={app.server?.roundTripMs != null ? `${app.server.roundTripMs} ms` : t("controlDash:overview.branchNoReply")}
                    tone={app.server?.ok ? undefined : "warning"}
                  />
                </dl>
              )}
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** Home, its gateway and a branch per container, wired up — how the pieces connect.
 *  Infrastructure › Services opens with it (control panel v2); the Dashboard keeps
 *  the compact ServiceTiles below. */
export function ServicesDiagram({ status, overview, apps, onServicesPage = false }: { status: SystemStatus; overview: DashboardOverview | null; apps: AppStatus[] | null; onServicesPage?: boolean }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const homeAddress = overview?.home.addresses.length
    ? overview.home.addresses.map((address) => `${address}:${overview.home.port}`).join(", ")
    : overview ? `:${overview.home.port}` : "…";

  return (
    <section className="dash-section" aria-labelledby="dash-services">
      <div className="dash-section-head">
        <h2 id="dash-services">{onServicesPage ? t("controlDash:dashboard.diagramTitle") : t("controlDash:overview.servicesTitle")}</h2>
        <span className="muted">{t("controlDash:overview.servicesNote")}</span>
        {!onServicesPage && <a href={controlHref("services")}>{t("controlDash:overview.servicesLink")}</a>}
      </div>
      <div className="dash-diagram">
        <article className="dash-node dash-home">
          <div className="dash-node-head">
            <span className="dash-node-icon" aria-hidden="true"><House size={24} /></span>
            <div className="dash-node-title">
              <h3>
                {t("controlDash:overview.homeName")}
                <span className="dash-version">v{status.version}</span>
                <span className="dash-core">{t("controlDash:overview.core")}</span>
              </h3>
              <span className="muted">{t("controlDash:overview.homeRole")}</span>
            </div>
            <StateLabel tone="success" label={t("controlDash:overview.stateRunning")} />
          </div>
          <dl className="dash-facts">
            <Fact label={t("controlDash:overview.publicAddress")} value={overview?.home.publicUrl ?? "…"} line />
            <Fact label={t("controlDash:overview.ipAddress")} value={homeAddress} line />
            <Fact label={t("controlDash:system.uptime")} value={formatUptime(status.uptimeSeconds)} />
            <Fact label={t("controlDash:overview.signedIn")} value={formatNumber(status.activeSessions)} />
          </dl>
          <nav className="dash-links" aria-label={t("controlDash:overview.pagesOf", { name: t("controlDash:overview.homeName") })}>
            <a href={controlHref("logs")}>{t("controlDash:overview.linkLogs")}</a>
            <a href={controlHref("activity")}>{t("controlDash:overview.linkActivity")}</a>
            <a href={controlHref("about")}>{t("controlDash:overview.linkAbout")}</a>
          </nav>
        </article>

        {apps === null && <p className="muted">{t("controlDash:overview.appsLoading")}</p>}
        {apps && apps.length > 0 && (
          <>
            <span className="dash-trunk" aria-hidden="true" />
            <div className="dash-gateway">
              <KeyRound size={16} aria-hidden="true" />
              <strong>{t("controlDash:overview.gateway")}</strong>
              <span className="muted">{t("controlDash:overview.gatewayNote")}</span>
            </div>
            <span className="dash-trunk" aria-hidden="true" />
            <div className="dash-branches" style={{ ["--branches" as string]: apps.length }}>
              {apps.length > 1 && <span className="dash-bar" aria-hidden="true" />}
              {apps.map((app) => <AppBranch key={app.id} app={app} />)}
            </div>
            <div className="dash-legend">
              <span><i className="dash-wire-sample tone-success" aria-hidden="true" />{t("controlDash:overview.legendOk")}</span>
              <span><i className="dash-wire-sample tone-danger dashed" aria-hidden="true" />{t("controlDash:overview.legendDown")}</span>
              <span><i className="dash-wire-sample tone-warning dashed" aria-hidden="true" />{t("controlDash:overview.legendSecret")}</span>
              <span>{t("controlDash:overview.legendRoute")}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function AppBranch({ app }: { app: AppStatus }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();
  const state = appState(app);
  const tone = STATE_TONE[state];
  const Icon = APP_ICONS[app.id] ?? House;
  const port = portOf(app.url);
  const trip = state === "unset"
    ? t("controlDash:overview.branchUnset")
    : app.server?.roundTripMs != null
      ? t("controlDash:overview.roundTripMs", { ms: app.server.roundTripMs })
      : t("controlDash:overview.branchNoReply");
  const stateLabel = {
    running: t("controlDash:overview.stateRunning"),
    down: t("controlDash:overview.stateDown"),
    secret: t("controlDash:overview.stateSecret"),
    unset: t("controlDash:overview.stateUnset")
  }[state];
  const setBy = {
    environment: t("controlDash:overview.setByEnvironment"),
    saved: t("controlDash:overview.setBySaved"),
    none: t("controlDash:overview.setByNone")
  }[app.urlSource];
  const secret = app.secretAccepted === true
    ? t("controlDash:overview.secretAccepted")
    : app.secretAccepted === false
      ? t("controlDash:overview.secretRefused")
      : app.secretSet
        ? t("controlDash:overview.secretUnchecked")
        : t("controlDash:overview.secretNone");
  const name = appName(app.id);

  return (
    <div className="dash-branch">
      <span className={`dash-wire tone-${tone}${state === "running" ? "" : " dashed"}`} aria-hidden="true" />
      <span className={`dash-route tone-${tone}`}>
        {app.prefix}{port ? ` → :${port}` : ""} · {trip}
      </span>
      <span className={`dash-wire tone-${tone}${state === "running" ? "" : " dashed"}`} aria-hidden="true" />
      <article className={`dash-node tone-${tone}`}>
        <div className="dash-node-head">
          <span className="dash-node-icon" aria-hidden="true"><Icon size={22} /></span>
          <div className="dash-node-title">
            <h3>
              {name}
              {app.server?.version && <span className="dash-version">v{app.server.version}</span>}
            </h3>
            <span className="muted">{app.kind === "engine" ? t("controlDash:overview.roleEngine") : t("controlDash:overview.roleApp")}</span>
          </div>
          <StateLabel tone={tone} label={stateLabel} />
        </div>
        {state === "unset" ? (
          <p className="muted">{t("controlDash:overview.unsetNote")}</p>
        ) : (
          <dl className="dash-facts">
            <Fact label={t("controlDash:overview.address")} value={app.url ?? "—"} line />
            <Fact label={t("controlDash:overview.setBy")} value={setBy} />
            <Fact
              label={t("controlDash:overview.secret")}
              value={secret}
              tone={app.secretAccepted === false ? "warning" : undefined}
              title={app.secretAccepted === true && app.pairing ? t("controlDash:overview.secretPaired", { date: formatManagedDate(app.pairing.pairedAt) }) : undefined}
            />
            <Fact label={t("controlDash:overview.roundTrip")} value={trip} />
          </dl>
        )}
        {state === "down" && app.server?.error && <p className={`dash-node-note tone-${tone}`}>{app.server.error}</p>}
        <nav className="dash-links" aria-label={t("controlDash:overview.pagesOf", { name })}>
          {state === "running" && <a href={logsHref({ app: app.id })}>{t("controlDash:overview.linkEvents")}</a>}
          {state === "running" && <a href={logsHref({ app: app.id, log: "server" })}>{t("controlDash:overview.linkLog")}</a>}
          {app.id === "games" && app.configured && <a href={`${controlHref("invites")}#games-guest-links`}>{t("controlDash:overview.linkGuestLinks")}</a>}
          {app.id === "video" && state === "running" && <a href={controlHref("videoSettings")}>{t("controlDash:overview.linkVideoSettings")}</a>}
          <a href={appPageHref("appsAccess", app.id)}>{t("controlDash:overview.linkAccess")}</a>
          <a href={appPageHref("appsSetup", app.id)}>{t("controlDash:overview.linkSetup")}</a>
          {!app.stateless && <a href={containerBackupHref(app.id)}>{t("controlDash:overview.linkBackups")}</a>}
        </nav>
      </article>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function StateLabel({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`dash-state tone-${tone}`}>
      <span className={`dash-dot tone-${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** `line` is an address: a whole row of its own, in the mono face, never broken in
 *  two (too long for the card, it is cut and the rest is in the tooltip). The other
 *  facts share the row under the addresses. */
function Fact({ label, value, line, tone, title }: { label: string; value: string; line?: boolean; tone?: Tone; title?: string }) {
  return (
    <div className={line ? "dash-fact-line" : undefined}>
      <dt>{label}</dt>
      <dd
        className={[line ? "mono" : "", tone ? `tone-${tone}` : ""].filter(Boolean).join(" ") || undefined}
        title={line ? value : title}
      >
        {value}
      </dd>
    </div>
  );
}

function BackupRow({ name, href, when, stale, detail, note }: { name: string; href: string; when: string; stale: boolean; detail: string; note?: string }) {
  return (
    <a href={href} className="dash-backup-row">
      <span className="dash-backup-head">
        <span>{name}</span>
        <strong className={stale ? "tone-warning" : undefined}>{when}</strong>
      </span>
      <span className="muted">{detail}</span>
      {note && <span className="muted">{note}</span>}
    </a>
  );
}

function AppBackupRow({ app }: { app: AppBackupSummary }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();
  const newest = app.files[0];
  const source = newest && {
    own: t("controlDash:overview.backupOwn"),
    full: t("controlDash:system.fullBackup"),
    minimal: t("controlDash:overview.minimalBackup")
  }[newest.source];
  return (
    <BackupRow
      name={appName(app.id)}
      href={containerBackupHref(app.id)}
      when={newest ? relativeTime(newest.createdAt) : t("controlDash:system.noneYet")}
      stale={Boolean(newest && app.include && isStaleBackup(newest.createdAt))}
      detail={newest ? `${source} · ${formatManagedDate(newest.createdAt)}` : app.include ? t("controlDash:overview.backupAppHint") : t("controlDash:overview.backupLeftOut")}
      note={app.undo ? t("controlDash:overview.backupRestored", { date: formatManagedDate(app.undo.takenAt) }) : undefined}
    />
  );
}

type HoldingKind = Exclude<DiskHolding["kind"], "library">;

/** "Libraries: Books, Photos · database · backups" — libraries by name, the rest by kind. */
function describeHoldings(holds: DiskHolding[], kindLabel: Record<HoldingKind, string>, librariesLabel: (names: string) => string): string {
  const libraries = holds.flatMap((hold) => (hold.kind === "library" ? [hold.name] : []));
  const kinds = [...new Set(holds.flatMap((hold) => (hold.kind === "library" ? [] : [hold.kind])))];
  return [...(libraries.length ? [librariesLabel(libraries.join(", "))] : []), ...kinds.map((kind) => kindLabel[kind])].join(" · ");
}
