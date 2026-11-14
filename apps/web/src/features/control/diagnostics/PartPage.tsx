import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Archive, Boxes, Cpu, FileDown, FolderOpen, Gauge, HardDrive, ListChecks, ScrollText, Server, Stethoscope } from "lucide-react";
import { api } from "../../../api";
import { controlHref, diagnosticsPartHref, libraryManageHref, type DiagnosticsPart } from "../../../router";
import { Button } from "../../../shared/Button";
import { GroupedList, InfoRow, NavRow, PickerRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes, formatUptime } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";
import { activityHref, appPageHref, logsHref, tasksHref } from "../links";
import type { AppKey } from "../nav";
import { isRunning, useAppName, useAppsStatus } from "../sections/AppsSection";
import { HardwareTestPage } from "../sections/VideoHardwareTest";
import { conversionBody, GpuRow, useEngine, type ConversionSettings, type ConversionState, type HardwareMode } from "../sections/VideoSettingsSection";
import { HOME_PARTS, ReportDialog } from "./ReportDialog";
import { useDiagnosticsOverview, useProblemText, type LibraryCheck, type PartOverview } from "./overview";
import { LoggingControl, loggingUrl } from "./Logging";
import { speedVerdict, TestBar, useHomeTests, useRunWords, type FolderResult, type TestRun } from "./HomeTests";

// One part of iSputnik's page under Infrastructure › Diagnostics
// (docs/diagnostics-pages-plan.md): how it is, its checks with their tests beside
// them, and a column of where to look next — its log, activity and tasks, and for
// this server, how the other containers answer. A page of one thing: its own
// route, a back link, no tab row. Settings shown here are the application's own
// (Videos › Settings), read and saved through the same engine endpoint, never a copy.

/** The workspace whose Activity and Tasks a part's links filter to. */
const APPLICATION: Partial<Record<DiagnosticsPart, AppKey>> = { video: "videos", games: "games" };

const LIBRARY_TONE: Record<LibraryCheck["state"], "ok" | "warn" | "muted"> = { ok: "ok", missing: "warn", slow: "warn", scanFailed: "warn", container: "muted" };

export function DiagnosticsPartPage({ part }: { part: DiagnosticsPart }) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const appName = useAppName();
  const { parts, error, load } = useDiagnosticsOverview();
  const problemText = useProblemText();
  const [reporting, setReporting] = useState(false);
  const tests = useHomeTests(part === "home");
  const overview = parts?.find((entry) => entry.id === part) ?? null;
  const versionLine = useVersionLine();
  const name = part === "home" ? t("controlAdmin:diagnostics.home") : appName(part);

  return (
    <div className="diagnostics-section">
      <ControlSectionHead
        section="diagnostics"
        icon={<Stethoscope size={30} />}
        title={name}
        description={overview ? versionLine(overview) : undefined}
        back={{ href: controlHref("diagnostics"), label: t("controlAdmin:diagnostics.page.back") }}
      >
        <RefreshButton onRefresh={load} />
        <Button variant="primary" onClick={() => setReporting(true)}>
          <FileDown size={16} aria-hidden="true" />
          {t("controlAdmin:diagnostics.downloadReport")}
        </Button>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.overviewFailed")}>{error}</MessageBox>}
      {!parts && !error && <p className="muted">{t("controlAdmin:diagnostics.looking")}</p>}

      {overview && (
        <MessageBox
          tone={overview.state === "ok" ? "success" : overview.state === "off" ? "info" : "warning"}
          title={t(`controlAdmin:diagnostics.page.banner.${overview.state}`, { name })}
        >
          {overview.problems.length ? overview.problems.map(problemText).join(" · ") : t(`controlAdmin:diagnostics.page.bannerBody.${overview.state}`)}
        </MessageBox>
      )}

      {overview && (
        <div className="diagnostics-part-page">
          <div className="diagnostics-part-main">
            {part === "home" ? <HomeChecks overview={overview} tests={tests} /> : <Connection part={part} overview={overview} />}
            {part === "video" && overview.state !== "off" && <VideoChecks />}
          </div>
          <aside className="diagnostics-part-aside" aria-label={t("controlAdmin:diagnostics.page.asideLabel")}>
            {overview.state !== "off" && <LoggingCard part={part} name={name} reachable={overview.state !== "down"} />}
            {part === "home" && tests.state && tests.state.runs.length > 0 && <RecentRuns runs={tests.state.runs} />}
            {part === "home" && parts && <OtherContainers parts={parts} />}
            <LogsAndEvents part={part} />
          </aside>
        </div>
      )}

      {reporting && <ReportDialog parts={part === "home" ? HOME_PARTS : [`container:${part}`]} onClose={() => setReporting(false)} />}
    </div>
  );
}

