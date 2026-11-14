import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileDown, Stethoscope } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, libraryManageHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { relativeTime } from "../../../shared/relativeTime";
import { ControlSectionHead } from "../ControlSectionHead";
import { ReportDialog } from "../diagnostics/ReportDialog";
import { appPageHref, logsHref } from "../links";
import { useAppName } from "./AppsSection";

// Control panel › Infrastructure › Diagnostics (docs/diagnostics-pages-plan.md):
// one card per part of iSputnik — this server, then each container — saying how it
// is and what needs a look, with links to where it is fixed and its tests; and one
// Download report button, which opens the report dialog with every part ticked.
// The server's side is modules/diagnostics (overview.ts for the cards).

type PartState = "ok" | "attention" | "down" | "off";

type PartProblem =
  | { kind: "folderMissing" | "folderSlow" | "scanFailed"; library: string; libraryId: string }
  | { kind: "noBackup" }
  | { kind: "backupOld"; days: number }
  | { kind: "backupFailed"; error: string }
  | { kind: "notAnswering"; error: string | null }
  | { kind: "secretRefused" };

interface PartOverview {
  id: string;
  state: PartState;
  version: string | null;
  roundTripMs: number | null;
  problems: PartProblem[];
  libraries?: number;
  lastBackupAt?: string | null;
}

const PILL: Record<PartState, string> = { ok: "is-ready", attention: "is-needsSetup", down: "is-needsSetup", off: "is-off" };

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
      {children}
      <ArrowRight size={15} aria-hidden="true" />
    </a>
  );
}

export function DiagnosticsSection() {
  const { t } = useTranslation(["controlAdmin"]);
  const appName = useAppName();
  const [parts, setParts] = useState<PartOverview[] | null>(null);
  const [error, setError] = useState("");
  const [reporting, setReporting] = useState(false);

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

  const problemText = (problem: PartProblem): string => {
    switch (problem.kind) {
      case "folderMissing":
      case "folderSlow":
      case "scanFailed":   return t(`controlAdmin:diagnostics.problem.${problem.kind}`, { library: problem.library });
      case "backupOld":    return t("controlAdmin:diagnostics.problem.backupOld", { count: problem.days });
      case "notAnswering": return problem.error ? t("controlAdmin:diagnostics.problem.notAnsweringWhy", { error: problem.error }) : t("controlAdmin:diagnostics.problem.notAnswering");
      default:             return t(`controlAdmin:diagnostics.problem.${problem.kind}`);
    }
  };

  const lineOf = (part: PartOverview): string => {
    if (part.problems.length > 0) return part.problems.map(problemText).join(" · ");
    if (part.id === "home") {
      const backup = part.lastBackupAt ? relativeTime(part.lastBackupAt) : "—";
      return t("controlAdmin:diagnostics.line.home", { count: part.libraries ?? 0, backup });
    }
    if (part.state === "off") return t("controlAdmin:diagnostics.line.off");
    return t("controlAdmin:diagnostics.line.answers", { ms: part.roundTripMs ?? "?" });
  };

  /** Where a part's trouble is put right, and its tests. */
  const actionsOf = (part: PartOverview) => {
    const links: { href: string; label: string }[] = [];
    if (part.id === "home") {
      const library = part.problems.find((problem) => "libraryId" in problem);
      if (library && "libraryId" in library) links.push({ href: libraryManageHref(library.libraryId), label: t("controlAdmin:diagnostics.action.library", { library: library.library }) });
      if (part.problems.some((problem) => problem.kind.startsWith("backup") || problem.kind === "noBackup")) links.push({ href: controlHref("backup"), label: t("controlAdmin:diagnostics.action.backups") });
      links.push({ href: logsHref(), label: t("controlAdmin:diagnostics.action.logs") });
      return links;
    }
    if (part.state === "off" || part.state === "down" || part.state === "attention") links.push({ href: appPageHref("appsSetup", part.id), label: t("controlAdmin:diagnostics.action.pairing") });
    if (part.id === "video" && part.state === "ok") links.push({ href: `${controlHref("videoSettings")}?show=hardware`, label: t("controlAdmin:diagnostics.action.tests") });
    if (part.state !== "off") links.push({ href: logsHref({ app: part.id }), label: t("controlAdmin:diagnostics.action.logs") });
    return links;
  };

  return (
    <div className="diagnostics-section">
      <ControlSectionHead section="diagnostics" icon={<Stethoscope size={30} />} description={t("controlAdmin:diagnostics.description")}>
        <RefreshButton onRefresh={load} />
        <Button variant="primary" onClick={() => setReporting(true)}><FileDown size={16} aria-hidden="true" />{t("controlAdmin:diagnostics.downloadReport")}</Button>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.overviewFailed")}>{error}</MessageBox>}

      <div className="diagnostics-parts">
        {(parts ?? []).map((part) => (
          <section key={part.id} className={`organization-card diagnostics-part is-${part.state}`} aria-labelledby={`diagnostics-${part.id}`}>
            <div className="service-card-head">
              <div className="diagnostics-part-name">
                <h2 id={`diagnostics-${part.id}`}>{part.id === "home" ? t("controlAdmin:diagnostics.home") : appName(part.id)}</h2>
                <span className="muted">
                  {part.id === "home"
                    ? t("controlAdmin:diagnostics.thisServer", { version: part.version ?? "?" })
                    : part.version ? t("controlAdmin:diagnostics.container", { version: part.version }) : t("controlAdmin:diagnostics.containerNoVersion")}
                </span>
              </div>
              <span className={`app-status-pill ${PILL[part.state]}`}>{t(`controlAdmin:diagnostics.state.${part.state}`)}</span>
            </div>
            <p className={part.problems.length ? "diagnostics-part-line is-warning" : "diagnostics-part-line"}>{lineOf(part)}</p>
            <div className="organization-actions">
              {actionsOf(part).map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
            </div>
          </section>
        ))}
        {parts === null && !error && <p className="muted">{t("controlAdmin:diagnostics.looking")}</p>}
      </div>

      {reporting && <ReportDialog parts="all" onClose={() => setReporting(false)} />}
    </div>
  );
}
