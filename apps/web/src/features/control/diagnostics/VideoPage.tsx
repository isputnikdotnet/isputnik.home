import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, Cpu, FileText, Gauge, MemoryStick, Minus, MonitorPlay, Network, Play as PlayIcon, RefreshCw, Shuffle } from "lucide-react";
import { api } from "../../../api";
import { controlHref, diagnosticsPartHref, followRoute, libraryManageHref, type DiagnosticsTab } from "../../../router";
import { Button } from "../../../shared/Button";
import { GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RouteTab } from "../../../shared/RouteTab";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";
import { AppLog, isRunning, useAppsStatus } from "../sections/AppsSection";
import { clockOf, NowPlayingList } from "../sections/NowPlayingSection";
import { HardwareTestPage, type HardwareTest } from "../sections/VideoHardwareTest";
import { CODEC_NAMES, conversionBody, GpuRow, useEngine, type ConversionSettings, type ConversionState, type HardwareState } from "../sections/VideoSettingsSection";
import { SavedReports, useSavedReports } from "./SavedReports";
import { useWatching, type Play } from "./Watching";

// Diagnostics › Video (docs/diagnostics-pages-plan.md; redrawn 2026-11-17 with tabs,
// the one part page allowed a row of them): Overview — the GPU, the machine right
// now, who is watching, the last GPU test — with its capabilities, diagnostic mode
// and the newest saved reports in a narrow column; then GPU tests, Live sessions,
// Logs and Reports, each the page those already are, not a copy. "Right now" is read
// only while the page is open and kept nowhere but here: its little graphs are the
// last ten minutes of what the page itself read.

const TABS: DiagnosticsTab[] = ["overview", "tests", "sessions", "logs", "reports"];