function useVersionLine() {
  const { t } = useTranslation(["controlAdmin"]);
  return (overview: PartOverview): string => {
  if (overview.id === "home") return t("controlAdmin:diagnostics.thisServer", { version: overview.version ?? "?" });
  return overview.version ? t("controlAdmin:diagnostics.container", { version: overview.version }) : t("controlAdmin:diagnostics.containerNoVersion");
  };
}

// ── This server ────────────────────────────────────────────────────────────────

function HomeChecks({ overview, tests }: { overview: PartOverview; tests: ReturnType<typeof useHomeTests> }) {
  const { t } = useTranslation(["controlAdmin"]);
  const checks = overview.libraryChecks ?? [];
  const machine = overview.machine;
  const state = tests.state;
  const running = state?.running?.kind ?? null;
  const measured = new Map((state?.folders?.libraries ?? []).map((result) => [result.libraryId, result]));

  /** What the folder check found, in a line; the quick look's when it hasn't run. */
  const folderLine = (check: LibraryCheck): string => {
    const found = measured.get(check.id);
    const quick = t(`controlAdmin:diagnostics.page.libraries.state.${check.state}`);
    if (!found) return `${check.type} · ${quick}`;
    return `${check.type} · ${foundWords(found)}`;
  };
  const foundWords = (found: FolderResult): string => {
    if (found.verdict === "missing") return t("controlAdmin:diagnostics.tests.folders.missing");
    const answer = found.asleep
      ? t("controlAdmin:diagnostics.tests.folders.asleep", { first: found.firstMs, second: found.secondMs })
      : t("controlAdmin:diagnostics.tests.folders.answer", { ms: Math.min(found.firstMs ?? 0, found.secondMs ?? 0) });
    const reads = found.read ? t("controlAdmin:diagnostics.tests.folders.reads", { mbps: Math.round(found.read.mbitPerSecond) }) : t("controlAdmin:diagnostics.tests.folders.nothingToRead");
    return `${answer} · ${reads}`;
  };

  const backup = state?.backup;
  // When it was verified, not when it was made: the newest backup run says.
  const verifiedAt = state?.runs.find((run) => run.kind === "backup")?.at ?? null;
  const speed = state?.speed;
  return (
    <>
      {tests.error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.tests.failed")}>{tests.error}</MessageBox>}

      <GroupedList id="libraries" title={t("controlAdmin:diagnostics.page.libraries.title")} note={t("controlAdmin:diagnostics.page.libraries.note")}>
        <TestBar
          title={t("controlAdmin:diagnostics.tests.folders.title")}
          about={t("controlAdmin:diagnostics.tests.folders.about")}
          last={state?.folders ? t("controlAdmin:diagnostics.tests.checked", { when: relativeTime(state.folders.at) }) : null}
          running={running === "folders"}
          waits={running !== null && running !== "folders"}
          label={t("controlAdmin:diagnostics.tests.folders.run")}
          onRun={() => void tests.run("folders")}
        />
        {checks.length === 0 && <InfoRow label={t("controlAdmin:diagnostics.page.libraries.none")} />}
        {checks.map((check) => {
          const found = measured.get(check.id);
          const bad = found ? found.verdict !== "ok" : LIBRARY_TONE[check.state] === "warn";
          return (
            <NavRow
              key={check.id}
              icon={<FolderOpen size={17} />}
              iconTone={check.state === "container" ? "muted" : bad ? "warn" : "ok"}
              label={check.name}
              sub={folderLine(check)}
              value={found?.read ? t("controlAdmin:diagnostics.tests.folders.mbps", { mbps: Math.round(found.read.mbitPerSecond) }) : check.ms !== null ? t("controlAdmin:diagnostics.page.ms", { ms: check.ms }) : undefined}
              href={libraryManageHref(check.id)}
            />
          );
        })}
      </GroupedList>

      <GroupedList id="backups" title={t("controlAdmin:diagnostics.page.backups.title")}>
        <TestBar
          title={t("controlAdmin:diagnostics.tests.backup.title")}
          about={t("controlAdmin:diagnostics.tests.backup.about")}
          last={verifiedAt ? t("controlAdmin:diagnostics.tests.checked", { when: relativeTime(verifiedAt) }) : null}
          running={running === "backup"}
          waits={running !== null && running !== "backup"}
          disabled={!overview.lastBackup}
          label={t("controlAdmin:diagnostics.tests.backup.run")}
          onRun={() => void tests.run("backup")}
        />
        {running === "backup" && state?.running?.step && <InfoRow label={t("controlAdmin:diagnostics.tests.backup.reading")} sub={state.running.step} />}
        <InfoRow
          icon={<Archive size={17} />}
          iconTone={overview.lastBackup ? "ok" : "warn"}
          label={t("controlAdmin:diagnostics.page.backups.last")}
          sub={overview.lastBackup
            ? t("controlAdmin:diagnostics.page.backups.lastValue", { when: relativeTime(overview.lastBackup.at), kind: overview.lastBackup.kind, size: formatBytes(overview.lastBackup.sizeBytes) })
            : t("controlAdmin:diagnostics.page.backups.none")}
        />
        {backup && (
          <InfoRow
            icon={<Archive size={17} />}
            iconTone={backup.ok ? "ok" : "warn"}
            label={backup.ok ? t("controlAdmin:diagnostics.tests.backup.ok") : t("controlAdmin:diagnostics.tests.backup.bad")}
            sub={backup.ok
              ? t("controlAdmin:diagnostics.tests.backup.okSub", { when: relativeTime(backup.createdAt), count: backup.files, size: formatBytes(backup.bytes), tables: backup.database?.tables ?? 0 })
              : backup.error ?? (backup.database?.found ? t("controlAdmin:diagnostics.tests.backup.damaged", { problem: backup.database.integrity ?? "?" }) : t("controlAdmin:diagnostics.tests.backup.noDatabase"))}
          />
        )}
        {overview.backupError && <InfoRow iconTone="warn" icon={<Archive size={17} />} label={t("controlAdmin:diagnostics.page.backups.error")} sub={overview.backupError} />}
        <NavRow label={t("controlAdmin:diagnostics.page.backups.open")} href={controlHref("backup")} />
      </GroupedList>

      <GroupedList id="speed" title={t("controlAdmin:diagnostics.tests.speed.groupTitle")} note={t("controlAdmin:diagnostics.tests.speed.note")}>
        <TestBar
          title={t("controlAdmin:diagnostics.tests.speed.title")}
          about={t("controlAdmin:diagnostics.tests.speed.about")}
          last={speed ? t("controlAdmin:diagnostics.tests.checked", { when: relativeTime(speed.at) }) : null}
          running={tests.measuring}
          waits={false}
          label={t("controlAdmin:diagnostics.tests.speed.run")}
          onRun={() => void tests.measureSpeed()}
        />
        {speed && (
          <>
            <InfoRow icon={<Gauge size={17} />} label={t("controlAdmin:diagnostics.tests.speed.download")} value={t("controlAdmin:diagnostics.tests.folders.mbps", { mbps: Math.round(speed.downloadMbps) })} />
            <InfoRow label={t("controlAdmin:diagnostics.tests.speed.reply")} value={t("controlAdmin:diagnostics.page.ms", { ms: speed.replyMs })} />
            <InfoRow label={t("controlAdmin:diagnostics.tests.speed.enough")} value={t(`controlAdmin:diagnostics.tests.speed.verdict.${speedVerdict(speed.downloadMbps)}`)} />
          </>
        )}
      </GroupedList>

      {machine && (
        <GroupedList id="server" title={t("controlAdmin:diagnostics.page.server.title")}>
          <InfoRow icon={<Server size={17} />} label={t("controlAdmin:diagnostics.page.server.version")} value={overview.version ?? "?"} />
          {overview.uptimeSeconds !== undefined && <InfoRow label={t("controlAdmin:diagnostics.page.server.uptime")} value={formatUptime(overview.uptimeSeconds)} />}
          <InfoRow label={t("controlAdmin:diagnostics.page.server.system")} value={`${machine.os} · Node ${machine.node}`} />
          <InfoRow
            label={t("controlAdmin:diagnostics.page.server.memory")}
            value={t("controlAdmin:diagnostics.page.server.memoryValue", { cpus: machine.cpus, total: formatBytes(machine.memoryBytes), used: formatBytes(machine.rssBytes) })}
          />
        </GroupedList>
      )}
    </>
  );
}

function RecentRuns({ runs }: { runs: TestRun[] }) {
  const { t } = useTranslation(["controlAdmin"]);
  const words = useRunWords();
  return (
    <GroupedList title={t("controlAdmin:diagnostics.tests.recentTitle")}>
      {runs.slice(0, 5).map((run) => (
        <InfoRow key={`${run.kind}-${run.at}`} iconTone={run.ok ? "ok" : "warn"} icon={<ListChecks size={17} />} label={relativeTime(run.at)} sub={words(run)} />
      ))}
    </GroupedList>
  );
}

function OtherContainers({ parts }: { parts: PartOverview[] }) {
  const { t } = useTranslation(["controlAdmin"]);
  const appName = useAppName();
  const callsLine = useCallsLine();
  const others = parts.filter((entry) => entry.id !== "home");
  return (
    <GroupedList title={t("controlAdmin:diagnostics.page.others.title")} note={t("controlAdmin:diagnostics.page.others.note")}>
      {others.map((entry) => (
        <NavRow
          key={entry.id}
          icon={<Boxes size={17} />}
          iconTone={entry.state === "ok" ? "ok" : entry.state === "off" ? "muted" : "warn"}
          label={appName(entry.id)}
          sub={callsLine(entry)}
          value={entry.version ?? undefined}
          href={entry.state === "off" ? appPageHref("appsSetup", entry.id) : diagnosticsPartHref(entry.id as DiagnosticsPart)}
        />
      ))}
    </GroupedList>
  );
}

function useCallsLine() {
  const { t } = useTranslation(["controlAdmin"]);
  return (entry: PartOverview): string => {
  if (entry.state === "off") return t("controlAdmin:diagnostics.state.off");
  const calls = entry.calls;
  const counted = calls ? t("controlAdmin:diagnostics.page.others.calls", { count: calls.count, failed: calls.failed }) : "";
  const answer = entry.state === "down" ? t("controlAdmin:diagnostics.state.down") : t("controlAdmin:diagnostics.line.answers", { ms: entry.roundTripMs ?? "?" });
  return [answer, counted].filter(Boolean).join(" · ");
  };
}

// ── A container ────────────────────────────────────────────────────────────────

function Connection({ part, overview }: { part: DiagnosticsPart; overview: PartOverview }) {
  const { t } = useTranslation(["controlAdmin"]);
  const calls = overview.calls;
  return (
    <GroupedList id="connection" title={t("controlAdmin:diagnostics.page.connection.title")}>
      <InfoRow
        icon={<Boxes size={17} />}
        iconTone={overview.state === "ok" ? "ok" : overview.state === "off" ? "muted" : "warn"}
        label={t("controlAdmin:diagnostics.page.connection.state")}
        value={t(`controlAdmin:diagnostics.state.${overview.state}`)}
      />
      {overview.roundTripMs !== null && <InfoRow label={t("controlAdmin:diagnostics.page.connection.answers")} value={t("controlAdmin:diagnostics.page.ms", { ms: overview.roundTripMs })} />}
      {calls && overview.state !== "off" && (
        <InfoRow
          label={t("controlAdmin:diagnostics.page.connection.calls")}
          sub={t("controlAdmin:diagnostics.page.connection.since", { when: relativeTime(calls.since) })}
          value={t("controlAdmin:diagnostics.page.others.calls", { count: calls.count, failed: calls.failed })}
        />
      )}
      {calls?.lastFailedAt && (
        <InfoRow
          iconTone="warn"
          label={t("controlAdmin:diagnostics.page.connection.lastFailed")}
          value={t("controlAdmin:diagnostics.page.connection.lastFailedValue", { when: relativeTime(calls.lastFailedAt), status: calls.lastFailedStatus })}
        />
      )}
      <NavRow label={t("controlAdmin:diagnostics.action.pairing")} href={appPageHref("appsSetup", part)} />
    </GroupedList>
  );
}

/** Video's hardware and its tests: what the GPU does, where it converts, how fast, how many at once, and the disks. */
function VideoChecks() {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  if (!apps) return null;
  if (!video || !isRunning(video)) {
    return <MessageBox tone="info" title={t("controlAdmin:diagnostics.page.video.unavailableTitle")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>;
  }
  return <VideoHardware prefix={video.prefix} />;
}

function VideoHardware({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const url = `${prefix}/api/admin/conversion`;
  const conversion = useEngine<ConversionState>(url);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const state = conversion.state;

  const save = async (patch: Partial<ConversionSettings>) => {
    if (!state) return;
    setSaving(true);
    setError("");
    try {
      conversion.setState(await api<ConversionState>(url, { method: "PUT", body: JSON.stringify(conversionBody(state.settings, patch)) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.conversion.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const settingsHref = `${controlHref("videoSettings")}?show=conversion`;
  const disk = state?.disk;
  return (
    <>
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.conversion.saveFailed")}>{error}</MessageBox>}
      {conversion.missing && <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.loadFailed")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>}
      {state && (
        <GroupedList id="hardware" title={t("controlAdmin:diagnostics.page.video.hardwareTitle")} note={t("controlAdmin:diagnostics.page.video.hardwareNote")}>
          {state.hardware ? <GpuRow hardware={state.hardware} /> : <InfoRow icon={<Cpu size={17} />} iconTone="muted" label={t("controlAdmin:apps.conversion.gpuNoneTitle")} />}
          {state.settings.hardware && (
            <PickerRow
              label={t("controlAdmin:apps.conversion.hardwareLabel")}
              value={state.settings.hardware}
              disabled={saving}
              options={[
                { value: "auto", label: t("controlAdmin:apps.conversion.hardwareAuto") },
                { value: "cpu", label: t("controlAdmin:apps.conversion.hardwareCpu") },
                { value: "gpu", label: t("controlAdmin:apps.conversion.hardwareGpu") }
              ]}
              onChange={(value) => void save({ hardware: value as HardwareMode })}
            />
          )}
          <InfoRow label={t("controlAdmin:diagnostics.page.video.atOnce")} value={String(state.settings.maxViewers)} />
          {disk && (
            <InfoRow
              icon={<HardDrive size={17} />}
              iconTone={disk.mapped ? "ok" : "muted"}
              label={t("controlAdmin:diagnostics.page.video.disk")}
              value={disk.mapped && disk.freeBytes !== null ? t("controlAdmin:diagnostics.page.video.diskFree", { free: formatBytes(disk.freeBytes) }) : t("controlAdmin:diagnostics.page.video.diskNone")}
            />
          )}
          <NavRow label={t("controlAdmin:diagnostics.page.video.allSettings")} href={settingsHref} />
        </GroupedList>
      )}
      <div id="tests" className="diagnostics-part-tests">
        <HardwareTestPage prefix={prefix} capabilities={null} maxViewers={state?.settings.maxViewers ?? null} saving={saving} onUseLimit={(count) => void save({ maxViewers: count })} />
      </div>
    </>
  );
}

// ── Where to look next ─────────────────────────────────────────────────────────

function LoggingCard({ part, name, reachable }: { part: DiagnosticsPart; name: string; reachable: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const prefix = part === "home" ? null : apps?.find((app) => app.id === part)?.prefix;
  const url = part === "home" ? loggingUrl(null) : prefix && reachable ? loggingUrl(prefix) : null;
  return (
    <section className="organization-card diagnostics-logging-card" aria-labelledby="diagnostics-logging-title">
      <h3 id="diagnostics-logging-title">{t("controlAdmin:diagnostics.logging.label")}</h3>
      {url ? <LoggingControl url={url} name={name} /> : <p className="muted">{t("controlAdmin:diagnostics.logging.cannot")}</p>}
      <p className="muted">{t("controlAdmin:diagnostics.logging.help")}</p>
    </section>
  );
}

function LogsAndEvents({ part }: { part: DiagnosticsPart }) {
  const { t } = useTranslation(["controlAdmin"]);
  const application = APPLICATION[part];
  return (
    <GroupedList title={t("controlAdmin:diagnostics.page.logs.title")}>
      <NavRow icon={<ScrollText size={17} />} label={t("controlAdmin:diagnostics.page.logs.log")} sub={t("controlAdmin:diagnostics.page.logs.logSub")} href={part === "home" ? logsHref() : logsHref({ app: part })} />
      <NavRow icon={<Activity size={17} />} label={t("controlAdmin:diagnostics.page.logs.activity")} sub={t("controlAdmin:diagnostics.page.logs.activitySub")} href={activityHref(application ? { application } : {})} />
      <NavRow icon={<ListChecks size={17} />} label={t("controlAdmin:diagnostics.page.logs.tasks")} sub={t("controlAdmin:diagnostics.page.logs.tasksSub")} href={tasksHref(application ? { application } : {})} />
    </GroupedList>
  );
}
