import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, X } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { GroupedList, PickerRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { APP_VERSION } from "../../../shared/appVersion";
import { bugReportUrl } from "../../../shared/links";

// The report dialog (docs/diagnostics-pages-plan.md; compact since 2026-11-17): three
// tabs. "What goes in" — how far back, and which parts; "Privacy" — the private
// details (none, unless switched on: a bug report is public); "Report" — the text as
// it will be saved, changing as the admin chooses. The buttons stay below all three. Opened from Diagnostics with every part ticked, and from a part's own
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
export const HOME_PARTS = ["system", "containers", "libraries", "failures", "tasks", "log"] as const;

export const REPORT_SPANS = ["hour", "day", "week"] as const;
export type ReportSpan = (typeof REPORT_SPANS)[number];
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

/** Saves the text as isputnik-diagnostics-<date>.txt. */
export function downloadReportText(text: string, generatedAt: string) {
  const stamp = generatedAt.slice(0, 16).replace(/[:T]/g, "-");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  link.download = `isputnik-diagnostics-${stamp}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function ReportDialog({ parts, onClose, onSaved }: {
  /** The parts ticked when it opens: "all", or section keys ("system", "container:video" …). */
  parts: "all" | readonly string[];
  onClose: () => void;
  /** After Save: the page's Saved reports list loads again. */
  onSaved?: () => void;
}) {
  const { t } = useTranslation(["controlAdmin", "common"]);
  // Private details are left out unless the admin ticks them in: a bug report is public.
  const [include, setInclude] = useState<Record<HideKind, boolean>>({ people: false, paths: false, names: false, net: false });
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(parts === "all" ? null : new Set(parts));
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [span, setSpan] = useState<ReportSpan>("day");
  const [tab, setTab] = useState<"settings" | "privacy" | "report">("settings");

  const hideQuery = HIDE_KINDS.filter((kind) => !include[kind]).join(",");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await api<{ report: DiagnosticsReport }>(`/api/admin/diagnostics?hide=${hideQuery}&since=${span}`);
      setReport(body.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [hideQuery, span, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // "all" becomes the report's own sections once it is in: a container not set up has none.
  const picked = useMemo(() => chosen ?? new Set(report?.sections.map((section) => section.key) ?? []), [chosen, report]);
  const text = useMemo(() => (report ? reportText(report, picked) : ""), [report, picked]);
  const containers = (report?.sections ?? []).filter((section) => section.key.startsWith("container:"));
  const nothingChosen = report !== null && !report.sections.some((section) => picked.has(section.key));
  const nothingHidden = HIDE_KINDS.every((kind) => include[kind]);

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

  const download = () => downloadReportText(text, report?.generatedAt ?? new Date().toISOString());

  // Save keeps the text on this server exactly as shown (Saved reports below the cards).
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const save = async () => {
    if (!report) return;
    setSaving(true);
    setError("");
    try {
      await api("/api/admin/diagnostics/saved", {
        method: "POST",
        body: JSON.stringify({
          text,
          span,
          parts: report.sections.map((section) => section.key).filter((key) => picked.has(key)),
          hidden: report.hidden ?? (report.includesPrivate ? [] : [...HIDE_KINDS])
        })
      });
      setSavedAt(text);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.saved.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  // "Saved" holds until the text changes: the same report isn't saved twice by accident.
  const alreadySaved = savedAt !== null && savedAt === text;

  const homeLabel = (key: HomePart) => t(`controlAdmin:diagnostics.parts.${key}.label`);
  const homeSub = (key: HomePart) => t(`controlAdmin:diagnostics.parts.${key}.sub`);

  return (
    <Modal
      title={t("controlAdmin:diagnostics.report.title")}
      subtitle={t("controlAdmin:diagnostics.nothingSent")}
      icon={<FileDown size={20} />}
      onClose={onClose}
      className="diagnostics-report-modal"
      headerAction={
        <Button variant="bare" className="modal-close" onClick={onClose} aria-label={t("common:common.close")} title={t("common:common.close")}>
          <X size={18} aria-hidden="true" />
        </Button>
      }
    >
      <div className="modal-tabs diagnostics-report-tabs" role="tablist">
        <Button variant="tab" className="modal-tab" selected={tab === "settings"} onClick={() => setTab("settings")}>{t("controlAdmin:diagnostics.report.tabSettings")}</Button>
        <Button variant="tab" className="modal-tab" selected={tab === "privacy"} onClick={() => setTab("privacy")}>{t("controlAdmin:diagnostics.report.tabPrivacy")}</Button>
        <Button variant="tab" className="modal-tab" selected={tab === "report"} onClick={() => setTab("report")}>{t("controlAdmin:diagnostics.report.tabReport")}</Button>
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.loadFailed")}>{error}</MessageBox>}

      {tab === "settings" ? (
        // What goes in: how far back, then which parts.
        <div className="diagnostics-report-body" role="tabpanel" aria-label={t("controlAdmin:diagnostics.report.tabSettings")}>
          <GroupedList note={t("controlAdmin:diagnostics.report.spanNote")}>
            <PickerRow
              label={t("controlAdmin:diagnostics.report.spanLabel")}
              value={span}
              disabled={loading}
              options={REPORT_SPANS.map((value) => ({ value, label: t(`controlAdmin:diagnostics.report.span.${value}`) }))}
              onChange={(value) => setSpan(value as ReportSpan)}
            />
          </GroupedList>
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
        </div>
      ) : tab === "privacy" ? (
        // The private details: each left out unless switched on.
        <div className="diagnostics-report-body" role="tabpanel" aria-label={t("controlAdmin:diagnostics.report.tabPrivacy")}>
          <GroupedList title={t("controlAdmin:diagnostics.report.includeTitle")} note={t("controlAdmin:diagnostics.report.alwaysRemoved")}>
            {HIDE_KINDS.map((kind) => (
              <ToggleRow
                key={kind}
                label={t(`controlAdmin:diagnostics.report.include.${kind}.label`)}
                sub={t(`controlAdmin:diagnostics.report.include.${kind}.sub`)}
                checked={include[kind]}
                disabled={loading}
                onChange={(on) => setInclude((current) => ({ ...current, [kind]: on }))}
              />
            ))}
          </GroupedList>
          {nothingHidden && (
            <MessageBox tone="warning" title={t("controlAdmin:diagnostics.privateWarningTitle")}>
              {t("controlAdmin:diagnostics.privateWarning")}
            </MessageBox>
          )}
        </div>
      ) : (
        // The report as it will be saved.
        <div className="diagnostics-report-body" role="tabpanel" aria-label={t("controlAdmin:diagnostics.report.tabReport")}>
          <pre className="diagnostics-text" tabIndex={0} aria-label={t("controlAdmin:diagnostics.previewTitle")}>
            {loading ? t("controlAdmin:diagnostics.making") : nothingChosen ? t("controlAdmin:diagnostics.report.nothingChosen") : text}
          </pre>
        </div>
      )}

      <div className="modal-actions">
        <a className="secondary-button" href={bugReportUrl(APP_VERSION)} target="_blank" rel="noreferrer">{t("controlAdmin:diagnostics.openBugReport")}</a>
        <Button variant="secondary" onClick={() => void copy()} disabled={loading || nothingChosen || !report}>
          {copied ? t("controlAdmin:diagnostics.copied") : t("controlAdmin:diagnostics.copy")}
        </Button>
        <Button variant="secondary" onClick={() => void save()} disabled={loading || nothingChosen || !report || saving || alreadySaved}>
          {saving ? t("controlAdmin:diagnostics.saved.saving") : alreadySaved ? t("controlAdmin:diagnostics.saved.savedDone") : t("controlAdmin:diagnostics.saved.save")}
        </Button>
        <Button variant="primary" onClick={download} disabled={loading || nothingChosen || !report}>{t("controlAdmin:diagnostics.download")}</Button>
      </div>
    </Modal>
  );
}
