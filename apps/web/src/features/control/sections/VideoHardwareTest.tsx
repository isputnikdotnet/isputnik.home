import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Gauge, HardDrive, History, Play, Square, Wrench } from "lucide-react";
import { api, ApiError } from "../../../api";
import { Button } from "../../../shared/Button";
import { GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";

// Videos › Settings › Hardware test (docs/video-hardware-tests-plan.md, phase 2):
// the video engine's conversion speed test (isputnik.video hardware-test.ts) —
// how many times faster than real time each kind of film converts on the GPU and
// on the CPU, how many can watch at once, the viewer limit that allows, and the
// hardware changes noted between starts. The engine does the work; this page
// starts it, follows it and words the results.

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

interface TestState {
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
    <>
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.hardwareTest.startFailed")}>{error}</MessageBox>}
      {check && check.phase !== "running" && check.phase !== "done" && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.hardwareTest.disks.stoppedTitle")}>{reasonWords(check.reason, t)}</MessageBox>
      )}
      <GroupedList title={t("controlAdmin:apps.hardwareTest.disks.title")} note={t("controlAdmin:apps.hardwareTest.disks.note")}>
        {check && !running && check.phase === "done" && check.libraries.length === 0 && <InfoRow label={t("controlAdmin:apps.hardwareTest.disks.noLibraries")} />}
        {(check?.libraries ?? []).map((entry) => (
          <InfoRow
            key={entry.libraryId}
            icon={<HardDrive size={17} />}
            iconTone={entry.error ? "warn" : entry.wake.asleep ? "warn" : VERDICT_TONE[entry.verdict]}
            label={entry.name}
            sub={summary(entry)}
            value={entry.error || running?.step?.libraryId === entry.libraryId ? undefined : t(`controlAdmin:apps.hardwareTest.disks.verdict.${entry.verdict}`)}
            valueTone={entry.verdict === "short" ? "danger" : undefined}
          />
        ))}
        <div className="grouped-row hw-test-actions">
          {running ? (
            <>
              <span className="hw-test-now" role="status">
                <strong>{t("controlAdmin:apps.hardwareTest.disks.running")}</strong>
                {running.step && <small>{running.step.kind === "wake"
                  ? t("controlAdmin:apps.hardwareTest.disks.stepWake", { name: running.step.name })
                  : t("controlAdmin:apps.hardwareTest.disks.stepRead", { name: running.step.name })}</small>}
              </span>
              <Button variant="secondary" onClick={() => void stop()} disabled={stopping}>
                <Square size={15} aria-hidden="true" /> {stopping ? t("controlAdmin:apps.hardwareTest.stopping") : t("controlAdmin:apps.hardwareTest.stop")}
              </Button>
            </>
          ) : (
            <>
              <span className="hw-test-now"><small>{state.last ? t("controlAdmin:apps.hardwareTest.disks.lastChecked", { date: formatManagedDate(state.last.startedAt) }) : t("controlAdmin:apps.hardwareTest.disks.notRun")}</small></span>
              <Button variant="secondary" onClick={() => void start()} disabled={testRunning}>
                <HardDrive size={15} aria-hidden="true" /> {t("controlAdmin:apps.hardwareTest.disks.run")}
              </Button>
            </>
          )}
        </div>
      </GroupedList>
    </>
  );
}

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
      sub={t("controlAdmin:apps.hardwareTest.overviewSub")}
      value={value}
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

  return (
    <div className="grouped-page hw-test-page">
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.hardwareTest.startFailed")}>{error}</MessageBox>}
      {changedSince && !running && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.hardwareTest.changedSinceTitle")}>
          {t("controlAdmin:apps.hardwareTest.changedSinceBody", { change: changedSince.summary })}
        </MessageBox>
      )}

      <GroupedList note={<>{t("controlAdmin:apps.hardwareTest.intro")} {t("controlAdmin:apps.hardwareTest.clipsNote")}</>}>
        {capabilities}
        <div className="grouped-row hw-test-actions">
          {running ? (
            <>
              <span className="hw-test-now" role="status">
                <strong>{t("controlAdmin:apps.hardwareTest.runningTitle")}</strong>
                <small>{stepText(running)}</small>
              </span>
              <Button variant="secondary" onClick={() => void stop()} disabled={stopping}>
                <Square size={15} aria-hidden="true" /> {stopping ? t("controlAdmin:apps.hardwareTest.stopping") : t("controlAdmin:apps.hardwareTest.stop")}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => void start()} disabled={!state.available}>
              <Play size={15} aria-hidden="true" /> {t("controlAdmin:apps.hardwareTest.run")}
            </Button>
          )}
        </div>
      </GroupedList>

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

      {test && test.scenarios.length > 0 && (
        <GroupedList title={t("controlAdmin:apps.hardwareTest.resultsTitle")} note={t("controlAdmin:apps.hardwareTest.resultsNote")}>
          <div className="hw-test-table">
            <table className="datagrid datagrid-phone-stack">
              <thead>
                <tr>
                  <th>{t("controlAdmin:apps.hardwareTest.thFilm")}</th>
                  {/* No GPU tried at all: no column of "No GPU" (the row above says why). */}
                  {hasGpu && <th>{t("controlAdmin:apps.hardwareTest.thGpu")}</th>}
                  <th>{t("controlAdmin:apps.hardwareTest.thCpu")}</th>
                </tr>
              </thead>
              <tbody>
                {test.scenarios.map((entry) => (
                  <tr key={entry.id}>
                    <td className="col-title"><strong>{scenarioName(entry)}</strong></td>
                    {entry.skipped ? (
                      <td colSpan={hasGpu ? 2 : 1} className="datagrid-muted" data-label={t("controlAdmin:apps.hardwareTest.thCpu")}>{t("controlAdmin:apps.hardwareTest.skipped", { reason: entry.skipped })}</td>
                    ) : (
                      <>
                        {hasGpu && <td data-label={t("controlAdmin:apps.hardwareTest.thGpu")}>{runCell(entry.gpuRun, hasGpu)}</td>}
                        <td data-label={t("controlAdmin:apps.hardwareTest.thCpu")}>{runCell(entry.cpuRun, true)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GroupedList>
      )}

      {test && test.together.length > 0 && (
        <GroupedList title={t("controlAdmin:apps.hardwareTest.togetherTitle")} note={t("controlAdmin:apps.hardwareTest.togetherNote")}>
          {test.together.map((entry) => (
            <InfoRow
              key={entry.id}
              icon={<Wrench size={17} />}
              iconTone={entry.atOnce > 0 ? "ok" : "warn"}
              label={t("controlAdmin:apps.hardwareTest.togetherRow", {
                name: scenarioName(entry),
                where: entry.converter === "gpu" ? t("controlAdmin:apps.hardwareTest.whereGpu") : t("controlAdmin:apps.hardwareTest.whereCpu")
              })}
              sub={entry.atOnce === 0 ? t("controlAdmin:apps.hardwareTest.togetherNone")
                : entry.atLeast ? t("controlAdmin:apps.hardwareTest.togetherAtLeast", { count: entry.atOnce })
                : t("controlAdmin:apps.hardwareTest.togetherCount", { count: entry.atOnce })}
            />
          ))}
        </GroupedList>
      )}

      {test && test.phase === "done" && test.suggestedViewers !== null && maxViewers !== null && !selected && (
        <MessageBox tone={test.suggestedViewers === maxViewers ? "success" : "info"} title={t("controlAdmin:apps.hardwareTest.suggestTitle", { count: test.suggestedViewers })}>
          {t("controlAdmin:apps.hardwareTest.suggestBody", { limit: maxViewers })}{" "}
          {test.suggestedViewers === maxViewers
            ? t("controlAdmin:apps.hardwareTest.suggestSame")
            : <Button variant="secondary" compact disabled={saving} onClick={() => onUseLimit(test.suggestedViewers!)}>{t("controlAdmin:apps.hardwareTest.useLimit", { count: test.suggestedViewers })}</Button>}
        </MessageBox>
      )}

      <DiskCheckSection prefix={prefix} testRunning={Boolean(running)} />

      <GroupedList title={t("controlAdmin:apps.hardwareTest.historyTitle")}>
        {pastTests.length === 0 && <InfoRow label={t("controlAdmin:apps.hardwareTest.historyEmpty")} />}
        {pastTests.map((past) => (
          <NavRow
            key={past.id ?? past.startedAt}
            icon={<History size={17} />}
            iconTone={past.phase === "done" ? "ok" : "muted"}
            label={formatManagedDate(past.startedAt)}
            sub={[
              past.phase === "done" ? t("controlAdmin:apps.hardwareTest.historyDone") : past.phase === "stopped" ? t("controlAdmin:apps.hardwareTest.historyStopped") : t("controlAdmin:apps.hardwareTest.historyFailed"),
              past.suggestedViewers ? t("controlAdmin:apps.hardwareTest.togetherCount", { count: past.suggestedViewers }) : null
            ].filter(Boolean).join(" · ")}
            onClick={() => setShown(past.id)}
          />
        ))}
      </GroupedList>

      <GroupedList title={t("controlAdmin:apps.hardwareTest.changesTitle")} note={t("controlAdmin:apps.hardwareTest.changesNote")}>
        {(history?.changes ?? []).length === 0 && <InfoRow label={t("controlAdmin:apps.hardwareTest.changesEmpty")} />}
        {(history?.changes ?? []).map((change) => (
          <InfoRow key={change.id} label={change.summary} sub={formatManagedDate(change.at)} />
        ))}
      </GroupedList>
    </div>
  );
}
