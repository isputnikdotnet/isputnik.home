import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Stethoscope } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { GroupedList, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { APP_VERSION } from "../../../shared/appVersion";
import { bugReportUrl } from "../../../shared/links";
import { ControlSectionHead } from "../ControlSectionHead";

// Control panel › Infrastructure › Diagnostics: a report to attach to a bug report
// (server: modules/diagnostics). Every part is shown before it is copied, each
// part can be left out, and the household's names, folders and addresses are
// hidden unless the admin asks to include them. Nothing is sent anywhere: the
// admin copies or downloads the text and pastes it into the issue themselves.

interface ReportSection {
  key: string;
  title: string;
  lines: string[];
}

interface DiagnosticsReport {
  generatedAt: string;
  includesPrivate: boolean;
  sections: ReportSection[];
}

/** Which explanation a part gets: a container's own part shares one. */
type PartKind = "system" | "containers" | "libraries" | "failures" | "container";
const kindOf = (key: string): PartKind => (key.startsWith("container:") ? "container" : (key as PartKind));

export function reportText(report: DiagnosticsReport, left: ReadonlySet<string>): string {
  const parts = report.sections.filter((section) => !left.has(section.key));
  return [
    `iSputnik diagnostics, ${report.generatedAt.slice(0, 19).replace("T", " ")} UTC`,
    report.includesPrivate ? "Names, folders and addresses are included." : "Names, folders and addresses are hidden (<person>, <path>, <ip> …).",
    "",
    ...parts.flatMap((section) => [`## ${section.title}`, ...section.lines, ""])
  ].join("\n").trimEnd() + "\n";
}

export function DiagnosticsSection() {
  const { t } = useTranslation(["controlAdmin"]);
  const [includePrivate, setIncludePrivate] = useState(false);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (withPrivate: boolean) => {
    setLoading(true);
    setError("");
    try {
      const body = await api<{ report: DiagnosticsReport }>(`/api/admin/diagnostics?private=${withPrivate}`);
      setReport(body.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.loadFailed"));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(includePrivate).catch(() => undefined);
  }, [load, includePrivate]);

  const text = useMemo(() => (report ? reportText(report, left) : ""), [report, left]);

  const toggle = (key: string, keep: boolean) => {
    setLeft((current) => {
      const next = new Set(current);
      if (keep) next.delete(key);
      else next.add(key);
      return next;
    });
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

  const describe = (section: ReportSection) => {
    const kind = kindOf(section.key);
    const name = section.key.startsWith("container:") ? section.key.slice("container:".length) : "";
    return {
      label: kind === "container" ? t("controlAdmin:diagnostics.parts.container.label", { name }) : t(`controlAdmin:diagnostics.parts.${kind}.label`),
      sub: kind === "container" ? t("controlAdmin:diagnostics.parts.container.sub", { name }) : t(`controlAdmin:diagnostics.parts.${kind}.sub`)
    };
  };

  return (
    <div className="diagnostics-section">
      <ControlSectionHead section="diagnostics" icon={<Stethoscope size={30} />} description={t("controlAdmin:diagnostics.description")}>
        <RefreshButton onRefresh={() => load(includePrivate)} />
      </ControlSectionHead>

      <MessageBox tone="info" title={t("controlAdmin:diagnostics.nothingSentTitle")}>
        {t("controlAdmin:diagnostics.nothingSent")}
      </MessageBox>

      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.loadFailed")}>{error}</MessageBox>}

      <GroupedList title={t("controlAdmin:diagnostics.privacyTitle")}>
        <ToggleRow
          label={t("controlAdmin:diagnostics.includePrivate")}
          sub={t("controlAdmin:diagnostics.includePrivateSub")}
          checked={includePrivate}
          disabled={loading}
          onChange={setIncludePrivate}
        />
      </GroupedList>

      {includePrivate && (
        <MessageBox tone="warning" title={t("controlAdmin:diagnostics.privateWarningTitle")}>
          {t("controlAdmin:diagnostics.privateWarning")}
        </MessageBox>
      )}

      {report && (
        <GroupedList title={t("controlAdmin:diagnostics.partsTitle")} note={t("controlAdmin:diagnostics.partsNote")}>
          {report.sections.map((section) => {
            const { label, sub } = describe(section);
            return <ToggleRow key={section.key} label={label} sub={sub} checked={!left.has(section.key)} onChange={(keep) => toggle(section.key, keep)} />;
          })}
        </GroupedList>
      )}

      {report && (
        <section className="diagnostics-preview" aria-label={t("controlAdmin:diagnostics.previewTitle")}>
          <div className="diagnostics-preview-head">
            <h3>{t("controlAdmin:diagnostics.previewTitle")}</h3>
            <div className="diagnostics-actions">
              <Button variant="secondary" onClick={() => void copy()} disabled={loading}>
                {copied ? t("controlAdmin:diagnostics.copied") : t("controlAdmin:diagnostics.copy")}
              </Button>
              <Button variant="secondary" onClick={download} disabled={loading}>{t("controlAdmin:diagnostics.download")}</Button>
              <a className="primary-button" href={bugReportUrl(APP_VERSION)} target="_blank" rel="noreferrer">{t("controlAdmin:diagnostics.openBugReport")}</a>
            </div>
          </div>
          <pre className="diagnostics-text" tabIndex={0}>{loading ? t("controlAdmin:diagnostics.making") : text}</pre>
        </section>
      )}
    </div>
  );
}
