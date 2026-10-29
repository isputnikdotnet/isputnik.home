import { useTranslation } from "react-i18next";
import {
  Archive,
  ChevronRight,
  Clock3,
  Database,
  Gamepad2,
  HardDrive,
  House,
  KeyRound,
  MemoryStick,
  ScrollText,
  ShieldCheck,
  Tv,
  type LucideIcon
} from "lucide-react";
import { controlHref } from "../../../../router";
import { MessageBox } from "../../../../shared/MessageBox";
import { formatBytes, formatManagedDate, formatUptime } from "../../../../shared/utils";
import { relativeTime } from "../../../../shared/relativeTime";
import { formatNumber } from "../../../../shared/dates";
import { appPageHref, logsHref, storageHref, tasksHref } from "../../links";
import { signInsHref } from "./SignInsView";
import type { AppStatus } from "../AppsSection";
import type { SystemStatus } from "../../types";
import type { DashboardDisk, DashboardOverview, DiskHolding, LastBackup, OwnedDisk } from "./useDashboardOverview";

// Overview › Dashboard (docs/dashboard-and-backups-plan.md): Home and the
// containers beside it on one page. It reads and points; every setting stays on
// its own page. From the top: what needs a look (or one quiet line), Home with
// its gateway and a branch per container, security and the last day's problems,
// then the disks Home's files sit on and the last backup.

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
  return (id: string) => (id === "games" ? t("nav.games") : id === "video" ? t("nav.video") : id);
}

const APP_ICONS: Record<string, LucideIcon> = { games: Gamepad2, video: Tv };

/** Every disk on the page — home's, then each engine's — with the other mounts of
 *  its filesystem named. Within one container the device id says so; across two
 *  (home and Video on one Unraid user share) the id must match AND the size, so
 *  a coincidence between two hosts' device numbers is never called a share. */
function allDisks(overview: DashboardOverview | null, appDisks: OwnedDisk[]): (OwnedDisk & { shared: { owner: string; mount: string }[] })[] {
  const disks: OwnedDisk[] = [...(overview?.disks ?? []).map((disk) => ({ ...disk, owner: "home" })), ...appDisks];
  return disks.map((disk) => ({
    ...disk,
    shared: disks
      .filter((other) => other !== disk && other.filesystem === disk.filesystem && (other.owner === disk.owner || other.totalBytes === disk.totalBytes))
      .map((other) => ({ owner: other.owner, mount: other.mount }))
  }));
}

/** One key per filesystem, so a low disk is reported once, not once per mount. */
const filesystemKey = (disk: OwnedDisk) => `${disk.filesystem}:${disk.totalBytes}`;

interface Issue {
  tone: Tone;
  text: string;
  href: string;
}

