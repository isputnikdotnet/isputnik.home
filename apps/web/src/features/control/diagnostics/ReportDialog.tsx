import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { GroupedList, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { APP_VERSION } from "../../../shared/appVersion";
import { bugReportUrl } from "../../../shared/links";

// The report dialog (docs/diagnostics-pages-plan.md): which parts go in, what is
// hidden, and the report itself as it will be saved, changing as the admin
// chooses. Opened from Diagnostics with every part ticked, and from a part's own
// page with only that part. Nothing is sent anywhere: the admin copies or saves
// the text and attaches it themselves.

export interface ReportSection {
  key: string;
  title: string;
  lines: string[];
}

export interface DiagnosticsReport {
  generatedAt: string;
  includesPrivate: boolean;
  hidden?: HideKind[];
  sections: ReportSection[];
}

export const HIDE_KINDS = ["people", "paths", "names", "net"] as const;
export type HideKind = (typeof HIDE_KINDS)[number];

/** This server's own sections, in the report's order; a container's is `container:<id>`. */
export const HOME_PARTS = ["system", "containers", "libraries", "failures"] as const;
type HomePart = (typeof HOME_PARTS)[number];

const PLACEHOLDERS: Record<HideKind, string> = { people: "<person>, <email>", paths: "<path>", names: "<name>", net: "<ip>, <host>" };

/** The report as text, the chosen sections only. English: issue trackers are. */
export function reportText(report: DiagnosticsReport, chosen: ReadonlySet<string>): string {
  const parts = report.sections.filter((section) => chosen.has(section.key));
  const hidden = report.hidden ?? (report.includesPrivate ? [] : [...HIDE_KINDS]);
  return [
    `iSputnik diagnostics, ${report.generatedAt.slice(0, 19).replace("T", " ")} UTC`,
    hidden.length === 0
      ? "Names, folders and addresses are included."
      : `Hidden: ${hidden.map((kind) => PLACEHOLDERS[kind]).join(", ")}.`,
    "",
    ...parts.flatMap((section) => [`## ${section.title}`, ...section.lines, ""])
  ].join("\n").trimEnd() + "\n";
}

export function ReportDialog({ parts, onClose }: {
  /** The parts ticked when it opens: "all", or section keys ("system", "container:video" …). */
  parts: "all" | readonly string[];
  onClose: () => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [hide, setHide] = useState<Record<HideKind, boolean>>({ people: true, paths: true, names: true, net: true });
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(parts === "all" ? null : new Set(parts));
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const hideQuery = HIDE_KINDS.filter((kind) => hide[kind]).join(",");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await api<{ report: DiagnosticsReport }>(`/api/admin/diagnostics?hide=${hideQuery}`);
      setReport(body.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [hideQuery, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // "all" becomes the report's own sections once it is in: a container not set up has none.
  const picked = useMemo(() => chosen ?? new Set(report?.sections.map((section) => section.key) ?? []), [chosen, report]);
  const text = useMemo(() => (report ? reportText(report, picked) : ""), [report, picked]);
  const containers = (report?.sections ?? []).filter((section) => section.key.startsWith("container:"));
  const nothingChosen = report !== null && !report.sections.some((section) => picked.has(section.key));
  const nothingHidden = HIDE_KINDS.every((kind) => !hide[kind]);

  const toggle = (key: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("controlAdmin:diagnostics.copyFailed"));
    }
  };

  const download = () => {
    const stamp = (report?.generatedAt ?? new Date().toISOString()).slice(0, 16).replace(/[:T]/g, "-");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    link.download = `isputnik-diagnostics-${stamp}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const homeLabel = (key: HomePart) => t(`controlAdmin:diagnostics.parts.${key}.label`);
  const homeSub = (key: HomePart) => t(`controlAdmin:diagnostics.parts.${key}.sub`);

  return (
    <Modal
      variant="panel"
      title={t("controlAdmin:diagnostics.report.title")}
      subtitle={t("controlAdmin:diagnostics.nothingSent")}
      icon={<FileDown size={20} />}
      onClose={onClose}
      className="diagnostics-report-modal"
    >
      <div className="diagnostics-report">
        <div className="diagnostics-report-choices">
          <GroupedList title={t("controlAdmin:diagnostics.report.homeTitle")}>
            {HOME_PARTS.map((key) => (
              <ToggleRow key={key} label={homeLabel(key)} sub={homeSub(key)} checked={picked.has(key)} disabled={!report} onChange={(on) => toggle(key, on)} />
            ))}
          </GroupedList>
          {containers.length > 0 && (
            <GroupedList title={t("controlAdmin:diagnostics.report.containersTitle")}>
              {containers.map((section) => {
                const name = section.key.slice("container:".length);
                return (
                  <ToggleRow
                    key={section.key}
                    label={t("controlAdmin:diagnostics.parts.container.label", { name })}
                    sub={t("controlAdmin:diagnostics.parts.container.sub", { name })}
                    checked={picked.has(section.key)}
                    onChange={(on) => toggle(section.key, on)}
                  />
                );
              })}
            </GroupedList>
          )}
          <GroupedList title={t("controlAdmin:diagnostics.report.hideTitle")} note={t("controlAdmin:diagnostics.report.alwaysRemoved")}>
            {HIDE_KINDS.map((kind) => (
              <ToggleRow
                key={kind}
                label={t(`controlAdmin:diagnostics.report.hide.${kind}.label`)}
                sub={t(`controlAdmin:diagnostics.report.hide.${kind}.sub`)}
                checked={hide[kind]}
                disabled={loading}
                onChange={(on) => setHide((current) => ({ ...current, [kind]: on }))}
              />
            ))}
          </GroupedList>
          {nothingHidden && (
            <MessageBox tone="warning" title={t("controlAdmin:diagnostics.privateWarningTitle")}>
              {t("controlAdmin:diagnostics.privateWarning")}
            </MessageBox>
          )}
        </div>

        <section className="diagnostics-preview" aria-label={t("controlAdmin:diagnostics.previewTitle")}>
          <h3>{t("controlAdmin:diagnostics.previewTitle")}</h3>
          {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.loadFailed")}>{error}</MessageBox>}
          <pre className="diagnostics-text" tabIndex={0}>
            {loading ? t("controlAdmin:diagnostics.making") : nothingChosen ? t("controlAdmin:diagnostics.report.nothingChosen") : text}
          </pre>
        </section>
      </div>

      <div className="modal-actions">
        <a className="secondary-button" href={bugReportUrl(APP_VERSION)} target="_blank" rel="noreferrer">{t("controlAdmin:diagnostics.openBugReport")}</a>
        <Button variant="secondary" onClick={() => void copy()} disabled={loading || nothingChosen || !report}>
          {copied ? t("controlAdmin:diagnostics.copied") : t("controlAdmin:diagnostics.copy")}
        </Button>
        <Button variant="primary" onClick={download} disabled={loading || nothingChosen || !report}>{t("controlAdmin:diagnostics.download")}</Button>
      </div>
    </Modal>
  );
}
