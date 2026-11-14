import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";

// GET /api/admin/diagnostics/overview (server: modules/diagnostics/overview.ts):
// one entry per part of iSputnik, for the Diagnostics page's cards and each
// part's own page.

export type PartState = "ok" | "attention" | "down" | "off";

export type PartProblem =
  | { kind: "folderMissing" | "folderSlow" | "scanFailed"; library: string; libraryId: string }
  | { kind: "noBackup" }
  | { kind: "backupOld"; days: number }
  | { kind: "backupFailed"; error: string }
  | { kind: "notAnswering"; error: string | null }
  | { kind: "secretRefused" };

export interface LibraryCheck {
  id: string;
  name: string;
  type: string;
  state: "ok" | "missing" | "slow" | "scanFailed" | "container";
  ms: number | null;
}

export interface CallCount {
  day: string;
  count: number;
  failed: number;
  since: string;
  lastAt: string | null;
  lastFailedAt: string | null;
  lastFailedStatus: number | null;
}

export interface PartOverview {
  id: string;
  state: PartState;
  version: string | null;
  roundTripMs: number | null;
  problems: PartProblem[];
  libraries?: number;
  lastBackupAt?: string | null;
  uptimeSeconds?: number;
  libraryChecks?: LibraryCheck[];
  lastBackup?: { at: string; kind: string; sizeBytes: number } | null;
  backupError?: string | null;
  machine?: { node: string; os: string; cpus: number; memoryBytes: number; rssBytes: number };
  calls?: CallCount;
}

export function useDiagnosticsOverview() {
  const { t } = useTranslation(["controlAdmin"]);
  const [parts, setParts] = useState<PartOverview[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const body = await api<{ parts: PartOverview[] }>("/api/admin/diagnostics/overview");
      setParts(body.parts);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.overviewFailed"));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  return { parts, error, load };
}

/** A problem in a few words, for a card's line and a page's banner. */
export function useProblemText() {
  const { t } = useTranslation(["controlAdmin"]);
  return (problem: PartProblem): string => {
    switch (problem.kind) {
      case "folderMissing":
      case "folderSlow":
      case "scanFailed":   return t(`controlAdmin:diagnostics.problem.${problem.kind}`, { library: problem.library });
      case "backupOld":    return t("controlAdmin:diagnostics.problem.backupOld", { count: problem.days });
      case "notAnswering": return problem.error ? t("controlAdmin:diagnostics.problem.notAnsweringWhy", { error: problem.error }) : t("controlAdmin:diagnostics.problem.notAnswering");
      default:             return t(`controlAdmin:diagnostics.problem.${problem.kind}`);
    }
  };
}