export function VideoPartBody({ tab, saved, modeCard, logLinks }: {
  tab: DiagnosticsTab;
  /** Saved reports with Video in them: the part page's, so a report saved there shows. */
  saved: ReturnType<typeof useSavedReports>;
  /** Diagnostic mode (Normal · Detailed · Full), the part page's own card. */
  modeCard: ReactNode;
  /** Where else to look: its log, activity and tasks pages. */
  logLinks: ReactNode;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const prefix = video && isRunning(video) ? video.prefix : null;
  const watching = useWatching(prefix);
  const sessions = watching.plays ? watching.plays.filter((play) => play.kind !== "download").length : null;

  const tabLabel = (id: DiagnosticsTab) => {
    const count = id === "sessions" ? sessions : id === "reports" ? saved.reports?.length ?? null : null;
    return (
      <>
        {t(`controlAdmin:diagnostics.video.tab.${id}`)}
        {count ? <span className="diag-tab-count">{count}</span> : null}
      </>
    );
  };

  return (
    <>
      <div className="control-tabs diag-video-tabs" role="tablist" aria-label={t("controlAdmin:diagnostics.video.tabsAria")}>
        {TABS.map((id) => (
          <RouteTab key={id} selected={id === tab} className={id === tab ? "active" : undefined} href={diagnosticsPartHref("video", id)} onClick={followRoute}>
            {tabLabel(id)}
          </RouteTab>
        ))}
      </div>

      {apps && !prefix && (
        <MessageBox tone="info" title={t("controlAdmin:diagnostics.page.video.unavailableTitle")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>
      )}

      {tab === "overview" && prefix && <Overview prefix={prefix} plays={watching.plays} saved={saved} modeCard={modeCard} />}
      {tab === "tests" && prefix && <TestsTab prefix={prefix} />}
      {tab === "sessions" && prefix && <NowPlayingList plays={watching.plays} missing={watching.missing} />}
      {tab === "logs" && (
        <div className="diag-video">
          <div className="diag-video-main">{prefix && <AppLog prefix={prefix} />}</div>
          <aside className="diag-video-side">
            {modeCard}
            {logLinks}
          </aside>
        </div>
      )}
      {tab === "reports" && <SavedReports saved={saved} />}
    </>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────

function Overview({ prefix, plays, saved, modeCard }: { prefix: string; plays: Play[] | null; saved: ReturnType<typeof useSavedReports>; modeCard: ReactNode }) {
  const conversion = useEngine<ConversionState>(`${prefix}/api/admin/conversion`);
  return (
    <div className="diag-video">
      <div className="diag-video-main">
        <GpuCard prefix={prefix} conversion={conversion} />
        <RightNow plays={plays} conversion={conversion.state} />
        <LiveSessions plays={plays} />
        <TestSummary prefix={prefix} />
        <CatalogWork prefix={prefix} />
      </div>
      <aside className="diag-video-side">
        {conversion.state?.hardware && <Capabilities hardware={conversion.state.hardware} />}
        {modeCard}
        <SavedMini saved={saved} />
      </aside>
    </div>
  );
}

/** Intel, AMD or NVIDIA, from the driver vainfo names: the picture to show. */
export function gpuMaker(hardware: Pick<HardwareState, "driver">): "intel" | "amd" | "nvidia" | "other" {
  const driver = hardware.driver ?? "";
  if (/intel|\biHD\b|i965/i.test(driver)) return "intel";
  if (/\bAMD\b|radeon|gallium/i.test(driver)) return "amd";
  if (/nvidia|nouveau/i.test(driver)) return "nvidia";
  return "other";
}

type GpuState = "inUse" | "setAside" | "cpuOnly" | "none" | "checking";
function gpuState(hardware: HardwareState): GpuState {
  if (hardware.mode === "cpu") return "cpuOnly";
  if (hardware.checking && !hardware.encode && !hardware.error) return "checking";
  if (!hardware.encode) return "none";
  return hardware.setAside ? "setAside" : "inUse";
}
const GPU_PILL: Record<GpuState, string> = { inUse: "is-ready", setAside: "is-needsSetup", cpuOnly: "is-off", none: "is-needsSetup", checking: "is-off" };

function GpuCard({ prefix, conversion }: { prefix: string; conversion: ReturnType<typeof useEngine<ConversionState>> }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [checking, setChecking] = useState(false);
  const hardware = conversion.state?.hardware ?? null;
  if (conversion.missing) return <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.loadFailed")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>;
  if (!conversion.state) return null;

  const check = async () => {
    setChecking(true);
    try {
      conversion.setState(await api<ConversionState>(`${prefix}/api/admin/conversion/check`, { method: "POST" }));
    } catch {
      /* the card keeps what it last knew */
    } finally {
      setChecking(false);
    }
  };

  const maker = hardware ? gpuMaker(hardware) : "other";
  const state = hardware ? gpuState(hardware) : "none";
  const checks = hardware ? [
    { key: "found", ok: hardware.device !== null },
    { key: "driver", ok: hardware.driver !== null },
    { key: "encodes", ok: hardware.encode },
    { key: "ready", ok: state === "inUse" }
  ] as const : [];
  const mode = conversion.state.settings.hardware ?? "auto";

  return (
    <section className="organization-card diag-gpu" aria-labelledby="diag-gpu-title">
      <div className={`diag-gpu-picture is-${maker}`} aria-hidden="true">
        {/* The maker's picture goes here once there are pictures; until then, a chip. */}
        <Cpu size={34} />
        <span>{t(`controlAdmin:diagnostics.video.gpu.maker.${maker}`)}</span>
      </div>
      <div className="diag-gpu-text">
        <div className="diag-gpu-name">
          <h3 id="diag-gpu-title">{hardware && hardware.encode ? t(`controlAdmin:diagnostics.video.gpu.title.${maker}`) : t("controlAdmin:diagnostics.video.gpu.title.none")}</h3>
          <span className={`app-status-pill ${GPU_PILL[state]}`}>{t(`controlAdmin:diagnostics.video.gpu.state.${state}`)}</span>
        </div>
        <dl className="diag-gpu-facts">
          {hardware?.driver && <><dt>{t("controlAdmin:diagnostics.video.gpu.driver")}</dt><dd>{hardware.driver}</dd></>}
          {hardware?.device && <><dt>{t("controlAdmin:diagnostics.video.gpu.device")}</dt><dd>{t("controlAdmin:diagnostics.video.gpu.vaapi", { device: hardware.device })}</dd></>}
          <dt>{t("controlAdmin:diagnostics.video.gpu.mode")}</dt>
          <dd>{t(`controlAdmin:diagnostics.video.gpu.modeValue.${mode}`)}</dd>
        </dl>
        {hardware?.error && state !== "inUse" && <p className="diag-gpu-error">{hardware.error}</p>}
        <ul className="diag-gpu-checks">
          {checks.map((entry) => (
            <li key={entry.key} className={entry.ok ? "is-ok" : "is-no"}>
              {entry.ok ? <Check size={14} aria-hidden="true" /> : <Minus size={14} aria-hidden="true" />}
              {t(`controlAdmin:diagnostics.video.gpu.check.${entry.key}`)}
            </li>
          ))}
        </ul>
        <div className="diag-gpu-actions">
          <Button variant="secondary" compact onClick={() => void check()} disabled={checking || hardware?.checking}>
            <RefreshCw size={14} aria-hidden="true" />
            {checking || hardware?.checking ? t("controlAdmin:apps.conversion.checking") : t("controlAdmin:apps.conversion.checkAgain")}
          </Button>
          <a className="diag-link" href={`${controlHref("videoSettings")}?show=conversion`} onClick={(event) => followRoute(event, `${controlHref("videoSettings")}?show=conversion`)}>
            {t("controlAdmin:diagnostics.video.gpu.settings")}
          </a>
        </div>
      </div>
    </section>
  );
}

/** What the GPU decodes and encodes, format by format; and where HDR and subtitles are done. */
function Capabilities({ hardware }: { hardware: HardwareState }) {
  const { t } = useTranslation(["controlAdmin"]);
  const decodes = new Set(hardware.decode);
  const known = hardware.encodeFormats !== undefined;
  const encodes = new Set(hardware.encodeFormats ?? (hardware.encode ? ["h264"] : []));
  const rows = ["h264", "hevc", "hevc10", "vp9", "av1", ...(["vp9_10", "mpeg2video", "vc1"].filter((key) => decodes.has(key) || encodes.has(key)))];
  const mark = (on: boolean, label: string) => (
    <td className={on ? "is-ok" : "is-no"}>
      {on ? <Check size={14} aria-label={label} /> : <Minus size={14} aria-label={label} />}
    </td>
  );
  const yes = t("controlAdmin:diagnostics.video.caps.yes");
  const no = t("controlAdmin:diagnostics.video.caps.no");
  const usable = hardware.mode !== "cpu" && hardware.encode;
  return (
    <section className="organization-card diag-side-card" aria-labelledby="diag-caps-title">
      <h3 id="diag-caps-title">{t("controlAdmin:diagnostics.video.caps.title")}</h3>
      <table className="diag-caps">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">{t("controlAdmin:diagnostics.video.caps.format")}</span></th>
            <th scope="col">{t("controlAdmin:diagnostics.video.caps.decode")}</th>
            <th scope="col">{t("controlAdmin:diagnostics.video.caps.encode")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((key) => (
            <tr key={key}>
              <th scope="row">{CODEC_NAMES[key] ?? key}</th>
              {mark(usable && decodes.has(key), decodes.has(key) ? yes : no)}
              {key === "h264" || known ? mark(usable && encodes.has(key), encodes.has(key) ? yes : no) : <td className="is-unknown">?</td>}
            </tr>
          ))}
          {hardware.tonemap !== undefined && (
            <tr><th scope="row">{t("controlAdmin:diagnostics.video.caps.tonemap")}</th><td colSpan={2} className={hardware.tonemap && usable ? "is-ok" : "is-no"}>{hardware.tonemap && usable ? t("controlAdmin:diagnostics.video.caps.gpu") : t("controlAdmin:diagnostics.video.caps.cpu")}</td></tr>
          )}
          {hardware.overlay !== undefined && (
            <tr><th scope="row">{t("controlAdmin:diagnostics.video.caps.subtitles")}</th><td colSpan={2} className={hardware.overlay && usable ? "is-ok" : "is-no"}>{hardware.overlay && usable ? t("controlAdmin:diagnostics.video.caps.gpu") : t("controlAdmin:diagnostics.video.caps.cpu")}</td></tr>
          )}
        </tbody>
      </table>
      <p className="muted">{known ? t("controlAdmin:diagnostics.video.caps.note") : t("controlAdmin:diagnostics.video.caps.noteOld")}</p>
    </section>
  );
}

// ── Right now ──────────────────────────────────────────────────────────────────

interface ServerNow {
  at: string;
  cpu: { percent: number; cores: number; load: [number, number, number] | null };
  memory: { totalBytes: number; availableBytes: number; homeBytes: number };
}

const POLL_MS = 5000;
/** Ten minutes of readings, one every five seconds. */
const KEEP = 120;

/** The machine every few seconds while the page is open, and the readings so far. */
function useServerNow() {
  const [now, setNow] = useState<ServerNow | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const body = await api<ServerNow>("/api/admin/diagnostics/now");
        if (live) {
          setNow(body);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  return { now, failed };
}

type Series = "speed" | "cpu" | "memory" | "sending";
type Histories = { tick: string | null } & Record<Series, number[]>;

/** The last KEEP readings of each, one added each time the server is read (`tick`):
 *  state adjusted while rendering, React's way of keeping what follows from a prop. */
function useHistories(tick: string | undefined, values: Record<Series, number | null>): Record<Series, number[]> {
  const [histories, setHistories] = useState<Histories>({ tick: null, speed: [], cpu: [], memory: [], sending: [] });
  if (tick && tick !== histories.tick) {
    const add = (series: Series) => {
      const value = values[series];
      return value !== null && Number.isFinite(value) ? [...histories[series], value].slice(-KEEP) : histories[series];
    };
    setHistories({ tick, speed: add("speed"), cpu: add("cpu"), memory: add("memory"), sending: add("sending") });
  }
  return histories;
}

function RightNow({ plays, conversion }: { plays: Play[] | null; conversion: ConversionState | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { now, failed } = useServerNow();
  const converting = (plays ?? []).filter((play) => play.kind === "converted" && play.converting && play.converter !== null && !play.kept);
  const speeds = converting.map((play) => play.speed).filter((speed): speed is number => typeof speed === "number");
  const slowest = speeds.length ? Math.min(...speeds) : null;
  const viewers = (plays ?? []).filter((play) => play.kind !== "download").length;
  const sending = (plays ?? []).reduce((sum, play) => sum + (play.mbps ?? 0), 0);
  const memoryUsed = now ? ((now.memory.totalBytes - now.memory.availableBytes) / now.memory.totalBytes) * 100 : null;

  const { speed: speedHistory, cpu: cpuHistory, memory: memoryHistory, sending: sendingHistory } = useHistories(now?.at, {
    speed: slowest,
    cpu: now?.cpu.percent ?? null,
    memory: memoryUsed,
    sending: plays ? sending : null
  });

  const speedRow = converting.length === 0
    ? { sub: t("controlAdmin:diagnostics.video.now.speedNone"), verdict: null }
    : slowest === null
      ? { sub: t("controlAdmin:diagnostics.video.now.speedOld", { count: converting.length }), verdict: null }
      : {
          sub: t("controlAdmin:diagnostics.video.now.speedValue", { title: converting.find((play) => play.speed === slowest)?.heading ?? converting[0].title, speed: slowest.toLocaleString(undefined, { maximumFractionDigits: 1 }) }),
          verdict: slowest >= 1 ? ({ tone: "ok", label: t("controlAdmin:diagnostics.video.now.keepingUp") } as const) : ({ tone: "warn", label: t("controlAdmin:diagnostics.video.now.fallingBehind") } as const)
        };
  const cpuBusy = now !== null && now.cpu.percent >= 90;
  const memoryLow = now !== null && now.memory.availableBytes / now.memory.totalBytes < 0.1;
  const conversionMemory = conversion?.usage.memoryBytes ?? 0;

  return (
    <section className="organization-card diag-now" aria-labelledby="diag-now-title">
      <header className="diag-card-head">
        <h3 id="diag-now-title">{t("controlAdmin:diagnostics.video.now.title")}</h3>
        <span className="muted">{t("controlAdmin:diagnostics.video.now.window")}</span>
      </header>
      {failed && !now && <p className="muted">{t("controlAdmin:diagnostics.video.now.failed")}</p>}
      <NowRow icon={<Gauge size={17} />} label={t("controlAdmin:diagnostics.video.now.speed")} sub={speedRow.sub} verdict={speedRow.verdict} values={speedHistory} max={Math.max(2, ...speedHistory)} line={1} />
      {now && (
        <>
          <NowRow
            icon={<Cpu size={17} />}
            label={t("controlAdmin:diagnostics.video.now.cpu", { percent: Math.round(now.cpu.percent) })}
            sub={now.cpu.load
              ? t("controlAdmin:diagnostics.video.now.cpuLoad", { cores: now.cpu.cores, load: now.cpu.load.map((value) => value.toFixed(1)).join(" · ") })
              : t("controlAdmin:diagnostics.video.now.cpuCores", { cores: now.cpu.cores })}
            verdict={cpuBusy ? { tone: "warn", label: t("controlAdmin:diagnostics.video.now.busy") } : { tone: "ok", label: t("controlAdmin:diagnostics.video.now.fine") }}
            values={cpuHistory}
            max={100}
            line={90}
          />
          <NowRow
            icon={<MemoryStick size={17} />}
            label={t("controlAdmin:diagnostics.video.now.memory")}
            sub={[
              t("controlAdmin:diagnostics.video.now.memoryFree", { free: formatBytes(now.memory.availableBytes), total: formatBytes(now.memory.totalBytes) }),
              conversionMemory > 0 ? t("controlAdmin:diagnostics.video.now.memoryConversions", { size: formatBytes(conversionMemory) }) : null
            ].filter(Boolean).join(" · ")}
            verdict={memoryLow ? { tone: "warn", label: t("controlAdmin:diagnostics.video.now.low") } : { tone: "ok", label: t("controlAdmin:diagnostics.video.now.fine") }}
            values={memoryHistory}
            max={100}
          />
        </>
      )}
      {plays && (
        <NowRow
          icon={<Network size={17} />}
          label={t("controlAdmin:diagnostics.video.now.sending")}
          sub={t("controlAdmin:diagnostics.video.now.sendingValue", { mbps: Math.round(sending * 10) / 10, count: viewers })}
          verdict={null}
          values={sendingHistory}
          max={Math.max(1, ...sendingHistory)}
        />
      )}
      <p className="muted diag-now-foot">{t("controlAdmin:diagnostics.video.now.foot")}</p>
    </section>
  );
}

function NowRow({ icon, label, sub, verdict, values, max, line }: {
  icon: ReactNode;
  label: string;
  sub: string;
  verdict: { tone: "ok" | "warn"; label: string } | null;
  values: number[];
  max: number;
  /** A dotted line for the limit: 1× real time, 90% of the CPU. */
  line?: number;
}) {
  return (
    <div className="diag-now-row">
      <span className="diag-now-icon" aria-hidden="true">{icon}</span>
      <div className="diag-now-text">
        <div className="diag-now-label">
          <strong>{label}</strong>
          {verdict && <span className={`app-status-pill ${verdict.tone === "ok" ? "is-ready" : "is-needsSetup"}`}>{verdict.label}</span>}
        </div>
        <span className="muted">{sub}</span>
      </div>
      <Sparkline values={values} max={max} line={line} />
    </div>
  );
}

/** Ten minutes as a line, right-aligned: a page just opened draws only its first readings. */
export function Sparkline({ values, max, line }: { values: number[]; max: number; line?: number }) {
  const width = 160;
  const height = 30;
  const step = width / (KEEP - 1);
  const y = (value: number) => height - 2 - (Math.min(value, max) / max) * (height - 4);
  const start = width - (values.length - 1) * step;
  const points = values.map((value, index) => `${(start + index * step).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return (
    <svg className="diag-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {line !== undefined && line <= max && <line className="diag-spark-limit" x1="0" x2={width} y1={y(line)} y2={y(line)} />}
      {values.length > 1 && <polyline className="diag-spark-line" points={points} />}
      {values.length === 1 && <circle className="diag-spark-dot" cx={width - 1.5} cy={y(values[0])} r="1.5" />}
    </svg>
  );
}

// ── Live sessions, the last test, what it's working through ────────────────────

function LiveSessions({ plays }: { plays: Play[] | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  if (!plays) return null;
  const streams = plays.filter((play) => play.kind !== "download");
  const how = (play: Play) =>
    play.kind === "direct" ? t("controlAdmin:nowPlaying.stream.direct")
      : play.kept ? t("controlAdmin:nowPlaying.stream.kept")
      : play.converter === null || play.mode === "remux" ? t("controlAdmin:nowPlaying.stream.remux")
      : play.converter === "gpu" ? t("controlAdmin:nowPlaying.stream.gpu")
      : t("controlAdmin:nowPlaying.stream.cpu");
  return (
    <section className="organization-card diag-sessions" aria-labelledby="diag-sessions-title">
      <header className="diag-card-head">
        <h3 id="diag-sessions-title">{t("controlAdmin:diagnostics.video.sessions.title", { count: streams.length })}</h3>
        <MoreLink tab="sessions">{t("controlAdmin:diagnostics.video.sessions.all")}</MoreLink>
      </header>
      {streams.length === 0 && <p className="muted">{t("controlAdmin:nowPlaying.nobody")}</p>}
      {streams.map((play) => {
        const share = play.positionSeconds != null && play.durationSeconds ? Math.min(100, (play.positionSeconds / play.durationSeconds) * 100) : null;
        return (
          <div key={`${play.kind}-${play.user}-${play.itemId ?? play.title}-${play.since}`} className="diag-session">
            <span className={`diag-session-icon is-${play.kind}`} aria-hidden="true">{play.kind === "direct" ? <PlayIcon size={16} /> : <Shuffle size={16} />}</span>
            <div className="diag-session-text">
              <strong>{play.heading ?? play.title}{play.subheading ? ` · ${play.subheading}` : ""}</strong>
              <span className="muted">
                {[how(play), play.rung ? t("controlAdmin:nowPlaying.quality", { height: play.rung }) : null, play.user, play.device && play.device !== "Unknown" ? play.device : null, play.network === "internet" ? t("controlAdmin:nowPlaying.away") : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="diag-session-progress">
              <div className="now-playing-bar"><span style={{ width: `${share ?? 0}%` }} /></div>
              <span className="muted">{play.positionSeconds != null ? clockOf(play.positionSeconds) : "—"}{play.durationSeconds ? ` / ${clockOf(play.durationSeconds)}` : ""}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function MoreLink({ tab, children }: { tab: DiagnosticsTab; children: ReactNode }) {
  const href = diagnosticsPartHref("video", tab);
  return (
    <a className="diag-link diag-more" href={href} onClick={(event) => followRoute(event, href)}>
      {children} <ArrowRight size={14} aria-hidden="true" />
    </a>
  );
}

/** The last GPU test in a few lines; the GPU tests tab has the rest. */
function TestSummary({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [test, setTest] = useState<HardwareTest | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api<{ running: HardwareTest | null; last: HardwareTest | null }>(`${prefix}/api/admin/hardware/test`)
      .then((body) => live && setTest(body.running ?? body.last))
      .catch(() => live && setTest(null));
    return () => {
      live = false;
    };
  }, [prefix]);
  if (test === undefined) return null;
  const speed = (run: { speed: number | null } | null) => (run?.speed != null ? t("controlAdmin:diagnostics.video.tests.speed", { speed: run.speed.toLocaleString(undefined, { maximumFractionDigits: 1 }) }) : "—");
  const hasGpu = (test?.scenarios ?? []).some((entry) => entry.gpuRun !== null);
  const together = test?.together.find((entry) => entry.converter === "gpu") ?? test?.together[0] ?? null;
  const passed = test?.phase === "done";
  return (
    <section className="organization-card diag-tests" aria-labelledby="diag-tests-title">
      <header className="diag-card-head">
        <h3 id="diag-tests-title">{t("controlAdmin:diagnostics.video.tests.title")}</h3>
        {test && <span className={`app-status-pill ${passed ? "is-ready" : test.finishedAt ? "is-needsSetup" : "is-off"}`}>{t(`controlAdmin:diagnostics.video.tests.phase.${passed ? "done" : test.finishedAt ? "stopped" : "running"}`)}</span>}
        {test && <span className="muted">{relativeTime(test.startedAt)}</span>}
        <MoreLink tab="tests">{test ? t("controlAdmin:diagnostics.video.tests.open") : t("controlAdmin:diagnostics.video.tests.run")}</MoreLink>
      </header>
      {!test && <p className="muted">{t("controlAdmin:diagnostics.video.tests.none")}</p>}
      {test && test.scenarios.length > 0 && (
        <table className="diag-tests-table">
          <thead>
            <tr>
              <th scope="col">{t("controlAdmin:apps.hardwareTest.thFilm")}</th>
              {hasGpu && <th scope="col">{t("controlAdmin:apps.hardwareTest.thGpu")}</th>}
              <th scope="col">{t("controlAdmin:apps.hardwareTest.thCpu")}</th>
            </tr>
          </thead>
          <tbody>
            {test.scenarios.filter((entry) => !entry.skipped).map((entry) => (
              <tr key={entry.id}>
                <th scope="row">{t(`controlAdmin:apps.hardwareTest.scenario.${entry.id}`, { defaultValue: entry.label })}</th>
                {hasGpu && <td>{speed(entry.gpuRun)}</td>}
                <td className="muted">{speed(entry.cpuRun)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {test && (together || test.suggestedViewers) && (
        <p className="diag-tests-foot">
          {[
            together ? t("controlAdmin:diagnostics.video.tests.together", { count: together.atOnce }) : null,
            test.suggestedViewers ? t("controlAdmin:diagnostics.video.tests.suggested", { count: test.suggestedViewers }) : null
          ].filter(Boolean).join(" · ")}
        </p>
      )}
    </section>
  );
}

interface EngineLibraryWork {
  id: string;
  name: string;
  kind: "movies" | "shows";
  scanState: string;
  metadata?: { state: "queued" | "running"; done: number; total: number; startedAt: string | null; tmdb: boolean } | null;
}

/** What the video app is working through: a library's scan or metadata pass, only while one runs. */
function CatalogWork({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [libraries, setLibraries] = useState<EngineLibraryWork[] | null>(null);
  const load = useCallback(async () => {
    try {
      setLibraries((await api<{ libraries: EngineLibraryWork[] }>(`${prefix}/api/admin/libraries`)).libraries);
    } catch {
      setLibraries([]);
    }
  }, [prefix]);
  useEffect(() => {
    void load();
  }, [load]);
  const busy = (libraries ?? []).filter((library) => library.metadata || library.scanState === "scanning" || library.scanState === "queued");
  useEffect(() => {
    if (busy.length === 0) return;
    const timer = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(timer);
  }, [libraries, busy.length, load]);
  if (busy.length === 0) return null;
  return (
    <GroupedList id="catalog" title={t("controlAdmin:diagnostics.page.video.catalogTitle")} note={t("controlAdmin:diagnostics.page.video.catalogNote")}>
      {busy.map((library) => {
        const work = library.metadata;
        const unit = library.kind === "shows" ? "shows" : "films";
        const label = library.scanState === "scanning" || library.scanState === "queued"
          ? t("control:libraries.status.scanning")
          : work?.state === "queued" ? t("control:libraries.status.detailsQueued") : t("control:libraries.status.details");
        const sub = work?.state === "running" && work.total > 0
          ? `${t(`control:libraries.status.detailsProgress.${unit}`, { done: work.done.toLocaleString(), total: work.total.toLocaleString() })}${work.startedAt ? ` · ${t("controlAdmin:diagnostics.page.video.catalogSince", { when: relativeTime(work.startedAt) })}` : ""}${work.tmdb ? "" : ` · ${t("controlAdmin:diagnostics.page.video.catalogNoKey")}`}`
          : undefined;
        return <NavRow key={library.id} icon={<MonitorPlay size={17} />} iconTone="muted" label={`${library.name} · ${label}`} sub={sub} href={libraryManageHref(library.id)} />;
      })}
    </GroupedList>
  );
}

/** The two newest saved reports; the Reports tab has them all. */
function SavedMini({ saved }: { saved: ReturnType<typeof useSavedReports> }) {
  const { t, i18n } = useTranslation(["controlAdmin"]);
  const reports = saved.reports ?? [];
  return (
    <section className="organization-card diag-side-card" aria-labelledby="diag-saved-title">
      <h3 id="diag-saved-title">{t("controlAdmin:diagnostics.saved.title")}</h3>
      {reports.length === 0 && <p className="muted">{t("controlAdmin:diagnostics.video.savedNone")}</p>}
      {reports.slice(0, 2).map((report) => (
        <div key={report.id} className="diag-saved-row">
          <FileText size={15} aria-hidden="true" />
          <span>{new Date(report.createdAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
      ))}
      <MoreLink tab="reports">{t("controlAdmin:diagnostics.video.savedAll")}</MoreLink>
    </section>
  );
}

// ── GPU tests ──────────────────────────────────────────────────────────────────

/** The hardware test, as Videos › Settings has it, with the GPU's row above it. */
function TestsTab({ prefix }: { prefix: string }) {
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
  return (
    <div id="tests" className="diagnostics-part-tests">
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.conversion.saveFailed")}>{error}</MessageBox>}
      <HardwareTestPage
        prefix={prefix}
        capabilities={state?.hardware ? <GpuRow hardware={state.hardware} /> : state ? <InfoRow icon={<Cpu size={17} />} iconTone="muted" label={t("controlAdmin:apps.conversion.gpuNoneTitle")} /> : null}
        maxViewers={state?.settings.maxViewers ?? null}
        saving={saving}
        onUseLimit={(count) => void save({ maxViewers: count })}
      />
    </div>
  );
}
