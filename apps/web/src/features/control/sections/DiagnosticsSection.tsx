import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, ChevronRight, FileDown, Gamepad2, Link2, ScanFace, Server, SquareArrowOutUpRight, Stethoscope, Video } from "lucide-react";
import { controlHref, diagnosticsPartHref, followRoute, libraryManageHref, type DiagnosticsPart } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { relativeTime } from "../../../shared/relativeTime";
import { ControlSectionHead } from "../ControlSectionHead";
import { ReportDialog } from "../diagnostics/ReportDialog";
import { useDiagnosticsOverview, useProblemText, type PartOverview, type PartState } from "../diagnostics/overview";
import { appPageHref } from "../links";
import { useAppName, useAppsStatus } from "./AppsSection";
import { LoggingModes, LoggingModesLegend, loggingUrl } from "../diagnostics/Logging";
import { useWatchingCount } from "../diagnostics/Watching";
import { SavedReports, useSavedReports } from "../diagnostics/SavedReports";

// Control panel › Infrastructure › Diagnostics (docs/diagnostics-pages-plan.md;
// redrawn 2026-11-17): one card per part of iSputnik — this server, then each
// container — its icon, what it is and its version, one line of how it is and a
// state pill; under that its diagnostic mode (Normal | Detailed | Full) and one way
// on: Open details, or Pair now while it is not set up (plus where a problem is put
// right). The modes are explained once, at the foot. One Download report button
// opens the report dialog with every part ticked; the reports saved from it are
// listed at the foot (SavedReports).
// The server's side is modules/diagnostics (overview.ts for the cards).

const PILL: Record<PartState, string> = { ok: "is-ready", attention: "is-needsSetup", down: "is-needsSetup", off: "is-off" };

/** A card's button: a real link, so it opens in a new tab on Ctrl/Cmd-click. */
function Link({ href, children, icon, chevron = false }: { href: string; children: React.ReactNode; icon?: React.ReactNode; chevron?: boolean }) {
  return (
    <a className="secondary-button compact-button diagnostics-part-button" href={href} onClick={(event) => followRoute(event, href)}>
      {icon}
      {children}
      {chevron && <ChevronRight size={14} aria-hidden="true" />}
    </a>
  );
}

/** Each part's picture: the server, and each container by what it does. */
const PART_ICON: Record<string, React.ReactNode> = {
  home: <Server size={22} />,
  games: <Gamepad2 size={22} />,
  video: <Video size={22} />,
  faces: <ScanFace size={22} />
};

