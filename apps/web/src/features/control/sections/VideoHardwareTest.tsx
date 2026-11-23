import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Cpu, Gauge, HardDrive, History, Play, Square, Users, Zap } from "lucide-react";
import { api, ApiError } from "../../../api";
import { Button } from "../../../shared/Button";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { formatManagedDate } from "../../../shared/utils";

// Videos › Settings › Hardware test (docs/video-hardware-tests-plan.md, phase 2):
// the video engine's conversion speed test (isputnik.video hardware-test.ts) —
// how many times faster than real time each kind of film converts on the GPU and
// on the CPU, how many can watch at once, the viewer limit that allows, and the
// hardware changes noted between starts. The engine does the work; this page
// starts it, follows it and words the results — in the Diagnostics style
// (2026-11-17): tiles of the headline numbers, a card of speed bars, how many at
// once, the disks; the GPU, past tests and hardware changes in a narrow column.

type ScenarioId = "4k-hdr" | "4k-sdr" | "1080p-hevc" | "1080p-to-720p" | "divx" | "av1";
type Verdict = "smooth" | "tight" | "slow" | "failed";

interface RunResult {
  speed: number | null;
  fps: number | null;
  verdict: Verdict;
  error: string | null;
}

interface ScenarioResult {
  id: ScenarioId;
  label: string;
  skipped: string | null;
  gpuRun: RunResult | null;
  cpuRun: RunResult | null;
}

interface TogetherResult {
  id: ScenarioId;
  label: string;
  converter: "gpu" | "cpu";
  atOnce: number;
  atLeast?: boolean;
}

export interface HardwareTest {
  id: number | null;
  startedAt: string;
  finishedAt: string | null;
  phase: "samples" | "converting" | "together" | "done" | "stopped" | "failed";
  doing: string | null;
  step?: { kind: "make" | "gpu" | "cpu" | "together"; scenario: ScenarioId; count?: number } | null;
  reason: string | null;
  scenarios: ScenarioResult[];
  together: TogetherResult[];
  suggestedViewers: number | null;
}

interface HardwareChange {
  id: number;
  at: string;
  summary: string;
}

export interface TestState {
  running: HardwareTest | null;
  last: HardwareTest | null;
  available: boolean;
}

const finished = (test: HardwareTest) => ["done", "stopped", "failed"].includes(test.phase);

/** The engine's disk check (isputnik.video disk-check.ts), one library each. */
interface LibraryDisk {
  libraryId: string;
  name: string;
  wake: { samples: number[]; slowestMs: number | null; asleep: boolean };
  read: { file: string; bytes: number; seconds: number; mbitPerSecond: number | null } | null;
  heaviestMbit: number | null;
  verdict: "plenty" | "enough" | "short" | "unknown";
  error: string | null;
}

export interface DiskCheck {
  id: number | null;
  startedAt: string;
  phase: "running" | "done" | "stopped" | "failed";
  step: { libraryId: string; name: string; kind: "wake" | "read" } | null;
  reason: string | null;
  libraries: LibraryDisk[];
}

/** Why the engine stopped a test or a check, in the page's language (it says so in English). */
function reasonWords(reason: string | null, t: TFunction<["controlAdmin"]>): string {
  if (!reason) return "";
  if (reason.startsWith("Someone started watching")) return t("controlAdmin:apps.hardwareTest.reasonWatching");
  if (reason.startsWith("Stopped by ")) return t("controlAdmin:apps.hardwareTest.reasonStoppedBy", { name: reason.slice("Stopped by ".length) });
  if (reason.startsWith("The engine is stopping")) return t("controlAdmin:apps.hardwareTest.reasonEngineStopping");
  return reason;
}

const VERDICT_TONE = { plenty: "ok", enough: "ok", short: "danger", unknown: "muted" } as const;