export function Overview({
  status,
  overview,
  apps,
  lastBackup,
  appErrors,
  appDisks
}: {
  status: SystemStatus;
  overview: DashboardOverview | null;
  apps: AppStatus[] | null;
  lastBackup: LastBackup | null | undefined;
  appErrors: Record<string, number | null>;
  appDisks: OwnedDisk[];
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();

  // ── What needs a look, worst first ─────────────────────────────────────────
  const issues: Issue[] = [];
  for (const app of apps ?? []) {
    const state = appState(app);
    if (state === "down") issues.push({ tone: "danger", text: t("controlDash:overview.issueAppDown", { app: appName(app.id) }), href: appPageHref("appsSetup", app.id) });
    if (state === "secret") issues.push({ tone: "danger", text: t("controlDash:overview.issueAppSecret", { app: appName(app.id) }), href: appPageHref("appsSetup", app.id) });
  }
  const disks = allDisks(overview, appDisks);
  const reported = new Set<string>();
  for (const disk of disks) {
    const tone = diskTone(disk);
    if ((tone === "danger" || tone === "warning") && !reported.has(filesystemKey(disk))) {
      reported.add(filesystemKey(disk));
      issues.push({
        tone,
        text: t("controlDash:overview.issueDiskLow", { mount: disk.mount, share: Math.round((disk.freeBytes / disk.totalBytes) * 100) }),
        href: storageHref()
      });
    }
  }
  if (lastBackup === null) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueNoBackup"), href: controlHref("backup") });
  } else if (lastBackup?.stale) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueOldBackup", { when: relativeTime(lastBackup.createdAt) }), href: controlHref("backup") });
  }
  if (overview && overview.failedTasks24h > 0) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueFailedTasks", { count: overview.failedTasks24h }), href: tasksHref({ status: "failed" }) });
  }
  for (const app of apps ?? []) {
    const errors = appErrors[app.id];
    if (errors) issues.push({ tone: "warning", text: t("controlDash:overview.issueAppErrors", { app: appName(app.id), count: errors }), href: logsHref({ app: app.id, level: "error" }) });
  }
  if (overview && overview.failedSignIns24h >= FAILED_SIGN_INS_NOTICE) {
    issues.push({ tone: "warning", text: t("controlDash:overview.issueFailedSignIns", { count: overview.failedSignIns24h }), href: signInsHref({}) });
  }
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));

  return (
    <div className="dash">
      {issues.length > 0 ? (
        <MessageBox tone={issues[0].tone === "danger" ? "error" : "warning"} title={t("controlDash:overview.attentionTitle", { count: issues.length })}>
          <ul className="dash-issues">
            {issues.map((issue) => (
              <li key={issue.text}>
                <a href={issue.href} className="dash-issue">
                  <span className={`dash-dot tone-${issue.tone}`} aria-hidden="true" />
                  <span className="dash-issue-text">{issue.text}</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </MessageBox>
      ) : (
        <MessageBox tone="success" title={t("controlDash:overview.allClearTitle")}>
          {t("controlDash:overview.allClearBody")}
        </MessageBox>
      )}

      <Services status={status} overview={overview} apps={apps} />

      <div className="dash-pair">
        <section className="dash-card" aria-labelledby="dash-security">
          <div className="dash-card-head">
            <ShieldCheck size={18} aria-hidden="true" />
            <h2 id="dash-security">{t("controlDash:overview.securityTitle")}</h2>
            <a href={controlHref("security")}>{t("controlDash:overview.securityLink")}</a>
          </div>
          <div className="dash-figures">
            <Figure href={controlHref("users")} value={formatNumber(status.users)} label={t("controlDash:system.members")} />
            <Figure href={signInsHref({})} value={formatNumber(status.activeSessions)} label={t("controlDash:system.devices")} />
            <Figure href={controlHref("invites")} value={formatNumber(status.activeInvites)} label={t("controlDash:system.invites")} />
            <Figure
              href={signInsHref({})}
              value={overview ? formatNumber(overview.failedSignIns24h) : "…"}
              label={t("controlDash:overview.failedSignIns")}
              tone={overview && overview.failedSignIns24h >= FAILED_SIGN_INS_NOTICE ? "warning" : undefined}
            />
          </div>
        </section>

        <section className="dash-card" aria-labelledby="dash-problems">
          <div className="dash-card-head">
            <ScrollText size={18} aria-hidden="true" />
            <h2 id="dash-problems">{t("controlDash:overview.problemsTitle")}</h2>
            <span className="muted">{t("controlDash:overview.auditEntries", { count: status.logEntries, formatted: formatNumber(status.logEntries) })}</span>
          </div>
          <ul className="dash-problems">
            <ProblemRow
              name={t("controlDash:overview.homeShort")}
              what={t("controlDash:overview.problemsTasks")}
              count={overview ? overview.failedTasks24h : null}
              href={tasksHref({ status: "failed" })}
            />
            {(apps ?? []).filter((app) => app.configured).map((app) => (
              <ProblemRow
                key={app.id}
                name={appName(app.id)}
                what={t("controlDash:overview.problemsEvents")}
                count={app.server?.ok ? (appErrors[app.id] ?? null) : null}
                href={logsHref({ app: app.id, level: "error" })}
              />
            ))}
          </ul>
        </section>
      </div>

      <section className="dash-card" aria-labelledby="dash-storage">
        <div className="dash-card-head">
          <HardDrive size={18} aria-hidden="true" />
          <h2 id="dash-storage">{t("controlDash:overview.storageTitle")}</h2>
          <a href={storageHref()}>{t("controlDash:overview.storageLink")}</a>
        </div>
        <div className="dash-storage">
          <div className="dash-disks">
            {overview === null && <p className="muted">{t("controlDash:overview.disksUnknown")}</p>}
            {disks.map((disk) => <DiskRow key={`${disk.owner}:${disk.mount}`} disk={disk} />)}
            <p className="dash-note">{t("controlDash:overview.disksHelp")}</p>
          </div>
          <div className="dash-side">
            <dl className="dash-stats">
              <Stat icon={MemoryStick} label={t("controlDash:system.memory")} value={formatBytes(status.memory.rssBytes)} />
              <Stat icon={Database} label={t("controlDash:system.database")} value={formatBytes(status.databaseBytes)} />
              <Stat icon={Clock3} label={t("controlDash:system.uptime")} value={formatUptime(status.uptimeSeconds)} />
            </dl>
            <a href={controlHref("backup")} className="dash-backup">
              <span className="dash-backup-label"><Archive size={16} aria-hidden="true" />{t("controlDash:system.lastBackup")}</span>
              <strong>
                {lastBackup === undefined ? "…" : lastBackup ? relativeTime(lastBackup.createdAt) : t("controlDash:system.noneYet")}
              </strong>
              <span className="muted">
                {lastBackup
                  ? `${lastBackup.kind === "full" ? t("controlDash:system.fullBackup") : lastBackup.kind === "minimal" ? t("controlDash:overview.minimalBackup") : t("controlDash:system.databaseOnly")} · ${formatManagedDate(lastBackup.createdAt)}`
                  : t("controlDash:system.backupHint")}
              </span>
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Services: Home, its gateway, a branch per container ──────────────────────

function Services({ status, overview, apps }: { status: SystemStatus; overview: DashboardOverview | null; apps: AppStatus[] | null }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const homeAddress = overview?.home.addresses.length
    ? overview.home.addresses.map((address) => `${address}:${overview.home.port}`).join(", ")
    : overview ? `:${overview.home.port}` : "…";

  return (
    <section className="dash-section" aria-labelledby="dash-services">
      <div className="dash-section-head">
        <h2 id="dash-services">{t("controlDash:overview.servicesTitle")}</h2>
        <span className="muted">{t("controlDash:overview.servicesNote")}</span>
        <a href={controlHref("appsSetup")}>{t("controlDash:overview.servicesLink")}</a>
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
            <Fact label={t("controlDash:overview.address")} value={homeAddress} mono />
            <Fact label={t("controlDash:overview.publicAddress")} value={overview?.home.publicUrl ?? "…"} mono />
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
    ? app.pairing
      ? t("controlDash:overview.secretPaired", { date: formatManagedDate(app.pairing.pairedAt) })
      : t("controlDash:overview.secretAccepted")
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
            <Fact label={t("controlDash:overview.address")} value={app.url ?? "—"} mono />
            <Fact label={t("controlDash:overview.setBy")} value={setBy} />
            <Fact label={t("controlDash:overview.secret")} value={secret} tone={app.secretAccepted === false ? "warning" : undefined} />
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

function Fact({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: Tone }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={[mono ? "mono" : "", tone ? `tone-${tone}` : ""].filter(Boolean).join(" ") || undefined}>{value}</dd>
    </div>
  );
}

function Figure({ href, value, label, tone }: { href: string; value: string; label: string; tone?: Tone }) {
  return (
    <a href={href} className="dash-figure">
      <strong className={tone ? `tone-${tone}` : undefined}>{value}</strong>
      <span>{label}</span>
    </a>
  );
}

function ProblemRow({ name, what, count, href }: { name: string; what: string; count: number | null; href: string }) {
  return (
    <li>
      <a href={href} className="dash-problem">
        <strong>{name}</strong>
        <span className="muted">{what}</span>
        <span className={`dash-problem-count${count ? " tone-warning" : ""}`}>{count === null ? "—" : formatNumber(count)}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </a>
    </li>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div>
      <dt><Icon size={14} aria-hidden="true" />{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DiskRow({ disk }: { disk: OwnedDisk & { shared: { owner: string; mount: string }[] } }) {
  const { t } = useTranslation(["common", "controlDash"]);
  const appName = useAppName();
  const ownerName = (owner: string) => (owner === "home" ? t("controlDash:overview.homeShort") : appName(owner));
  const tone = diskTone(disk);
  const usedShare = disk.totalBytes > 0 ? Math.min(100, Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)) : 0;
  return (
    <div className={`dash-disk tone-${tone}`}>
      <div className="dash-disk-head">
        <code>{disk.mount}</code>
        <span className="dash-disk-owner">{ownerName(disk.owner)}</span>
        <span className={`dash-disk-free tone-${tone}`}>
          {t("controlDash:overview.diskFree", { free: formatBytes(disk.freeBytes), total: formatBytes(disk.totalBytes) })}
        </span>
      </div>
      <div
        className="dash-disk-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedShare}
        aria-label={t("controlDash:overview.diskUsedLabel", { mount: disk.mount, share: usedShare })}
      >
        <span className={`tone-${tone}`} style={{ width: `${usedShare}%` }} />
      </div>
      <span className="muted">
        {describeHoldings(disk.holds, {
          database: t("controlDash:overview.holdDatabase"),
          systemData: t("controlDash:overview.holdSystemData"),
          thumbnails: t("controlDash:overview.holdThumbnails"),
          backups: t("controlDash:overview.holdBackups"),
          appFiles: t("controlDash:overview.holdAppFiles"),
          trash: t("controlDash:overview.holdTrash"),
          artwork: t("controlDash:overview.holdArtwork"),
          transcode: t("controlDash:overview.holdTranscode")
        }, (names) => t("controlDash:overview.holdLibraries", { names }))}
      </span>
      {disk.shared.length > 0 && (
        <span className="dash-disk-shared">
          {t("controlDash:overview.diskShared", {
            mounts: disk.shared.map((other) => (other.owner === disk.owner ? other.mount : `${ownerName(other.owner)} ${other.mount}`)).join(", ")
          })}
        </span>
      )}
    </div>
  );
}

type HoldingKind = Exclude<DiskHolding["kind"], "library">;

/** "Libraries: Books, Photos · database · backups" — libraries by name, the rest by kind. */
function describeHoldings(holds: DiskHolding[], kindLabel: Record<HoldingKind, string>, librariesLabel: (names: string) => string): string {
  const libraries = holds.flatMap((hold) => (hold.kind === "library" ? [hold.name] : []));
  const kinds = [...new Set(holds.flatMap((hold) => (hold.kind === "library" ? [] : [hold.kind])))];
  return [...(libraries.length ? [librariesLabel(libraries.join(", "))] : []), ...kinds.map((kind) => kindLabel[kind])].join(" · ");
}
