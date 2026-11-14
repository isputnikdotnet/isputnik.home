import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { relativeTime } from "../../../shared/relativeTime";

// This server's tests (server: modules/diagnostics/tests.ts), each beside what it
// checks on Diagnostics › iSputnik: Check folders under Libraries, Verify the
// last backup under Backups, Test speed under Speed to this device. The first two
// run on the server, one at a time; the page looks again until they finish. The
// speed test runs here, in the browser — it's this device's speed — and the
// result is recorded with the others.

export interface FolderResult {
  libraryId: string;
  name: string;
  type: string;
  firstMs: number | null;
  secondMs: number | null;
  asleep: boolean;
  read: { bytes: number; seconds: number; mbitPerSecond: number } | null;
  verdict: "ok" | "slow" | "missing";
  error: string | null;
}

export interface BackupVerification {
  name: string;
  createdAt: string;
  sizeBytes: number;
  ok: boolean;
  files: number;
  bytes: number;
  manifest: { kind: string | null; version: string | null } | null;
  database: { found: boolean; integrity: string | null; tables: number } | null;
  error: string | null;
  ms: number;
}

export interface SpeedResult {
  at: string;
  downloadMbps: number;
  replyMs: number;
  bytes: number;
}

export interface TestRun {
  kind: "folders" | "backup" | "speed";
  at: string;
  ok: boolean;
  facts: Record<string, string | number | null>;
}

export interface TestsState {
  running: { kind: "folders" | "backup"; startedAt: string; step: string | null } | null;
  folders: { at: string; libraries: FolderResult[]; ms: number } | null;
  backup: BackupVerification | null;
  speed: SpeedResult | null;
  runs: TestRun[];
}

const URL = "/api/admin/diagnostics/tests";
const POLL_MS = 1500;
const SPEED_BYTES = 25 * 1024 * 1024;

export function useHomeTests(enabled = true) {
  const [state, setState] = useState<TestsState | null>(null);
  const [error, setError] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setState(await api<TestsState>(URL));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  // While one runs, look again until it is done.
  useEffect(() => {
    if (!state?.running) return;
    const timer = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [state, load]);

  const run = async (kind: "folders" | "backup") => {
    setError("");
    try {
      setState(await api<TestsState>(`${URL}/${kind}`, { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  /** This browser's speed: the quickest of a few replies, then 25 MB of random bytes, timed. */
  const measureSpeed = async () => {
    setMeasuring(true);
    setError("");
    try {
      const replies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await fetch("/api/health", { cache: "no-store", credentials: "include" });
        replies.push(performance.now() - started);
      }
      const started = performance.now();
      const response = await fetch(`/api/speed-test?bytes=${SPEED_BYTES}`, { cache: "no-store", credentials: "include" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      const seconds = Math.max(0.001, (performance.now() - started) / 1000);
      const result = {
        downloadMbps: Math.round(((bytes * 8) / 1_000_000 / seconds) * 10) / 10,
        replyMs: Math.round(Math.min(...replies)),
        bytes
      };
      setState(await api<TestsState>(`${URL}/speed`, { method: "POST", body: JSON.stringify(result) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMeasuring(false);
    }
  };

  return { state, error, measuring, run, measureSpeed };
}

/** A test's row: what it does, when it last ran, and its button. */
export function TestBar({ title, about, last, running, disabled, waits, onRun, label }: {
  title: string;
  about: string;
  last: ReactNode;
  running: boolean;
  /** Another test is running: this one waits. */
  waits: boolean;
  disabled?: boolean;
  onRun: () => void;
  label: string;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  return (
    <div className="diagnostics-test">
      <div className="diagnostics-test-text">
        <strong>{title}</strong>
        <span className="muted">{about}</span>
        {last && <span className="diagnostics-test-last">{last}</span>}
      </div>
      <Button variant="secondary" disabled={running || waits || disabled} onClick={onRun}>
        {running ? t("controlAdmin:diagnostics.tests.running") : waits ? t("controlAdmin:diagnostics.tests.waits") : label}
      </Button>
    </div>
  );
}

/** What a speed is enough for, in a word. */
export function speedVerdict(mbps: number): "original4k" | "hd" | "sd" | "slow" {
  if (mbps >= 100) return "original4k";
  if (mbps >= 25) return "hd";
  if (mbps >= 8) return "sd";
  return "slow";
}

/** One run, in a line, for Recent runs. */
export function useRunWords() {
  const { t } = useTranslation(["controlAdmin"]);
  return (run: TestRun): string => {
    const facts = run.facts;
    if (run.kind === "folders") {
      return Number(facts.problems) > 0
        ? t("controlAdmin:diagnostics.tests.run.foldersBad", { count: Number(facts.problems), first: String(facts.first ?? "") })
        : t("controlAdmin:diagnostics.tests.run.foldersOk", { count: Number(facts.libraries) });
    }
    if (run.kind === "backup") {
      if (facts.none) return t("controlAdmin:diagnostics.tests.run.backupNone");
      return run.ok
        ? t("controlAdmin:diagnostics.tests.run.backupOk", { when: relativeTime(String(facts.createdAt)) })
        : t("controlAdmin:diagnostics.tests.run.backupBad", { when: relativeTime(String(facts.createdAt)) });
    }
    return t("controlAdmin:diagnostics.tests.run.speed", { mbps: facts.downloadMbps, ms: facts.replyMs });
  };
}