/** Disks: each library's wake-up and reading speed, run on its own button. */
export function DiskCheckSection({ prefix, testRunning }: { prefix: string; testRunning: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const url = `${prefix}/api/admin/hardware/disks`;
  const [state, setState] = useState<{ running: DiskCheck | null; last: DiskCheck | null } | null>(null);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);

  const load = useCallback(() => api<{ running: DiskCheck | null; last: DiskCheck | null }>(url).then(setState, () => undefined), [url]);
  useEffect(() => { void load(); }, [load]);
  const running = state?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const start = async () => {
    setError("");
    try {
      const body = await api<{ check: DiskCheck }>(url, { method: "POST", body: "{}" });
      setState((current) => ({ last: current?.last ?? null, running: body.check }));
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      setError(code === "watching" ? t("controlAdmin:apps.hardwareTest.disks.watching")
        : code === "running" ? t("controlAdmin:apps.hardwareTest.disks.alreadyRunning")
        : code === "test" ? t("controlAdmin:apps.hardwareTest.disks.testRunning")
        : err instanceof Error ? err.message : t("controlAdmin:apps.hardwareTest.startFailed"));
    }
  };
  const stop = async () => {
    setStopping(true);
    try { await api(url, { method: "DELETE" }); } catch { /* finished meanwhile */ } finally {
      setStopping(false);
      await load();
    }
  };

  if (!state) return null;
  const check = running ?? state.last;
  const summary = (entry: LibraryDisk) => {
    if (entry.error) return t("controlAdmin:apps.hardwareTest.disks.failed", { error: entry.error });
    const parts = [
      entry.wake.slowestMs !== null ? t("controlAdmin:apps.hardwareTest.disks.wake", { ms: entry.wake.slowestMs.toLocaleString() }) + (entry.wake.asleep ? ` (${t("controlAdmin:apps.hardwareTest.disks.asleep")})` : "") : null,
      entry.read?.mbitPerSecond != null ? t("controlAdmin:apps.hardwareTest.disks.reads", { mbit: Math.round(entry.read.mbitPerSecond).toLocaleString() }) : entry.read ? t("controlAdmin:apps.hardwareTest.disks.readsUnknown") : null,
      entry.heaviestMbit !== null ? t("controlAdmin:apps.hardwareTest.disks.heaviest", { mbit: entry.heaviestMbit.toLocaleString() }) : t("controlAdmin:apps.hardwareTest.disks.heaviestUnknown")
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <section className="organization-card hwt-card" aria-labelledby="hwt-disks-title">
      <header className="diag-card-head">
        <span className="diag-card-icon" aria-hidden="true"><HardDrive size={17} /></span>
        <h3 id="hwt-disks-title">{t("controlAdmin:apps.hardwareTest.disks.title")}</h3>
        <span className="diag-card-actions">
          {running ? (
            <Button variant="secondary" compact onClick={() => void stop()} disabled={stopping}>
              <Square size={14} aria-hidden="true" /> {stopping ? t("controlAdmin:apps.hardwareTest.stopping") : t("controlAdmin:apps.hardwareTest.stop")}
            </Button>
          ) : (
            <Button variant="secondary" compact onClick={() => void start()} disabled={testRunning}>
              <HardDrive size={14} aria-hidden="true" /> {t("controlAdmin:apps.hardwareTest.disks.run")}
            </Button>
          )}
        </span>
      </header>
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.hardwareTest.startFailed")}>{error}</MessageBox>}
      {check && check.phase !== "running" && check.phase !== "done" && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.hardwareTest.disks.stoppedTitle")}>{reasonWords(check.reason, t)}</MessageBox>
      )}
      {running ? (
        <p className="hwt-now" role="status">
          <span className="hwt-pulse" aria-hidden="true" />
          <strong>{t("controlAdmin:apps.hardwareTest.disks.running")}</strong>
          {running.step && <span className="muted">{running.step.kind === "wake"
            ? t("controlAdmin:apps.hardwareTest.disks.stepWake", { name: running.step.name })
            : t("controlAdmin:apps.hardwareTest.disks.stepRead", { name: running.step.name })}</span>}
        </p>
      ) : (
        <p className="muted hwt-note">{state.last ? t("controlAdmin:apps.hardwareTest.disks.lastChecked", { date: formatManagedDate(state.last.startedAt) }) : t("controlAdmin:apps.hardwareTest.disks.notRun")}</p>
      )}
      {check && !running && check.phase === "done" && check.libraries.length === 0 && <p className="muted">{t("controlAdmin:apps.hardwareTest.disks.noLibraries")}</p>}
      {(check?.libraries ?? []).length > 0 && (
        <div className="hwt-disks">
          {(check?.libraries ?? []).map((entry) => {
            const tone = entry.error || entry.wake.asleep ? "warn" : VERDICT_TONE[entry.verdict];
            return (
              <div key={entry.libraryId} className={`hwt-disk is-${tone}`}>
                <span className="hwt-disk-icon" aria-hidden="true"><HardDrive size={16} /></span>
                <div className="hwt-disk-text">
                  <strong>{entry.name}</strong>
                  <small className="muted">{summary(entry)}</small>
                </div>
                {!entry.error && running?.step?.libraryId !== entry.libraryId && (
                  <span className={`diag-badge-mini is-${entry.verdict}`}>{t(`controlAdmin:apps.hardwareTest.disks.verdict.${entry.verdict}`)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted hwt-note">{t("controlAdmin:apps.hardwareTest.disks.note")}</p>
    </section>
  );
}

/** The engine's hardware test as the Hardware & transcoding card needs it: the last
 *  one, whether one runs now, and `missing` for an engine with no test (before
 *  0.39). `start` runs one; it rejects with the engine's reason when it can't. */
export function useHardwareTest(prefix: string): { state: TestState | null; missing: boolean; start: () => Promise<void> } {
  const [state, setState] = useState<TestState | null>(null);
  const [missing, setMissing] = useState(false);
  const url = `${prefix}/api/admin/hardware/test`;
  useEffect(() => {
    let live = true;
    api<TestState>(url).then((loaded) => { if (live) setState(loaded); }, () => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [url]);
  const start = useCallback(async () => {
    const body = await api<{ test: HardwareTest }>(url, { method: "POST", body: "{}" });
    setState((current) => ({ running: body.test, last: current?.last ?? null, available: true }));
  }, [url]);
  return { state, missing, start };
}

/** How many the last finished test found this server converts at once; null with none. */
export const suggestedViewersOf = (state: TestState | null): number | null =>
  (state?.last?.phase === "done" ? state.last.suggestedViewers ?? null : null);

/** The overview's row: the last result in a few words, and the way in. */
export function HardwareTestRow({ prefix, onOpen }: { prefix: string; onOpen: () => void }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [state, setState] = useState<TestState | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<TestState>(`${prefix}/api/admin/hardware/test`).then(setState, () => setMissing(true));
  }, [prefix]);
  // An engine before 0.39.0 has no test: no row.
  if (missing) return null;
  const last = state?.running ?? state?.last ?? null;
  const value = !state ? undefined
    : state.running ? t("controlAdmin:apps.hardwareTest.runningTitle")
    : !last ? t("controlAdmin:apps.hardwareTest.notRun")
    : last.suggestedViewers ? t("controlAdmin:apps.hardwareTest.lastAtOnce", { date: formatManagedDate(last.startedAt), count: last.suggestedViewers })
    : t("controlAdmin:apps.hardwareTest.lastDate", { date: formatManagedDate(last.startedAt) });
  return (
    <NavRow
      icon={<Gauge size={17} />}
      iconTone={last?.phase === "done" ? "ok" : "muted"}
      label={t("controlAdmin:apps.hardwareTest.title")}
      sub={value ?? t("controlAdmin:apps.hardwareTest.overviewSub")}
      onClick={onOpen}
    />
  );
}

/** The page. `capabilities` is the Converting video page's GPU row (what the
 *  start-up check found); `maxViewers` and `onUseLimit` the admin's viewer limit. */
export function HardwareTestPage({ prefix, capabilities, maxViewers, saving, onUseLimit }: {
  prefix: string;
  capabilities: ReactNode;
  maxViewers: number | null;
  saving: boolean;
  onUseLimit: (count: number) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const url = `${prefix}/api/admin/hardware/test`;
  const [state, setState] = useState<TestState | null>(null);
  const [history, setHistory] = useState<{ tests: HardwareTest[]; changes: HardwareChange[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [shown, setShown] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [now, past] = await Promise.all([
        api<TestState>(url),
        api<{ tests: HardwareTest[]; changes: HardwareChange[] }>(`${prefix}/api/admin/hardware/history`)
      ]);
      setState(now);
      setHistory(past);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(err instanceof Error ? err.message : t("controlAdmin:apps.hardwareTest.loadFailed"));
    }
  }, [prefix, url, t]);

  useEffect(() => { void load(); }, [load]);

  // While a test runs: every two seconds, until it has finished.
  const running = state?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      api<TestState>(url).then((now) => {
        setState(now);
        if (!now.running) void load();
      }, () => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, url, load]);

  const start = async () => {
    setError("");
    setShown(null);
    try {
      const body = await api<{ test: HardwareTest }>(url, { method: "POST", body: "{}" });
      setState((current) => ({ available: true, last: current?.last ?? null, running: body.test }));
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      setError(code === "watching" ? t("controlAdmin:apps.hardwareTest.watching")
        : code === "running" ? t("controlAdmin:apps.hardwareTest.alreadyRunning")
        : err instanceof Error ? err.message : t("controlAdmin:apps.hardwareTest.startFailed"));
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await api(url, { method: "DELETE" });
    } catch {
      /* finished meanwhile */
    } finally {
      setStopping(false);
      await load();
    }
  };

  if (missing) {
    return (
      <div className="grouped-page">
        <MessageBox tone="info" title={t("controlAdmin:apps.hardwareTest.needsEngineTitle")}>{t("controlAdmin:apps.hardwareTest.needsEngineBody")}</MessageBox>
      </div>
    );
  }
  if (!state) return <div className="grouped-page"><p className="muted">{error || t("controlAdmin:ui.loading")}</p></div>;

  const pastTests = history?.tests ?? [];
  const selected = shown !== null ? pastTests.find((test) => test.id === shown) ?? null : null;
  const test = running ?? selected ?? state.last;
  const lastChange = history?.changes[0];
  const changedSince = lastChange && state.last && lastChange.at > state.last.startedAt ? lastChange : null;

  const scenarioName = (entry: { id: ScenarioId; label: string }) => t(`controlAdmin:apps.hardwareTest.scenario.${entry.id}`, { defaultValue: entry.label });
  const reasonText = (reason: string | null) => reasonWords(reason, t);
  const stepText = (now: HardwareTest) => {
    const step = now.step;
    if (step) {
      const name = t(`controlAdmin:apps.hardwareTest.scenario.${step.scenario}`);
      return t(`controlAdmin:apps.hardwareTest.steps.${step.kind}`, { name, count: step.count ?? 1 });
    }
    return now.phase === "samples" ? t("controlAdmin:apps.hardwareTest.phaseSamples")
      : now.phase === "together" ? t("controlAdmin:apps.hardwareTest.phaseTogether")
      : t("controlAdmin:apps.hardwareTest.phaseConverting");
  };
  const runCell = (run: RunResult | null, hasGpu: boolean) => {
    if (!run) return <span className="datagrid-muted">{hasGpu ? "—" : t("controlAdmin:apps.hardwareTest.noGpu")}</span>;
    const verdict = t(`controlAdmin:apps.hardwareTest.verdict.${run.verdict}`);
    if (run.speed === null) return <span className="hw-verdict is-failed" title={run.error ?? undefined}>{verdict}</span>;
    return <span className={`hw-verdict is-${run.verdict}`}>{t("controlAdmin:apps.hardwareTest.speed", { speed: run.speed.toLocaleString(undefined, { maximumFractionDigits: 1 }), verdict })}</span>;
  };
  const hasGpu = (test?.scenarios ?? []).some((entry) => entry.gpuRun !== null);
  // The bars' scale: the fastest run, and never under 2× so 1× sits in the middle at most.
  const top = Math.max(2, ...(test?.scenarios ?? []).flatMap((entry) => [entry.gpuRun?.speed ?? 0, entry.cpuRun?.speed ?? 0]));
  const hardest = test?.scenarios.find((entry) => entry.id === "4k-hdr" && !entry.skipped) ?? null;
  const times = (run: RunResult | null | undefined) => (run?.speed != null ? `${run.speed.toLocaleString(undefined, { maximumFractionDigits: 1 })}×` : "—");
  const phaseWords = (entry: HardwareTest) => entry.phase === "done" ? t("controlAdmin:apps.hardwareTest.historyDone") : entry.phase === "stopped" ? t("controlAdmin:apps.hardwareTest.historyStopped") : t("controlAdmin:apps.hardwareTest.historyFailed");

  const tiles: StatTile[] = [
    {
      icon: <History size={19} />, iconTone: "blue",
      label: t("controlAdmin:apps.hardwareTest.tiles.last"),
      value: running ? t("controlAdmin:apps.hardwareTest.runningTitle") : test ? formatManagedDate(test.startedAt) : t("controlAdmin:apps.hardwareTest.notRun"),
      sub: !running && test ? phaseWords(test) : undefined
    },
    {
      icon: <Users size={19} />, iconTone: "mint",
      label: t("controlAdmin:apps.hardwareTest.tiles.atOnce"),
      value: test?.suggestedViewers != null ? String(test.suggestedViewers) : "—",
      sub: maxViewers !== null ? t("controlAdmin:apps.hardwareTest.tiles.yourLimit", { count: maxViewers }) : undefined
    },
    {
      icon: <Zap size={19} />, iconTone: hardest?.gpuRun && hardest.gpuRun.verdict !== "smooth" ? "warn" : "gold",
      label: t("controlAdmin:apps.hardwareTest.tiles.hdrGpu"),
      value: hardest?.gpuRun ? times(hardest.gpuRun) : hasGpu || !test ? "—" : t("controlAdmin:apps.hardwareTest.noGpu"),
      sub: hardest?.gpuRun ? t(`controlAdmin:apps.hardwareTest.verdict.${hardest.gpuRun.verdict}`) : undefined
    },
    {
      icon: <Cpu size={19} />, iconTone: "rose",
      label: t("controlAdmin:apps.hardwareTest.tiles.hdrCpu"),
      value: times(hardest?.cpuRun),
      sub: hardest?.cpuRun ? t(`controlAdmin:apps.hardwareTest.verdict.${hardest.cpuRun.verdict}`) : undefined
    }
  ];

  /** One run as a bar: how far past real time it got, the 1× mark on its track. */
  const bar = (who: string, run: RunResult | null, gpu: boolean) => (
    <div className="hwt-bar">
      <span className="hwt-who">{who}</span>
      <div className="hwt-track" aria-hidden="true">
        {run?.speed != null && <span className={`hwt-fill is-${run.verdict}`} style={{ width: `${Math.min(100, (run.speed / top) * 100)}%` }} />}
        <span className="hwt-one" style={{ left: `${(1 / top) * 100}%` }} />
      </div>
      <span className="hwt-value">{run ? runCell(run, true) : runCell(null, gpu)}</span>
    </div>
  );

  return (
    <div className="diag-video hw-test-page">
      <div className="diag-video-main">
        {error && <MessageBox tone="error" title={t("controlAdmin:apps.hardwareTest.startFailed")}>{error}</MessageBox>}
        {changedSince && !running && (
          <MessageBox tone="warning" title={t("controlAdmin:apps.hardwareTest.changedSinceTitle")}>
            {t("controlAdmin:apps.hardwareTest.changedSinceBody", { change: changedSince.summary })}
          </MessageBox>
        )}
        {test && finished(test) && test.phase !== "done" && (
          <MessageBox tone={test.phase === "failed" ? "error" : "warning"} title={test.phase === "failed" ? t("controlAdmin:apps.hardwareTest.failedTitle") : t("controlAdmin:apps.hardwareTest.stoppedTitle")}>
            {reasonText(test.reason)} {test.scenarios.length > 0 ? t("controlAdmin:apps.hardwareTest.partial") : ""}
          </MessageBox>
        )}
        {selected && !running && (
          <MessageBox tone="info" title={t("controlAdmin:apps.hardwareTest.showing", { date: formatManagedDate(selected.startedAt) })}>
            <Button variant="text" onClick={() => setShown(null)}>{t("controlAdmin:apps.hardwareTest.showLatest")}</Button>
          </MessageBox>
        )}

        <div className="diag-tiles">
          <StatTiles tiles={tiles} label={t("controlAdmin:apps.hardwareTest.title")} />
        </div>

        <section className="organization-card hwt-card" aria-labelledby="hwt-speed-title">
          <header className="diag-card-head">
            <span className="diag-card-icon" aria-hidden="true"><Gauge size={17} /></span>
            <h3 id="hwt-speed-title">{t("controlAdmin:apps.hardwareTest.resultsTitle")}</h3>
            <span className="diag-card-actions">
              {running ? (
                <Button variant="secondary" compact onClick={() => void stop()} disabled={stopping}>
                  <Square size={14} aria-hidden="true" /> {stopping ? t("controlAdmin:apps.hardwareTest.stopping") : t("controlAdmin:apps.hardwareTest.stop")}
                </Button>
              ) : (
                <Button variant="primary" compact onClick={() => void start()} disabled={!state.available}>
                  <Play size={14} aria-hidden="true" /> {t("controlAdmin:apps.hardwareTest.run")}
                </Button>
              )}
            </span>
          </header>
          {running && (
            <p className="hwt-now" role="status">
              <span className="hwt-pulse" aria-hidden="true" />
              <strong>{t("controlAdmin:apps.hardwareTest.runningTitle")}</strong>
              <span className="muted">{stepText(running)}</span>
            </p>
          )}
          {test && test.scenarios.length > 0 ? (
            <div className="hwt-rows">
              {test.scenarios.map((entry) => (
                <div key={entry.id} className="hwt-row">
                  <strong className="hwt-name">{scenarioName(entry)}</strong>
                  {entry.skipped ? (
                    <span className="muted hwt-skipped">{t("controlAdmin:apps.hardwareTest.skipped", { reason: entry.skipped })}</span>
                  ) : (
                    <div className="hwt-bars">
                      {hasGpu && bar(t("controlAdmin:apps.hardwareTest.thGpu"), entry.gpuRun, hasGpu)}
                      {bar(t("controlAdmin:apps.hardwareTest.thCpu"), entry.cpuRun, true)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{t("controlAdmin:apps.hardwareTest.intro")}</p>
          )}
          <p className="muted hwt-note">{test && test.scenarios.length > 0 ? t("controlAdmin:apps.hardwareTest.resultsNote") : t("controlAdmin:apps.hardwareTest.clipsNote")}</p>
        </section>

        {test && test.together.length > 0 && (
          <section className="organization-card hwt-card" aria-labelledby="hwt-together-title">
            <header className="diag-card-head">
              <span className="diag-card-icon" aria-hidden="true"><Users size={17} /></span>
              <h3 id="hwt-together-title">{t("controlAdmin:apps.hardwareTest.togetherTitle")}</h3>
            </header>
            <div className="hwt-together">
              {test.together.map((entry) => (
                <div key={entry.id} className={`hwt-together-item${entry.atOnce === 0 ? " is-none" : ""}`}>
                  <span className="hwt-together-count">
                    {entry.atOnce === 0 ? t("controlAdmin:apps.hardwareTest.togetherNone")
                      : entry.atLeast ? t("controlAdmin:apps.hardwareTest.togetherAtLeast", { count: entry.atOnce })
                      : t("controlAdmin:apps.hardwareTest.togetherCount", { count: entry.atOnce })}
                  </span>
                  <span className="muted">{scenarioName(entry)}</span>
                  <span className={`diag-badge-mini is-${entry.converter}`}>{entry.converter === "gpu" ? t("controlAdmin:apps.hardwareTest.whereGpu") : t("controlAdmin:apps.hardwareTest.whereCpu")}</span>
                </div>
              ))}
            </div>
            <p className="muted hwt-note">{t("controlAdmin:apps.hardwareTest.togetherNote")}</p>
            {test.phase === "done" && test.suggestedViewers !== null && maxViewers !== null && !selected && (
              <MessageBox tone={test.suggestedViewers === maxViewers ? "success" : "info"} title={t("controlAdmin:apps.hardwareTest.suggestTitle", { count: test.suggestedViewers })}>
                {t("controlAdmin:apps.hardwareTest.suggestBody", { limit: maxViewers })}{" "}
                {test.suggestedViewers === maxViewers
                  ? t("controlAdmin:apps.hardwareTest.suggestSame")
                  : <Button variant="secondary" compact disabled={saving} onClick={() => onUseLimit(test.suggestedViewers!)}>{t("controlAdmin:apps.hardwareTest.useLimit", { count: test.suggestedViewers })}</Button>}
              </MessageBox>
            )}
          </section>
        )}

        <DiskCheckSection prefix={prefix} testRunning={Boolean(running)} />
      </div>

      <aside className="diag-video-side">
        {capabilities && (
          <section className="organization-card diag-side-card" aria-labelledby="hwt-gpu-title">
            <h3 id="hwt-gpu-title">{t("controlAdmin:apps.hardwareTest.tiles.gpu")}</h3>
            <GroupedList>{capabilities}</GroupedList>
          </section>
        )}
        <section className="organization-card diag-side-card" aria-labelledby="hwt-history-title">
          <h3 id="hwt-history-title">{t("controlAdmin:apps.hardwareTest.historyTitle")}</h3>
          {pastTests.length === 0 && <p className="muted">{t("controlAdmin:apps.hardwareTest.historyEmpty")}</p>}
          {pastTests.map((past) => (
            <Button
              key={past.id ?? past.startedAt}
              variant="bare"
              className={`hwt-past${test && past.id === test.id ? " is-shown" : ""}`}
              onClick={() => setShown(past.id)}
            >
              <span className={`hwt-past-dot is-${past.phase}`} aria-hidden="true" />
              <span className="hwt-past-text">
                <strong>{formatManagedDate(past.startedAt)}</strong>
                <small>{[phaseWords(past), past.suggestedViewers ? t("controlAdmin:apps.hardwareTest.togetherCount", { count: past.suggestedViewers }) : null].filter(Boolean).join(" · ")}</small>
              </span>
            </Button>
          ))}
        </section>
        <section className="organization-card diag-side-card" aria-labelledby="hwt-changes-title">
          <h3 id="hwt-changes-title">{t("controlAdmin:apps.hardwareTest.changesTitle")}</h3>
          {(history?.changes ?? []).length === 0 && <p className="muted">{t("controlAdmin:apps.hardwareTest.changesEmpty")}</p>}
          {(history?.changes ?? []).map((change) => (
            <div key={change.id} className="hwt-change">
              <span>{change.summary}</span>
              <small className="muted">{formatManagedDate(change.at)}</small>
            </div>
          ))}
          <p className="muted">{t("controlAdmin:apps.hardwareTest.changesNote")}</p>
        </section>
      </aside>
    </div>
  );
}