/** " · 2 watching" after Video's line, once the engine says. */
function WatchingSuffix({ prefix }: { prefix: string | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  const count = useWatchingCount(prefix);
  return count === null ? null : <>{` · ${t("controlAdmin:diagnostics.watching.count", { count })}`}</>;
}

export function DiagnosticsSection() {
  const { t } = useTranslation(["controlAdmin"]);
  const appName = useAppName();
  const { apps } = useAppsStatus();
  const { parts, error } = useDiagnosticsOverview();
  /** Where a part's logging is read: this server's own, or the container's through the gateway. */
  const loggingOf = (part: PartOverview): string | null => {
    if (part.id === "home") return loggingUrl(null);
    const app = apps?.find((entry) => entry.id === part.id);
    return app && part.state !== "off" && part.state !== "down" ? loggingUrl(app.prefix) : null;
  };
  const problemText = useProblemText();
  const [reporting, setReporting] = useState(false);
  const saved = useSavedReports();

  const lineOf = (part: PartOverview): string => {
    if (part.problems.length > 0) return part.problems.map(problemText).join(" · ");
    if (part.id === "home") {
      const backup = part.lastBackupAt ? relativeTime(part.lastBackupAt) : "—";
      return t("controlAdmin:diagnostics.line.home", { count: part.libraries ?? 0, backup });
    }
    if (part.state === "off") return t("controlAdmin:diagnostics.line.off");
    return t("controlAdmin:diagnostics.line.answers", { ms: part.roundTripMs ?? "?" });
  };

  /** Where a part's trouble is put right — only while there is some. Its log is a
   *  step further, on its Details page. */
  const fixesOf = (part: PartOverview) => {
    const links: { href: string; label: string }[] = [];
    if (part.id === "home") {
      const library = part.problems.find((problem) => "libraryId" in problem);
      if (library && "libraryId" in library) links.push({ href: libraryManageHref(library.libraryId), label: t("controlAdmin:diagnostics.action.library", { library: library.library }) });
      if (part.problems.some((problem) => problem.kind.startsWith("backup") || problem.kind === "noBackup")) links.push({ href: controlHref("backup"), label: t("controlAdmin:diagnostics.action.backups") });
      return links;
    }
    if (part.state === "attention") links.push({ href: appPageHref("appsSetup", part.id), label: t("controlAdmin:diagnostics.action.pairing") });
    return links;
  };

  return (
    <div className="diagnostics-section">
      <ControlSectionHead section="diagnostics" icon={<Stethoscope size={30} />} description={t("controlAdmin:diagnostics.description")}>
        <Button variant="primary" onClick={() => setReporting(true)}><FileDown size={16} aria-hidden="true" />{t("controlAdmin:diagnostics.downloadReport")}</Button>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.overviewFailed")}>{error}</MessageBox>}

      <div className="diagnostics-parts">
        {(parts ?? []).map((part) => {
          const name = part.id === "home" ? t("controlAdmin:diagnostics.home") : appName(part.id);
          const logging = loggingOf(part);
          const unpaired = part.state === "off" || part.state === "down";
          return (
          <section key={part.id} className={`diagnostics-part is-${part.state}`} aria-labelledby={`diagnostics-${part.id}`}>
            <div className="diagnostics-part-body">
              <span className="diagnostics-part-icon" aria-hidden="true">{PART_ICON[part.id] ?? <Box size={22} />}</span>
              <div className="diagnostics-part-text">
                <div className="diagnostics-part-name">
                  <h2 id={`diagnostics-${part.id}`}>{name}</h2>
                  <span className="muted">
                    {part.id === "home"
                      ? t("controlAdmin:diagnostics.thisServer", { version: part.version ?? "?" })
                      : part.version ? t("controlAdmin:diagnostics.container", { version: part.version }) : t("controlAdmin:diagnostics.containerNoVersion")}
                  </span>
                </div>
                <p className={part.problems.length ? "diagnostics-part-line is-warning" : "diagnostics-part-line"}>
                  {lineOf(part)}
                  {part.id === "video" && part.state === "ok" && <WatchingSuffix prefix={apps?.find((app) => app.id === "video")?.prefix ?? null} />}
                </p>
              </div>
              <span className={`app-status-pill ${PILL[part.state]}`}>{t(`controlAdmin:diagnostics.state.${part.state}`)}</span>
            </div>
            <div className="diagnostics-part-foot">
              <LoggingModes url={logging} name={name} />
              <div className="diagnostics-part-actions">
                {fixesOf(part).map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
                {unpaired
                  ? <Link href={appPageHref("appsSetup", part.id)} icon={<Link2 size={15} aria-hidden="true" />} chevron>{t("controlAdmin:diagnostics.action.pairNow")}</Link>
                  : <Link href={diagnosticsPartHref(part.id as DiagnosticsPart)} icon={<SquareArrowOutUpRight size={15} aria-hidden="true" />} chevron>{t("controlAdmin:diagnostics.action.openDetails")}</Link>}
              </div>
            </div>
          </section>
          );
        })}
        {parts === null && !error && <p className="muted">{t("controlAdmin:diagnostics.looking")}</p>}
      </div>

      {parts && <LoggingModesLegend />}

      <SavedReports saved={saved} />

      {reporting && <ReportDialog parts="all" onClose={() => setReporting(false)} onSaved={() => void saved.load()} />}
    </div>
  );
}
