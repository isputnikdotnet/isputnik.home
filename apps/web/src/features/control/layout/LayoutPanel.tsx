import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2, Plus, Pencil, Trash2, Eye, RefreshCw, Folder, Library, CornerDownRight, Info, AlertTriangle, Lock } from "lucide-react";
import { api } from "../../../api";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { relativeTime } from "../../../shared/utils";
import { humanize } from "./layout-model";
import { rulesBase, type LayoutLibrary, type ScanRule } from "./types";
import { ScanRuleWizard, type WizardTarget } from "./ScanRuleWizard";
import { useRoleLabels } from "./useRoleLabels";

// The Layout panel (docs/scan-layout-plan.md): the one place a library's whole
// scan policy is visible. The default layout (the root-anchored rule) is pinned
// first and cannot be deleted; rules for specific folders sit below with their
// counts and on/off switches; the metadata sources are shown read-only at the
// bottom so it is clear they are a separate question.
export function LayoutPanel({
  library,
  sources,
  legacyGrouping = null,
  onClose,
  onOpenSettings,
  onRescanLibrary
}: {
  library: LayoutLibrary;
  sources: { label: string; enabled: boolean }[];
  // An audiobook library still on the pre-layout grouping toggles: the default
  // row says so instead of describing the plain scanner defaults.
  legacyGrouping?: "folder_structure" | "single_file" | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onRescanLibrary: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const roleLabels = useRoleLabels();
  const base = rulesBase(library.id);
  const noun = library.type === "audiobook" ? "audiobooks" : "books";

  const [rules, setRules] = useState<ScanRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ScanRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [wizard, setWizard] = useState<WizardTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ rules: ScanRule[] }>(base);
      setRules(payload.rules);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:layout.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => { void load(); }, [load]);

  const defaultRule = rules.find((rule) => rule.isDefault) ?? null;
  const folderRules = useMemo(() => {
    const list = rules.filter((rule) => !rule.isDefault);
    // Sort by first folder so a nested rule follows the one it sits inside.
    return [...list].sort((a, b) => (a.paths[0] ?? "").localeCompare(b.paths[0] ?? "", undefined, { numeric: true }));
  }, [rules]);

  // The most specific other rule whose folder contains this rule's first folder.
  const parentOf = (rule: ScanRule): ScanRule | null => {
    const first = rule.paths[0] ?? "";
    let best: ScanRule | null = null;
    for (const other of folderRules) {
      if (other.id === rule.id) continue;
      for (const p of other.paths) {
        if (p && first.startsWith(`${p}/`) && (!best || p.length > (best.paths[0]?.length ?? 0))) best = other;
      }
    }
    return best;
  };

  const toggle = async (rule: ScanRule, enabled: boolean) => {
    setBusyId(rule.id);
    setError("");
    try {
      await api(`${base}/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: rule.name, layouts: rule.layouts, paths: rule.paths, preset: rule.preset, enabled })
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:layout.saveFailed"));
    } finally {
      setBusyId("");
    }
  };

  const scanRule = async (rule: ScanRule) => {
    setBusyId(rule.id);
    setError("");
    setNotice("");
    try {
      await api(`${base}/${rule.id}/scan`, { method: "POST", body: "{}" });
      setNotice(t("controlAdmin:layout.scanQueued", { name: rule.isDefault ? t("controlAdmin:layout.wholeLibrary") : rule.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:layout.scanFailed"));
    } finally {
      setBusyId("");
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`${base}/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:layout.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const layoutChip = (rule: ScanRule) => (
    <span className="layout-chip" title={rule.layouts.join("\n")}>
      {humanize(rule.layouts[0] ?? "", roleLabels)}
      {rule.layouts.length > 1 && <span className="layout-chip-more">{t("controlAdmin:layout.moreLayouts", { count: rule.layouts.length - 1 })}</span>}
    </span>
  );

  const scannedLine = (rule: ScanRule) =>
    rule.lastScannedAt ? t("controlAdmin:layout.scanned", { when: relativeTime(rule.lastScannedAt) }) : t("controlAdmin:layout.scannedNever");

  const countPill = (rule: ScanRule) => {
    const n = rule.books;
    const label = noun === "audiobooks" ? t("controlAdmin:layout.audiobooks", { count: n }) : t("controlAdmin:layout.books", { count: n });
    return <span className={`layout-pill ${n > 0 && rule.enabled ? "is-ok" : "is-quiet"}`}>{rule.enabled ? label : t("controlAdmin:layout.booksWhenOn", { count: n })}</span>;
  };

  const coveredByRules = folderRules.filter((rule) => rule.enabled).reduce((n, rule) => n + rule.books, 0);
  const activeCount = folderRules.filter((rule) => rule.enabled).length;

  return (
    <>
      <Modal
        title={t("controlAdmin:layout.panelTitle", { name: library.name })}
        subtitle={t("controlAdmin:layout.panelIntro")}
        variant="panel"
        icon={<Wand2 size={28} />}
        className="layout-panel"
        busy={deleting}
        onClose={onClose}
      >
        <div className="layout-panel-body">
          {error && <MessageBox tone="error" title={t("controlAdmin:layout.errorTitle")}>{error}</MessageBox>}
          {notice && <MessageBox tone="success" title={t("controlAdmin:layout.scanQueuedTitle")}>{notice}</MessageBox>}

          <section className="layout-section">
            <div className="layout-section-head">
              <span className="layout-label">{t("controlAdmin:layout.defaultHeading")}</span>
              <span className="layout-desc">{t("controlAdmin:layout.defaultDesc")}</span>
            </div>
            {defaultRule ? (
              <div className={`layout-row is-default ${defaultRule.enabled ? "" : "is-off"}`}>
                <div className="layout-row-icon"><Library size={20} /></div>
                <div className="layout-row-main">
                  <div className="layout-row-title">
                    <span className="layout-row-name">{t("controlAdmin:layout.wholeLibrary")}</span>
                    {layoutChip(defaultRule)}
                  </div>
                  <div className="layout-row-stats">
                    {countPill(defaultRule)}
                    {defaultRule.enabled && defaultRule.unmatched > 0 && (
                      <button type="button" className="layout-pill is-warn" onClick={() => setWizard({ kind: "preview", rule: defaultRule })}>
                        {t("controlAdmin:layout.unmatched", { count: defaultRule.unmatched })}
                      </button>
                    )}
                    <span>{scannedLine(defaultRule)}</span>
                  </div>
                  {defaultRule.enabled ? (
                    <div className="layout-row-note"><Info size={15} aria-hidden="true" /><span>{t("controlAdmin:layout.unmatchedNote")}</span></div>
                  ) : (
                    <div className="layout-row-note"><Info size={15} aria-hidden="true" /><span>{t("controlAdmin:layout.defaultOff")}</span></div>
                  )}
                </div>
                <div className="layout-row-side">
                  <ToggleSwitch checked={defaultRule.enabled} disabled={busyId === defaultRule.id} label={defaultRule.enabled ? t("controlAdmin:layout.on") : t("controlAdmin:layout.off")} onChange={(on) => toggle(defaultRule, on)} />
                  <div className="layout-row-actions">
                    <Button variant="secondary" compact onClick={() => setWizard({ kind: "default", rule: defaultRule })}><Pencil size={15} aria-hidden="true" /> {t("controlAdmin:layout.editLayout")}</Button>
                    <Button variant="icon" title={t("controlAdmin:layout.preview")} aria-label={t("controlAdmin:layout.previewAria", { name: t("controlAdmin:layout.wholeLibrary") })} disabled={!defaultRule.enabled} onClick={() => setWizard({ kind: "preview", rule: defaultRule })}><Eye size={15} /></Button>
                    <Button variant="icon" title={t("controlAdmin:layout.rescanLibrary")} aria-label={t("controlAdmin:layout.rescanLibrary")} onClick={onRescanLibrary}><RefreshCw size={15} /></Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="layout-row is-default">
                <div className="layout-row-icon"><Library size={20} /></div>
                <div className="layout-row-main">
                  <div className="layout-row-title">
                    <span className="layout-row-name">{t("controlAdmin:layout.wholeLibrary")}</span>
                    <span className="layout-pill is-quiet">{t("controlAdmin:layout.scannerDefaults")}</span>
                  </div>
                  <div className="layout-row-note">
                    <span>
                      {legacyGrouping === "single_file" ? t("controlAdmin:layout.legacySingleFile")
                        : legacyGrouping === "folder_structure" ? t("controlAdmin:layout.legacyFolderStructure")
                        : library.type === "audiobook" ? t("controlAdmin:layout.scannerDefaultsAudiobook") : t("controlAdmin:layout.scannerDefaultsEbook")}
                      {" "}{t("controlAdmin:layout.scannerDefaultsHint")}
                    </span>
                  </div>
                </div>
                <div className="layout-row-side">
                  <div className="layout-row-actions">
                    <Button variant="primary" compact onClick={() => setWizard({ kind: "default", rule: null })}><Plus size={15} aria-hidden="true" /> {t("controlAdmin:layout.setUpLayout")}</Button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="layout-section">
            <div className="layout-section-head">
              <span className="layout-label">{t("controlAdmin:layout.rulesHeading")}</span>
              {folderRules.length > 0 && <span className="layout-desc">{t("controlAdmin:layout.rulesActive", { on: activeCount, total: folderRules.length })}</span>}
              <span className="layout-spacer" />
              <Button variant="primary" compact onClick={() => setWizard({ kind: "rule", rule: null })}><Plus size={15} aria-hidden="true" /> {t("controlAdmin:layout.addRule")}</Button>
            </div>
            {loading && rules.length === 0 ? (
              <p className="muted">{t("controlAdmin:ui.loading")}</p>
            ) : folderRules.length === 0 ? (
              <div className="layout-empty">{t("controlAdmin:layout.rulesEmpty")}</div>
            ) : (
              <div className="layout-rows">
                {folderRules.map((rule) => {
                  const parent = parentOf(rule);
                  const missing = new Set(rule.missingFolders);
                  const foldersText = rule.paths.map((p) => p || t("controlAdmin:layout.wholeLibrary")).join(", ");
                  return (
                    <div key={rule.id} className={`layout-row ${rule.enabled ? "" : "is-off"} ${parent ? "is-nested" : ""}`}>
                      <div className="layout-row-icon">{parent ? <CornerDownRight size={18} /> : <Folder size={20} />}</div>
                      <div className="layout-row-main">
                        <div className="layout-row-title">
                          <span className="layout-row-name">{rule.name}</span>
                          {layoutChip(rule)}
                        </div>
                        <div className="layout-row-folders">
                          {rule.paths.map((p) => (
                            <span key={p} className={`layout-folder ${missing.has(p) ? "is-missing" : ""}`}><Folder size={12} aria-hidden="true" /> {p || t("controlAdmin:layout.wholeLibrary")}</span>
                          ))}
                        </div>
                        <div className="layout-row-stats">
                          {countPill(rule)}
                          {rule.enabled && rule.unmatched > 0 && (
                            <button type="button" className="layout-pill is-warn" onClick={() => setWizard({ kind: "preview", rule })}>
                              {t("controlAdmin:layout.unmatched", { count: rule.unmatched })}
                            </button>
                          )}
                          {missing.size > 0 && <span className="layout-pill is-err"><Lock size={11} aria-hidden="true" /> {t("controlAdmin:layout.folderNotFound")}</span>}
                          <span>{scannedLine(rule)}</span>
                        </div>
                        {!rule.enabled && (
                          <div className="layout-row-note"><Info size={15} aria-hidden="true" /><span>{t("controlAdmin:layout.ruleOff", { folders: foldersText })}</span></div>
                        )}
                        {missing.size > 0 && (
                          <div className="layout-row-note is-warn"><AlertTriangle size={15} aria-hidden="true" /><span>{t("controlAdmin:layout.ruleMissing", { folders: [...missing].join(", ") })}</span></div>
                        )}
                        {parent && rule.enabled && (
                          <div className="layout-row-note"><Info size={15} aria-hidden="true" /><span>{t("controlAdmin:layout.ruleNested", { parent: parent.name })}</span></div>
                        )}
                      </div>
                      <div className="layout-row-side">
                        <ToggleSwitch checked={rule.enabled} disabled={busyId === rule.id} label={rule.enabled ? t("controlAdmin:layout.on") : t("controlAdmin:layout.off")} onChange={(on) => toggle(rule, on)} />
                        <div className="layout-row-actions">
                          <Button variant="icon" title={t("controlAdmin:layout.preview")} aria-label={t("controlAdmin:layout.previewAria", { name: rule.name })} disabled={!rule.enabled} onClick={() => setWizard({ kind: "preview", rule })}><Eye size={15} /></Button>
                          <Button variant="icon" title={t("controlAdmin:layout.scanFolders")} aria-label={t("controlAdmin:layout.scanFoldersAria", { name: rule.name })} disabled={!rule.enabled || missing.size > 0 || busyId === rule.id} onClick={() => scanRule(rule)}><RefreshCw size={15} /></Button>
                          <Button variant="icon" title={t("controlAdmin:layout.editRule")} aria-label={t("controlAdmin:layout.editAria", { name: rule.name })} onClick={() => setWizard({ kind: "rule", rule })}><Pencil size={15} /></Button>
                          <Button variant="icon" danger title={t("controlAdmin:layout.deleteRule")} aria-label={t("controlAdmin:layout.deleteAria", { name: rule.name })} onClick={() => setDeleteTarget(rule)}><Trash2 size={15} /></Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="layout-sources">
            <span className="layout-label">{t("controlAdmin:layout.sourcesLabel")}</span>
            {sources.map((source) => (
              <span key={source.label} className={`layout-source ${source.enabled ? "" : "is-off"}`}><span className="layout-source-dot" aria-hidden="true" />{source.label}</span>
            ))}
            <span className="layout-spacer" />
            <Button variant="text" onClick={onOpenSettings}>{t("controlAdmin:layout.librarySettings")}</Button>
          </div>
        </div>

        <div className="layout-panel-foot">
          <span className="muted">
            {folderRules.length > 0
              ? t("controlAdmin:layout.footerSummary", { on: activeCount, covered: coveredByRules })
              : ""}
          </span>
          <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
        </div>
      </Modal>

      {deleteTarget && (
        <ConfirmDialog
          title={t("controlAdmin:layout.deleteTitle", { name: deleteTarget.name })}
          confirmLabel={t("controlAdmin:layout.deleteRule")}
          busyLabel={t("controlAdmin:layout.deleting")}
          danger
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setDeleteTarget(null)}
        >
          {t("controlAdmin:layout.deleteBody", { count: deleteTarget.books, folders: deleteTarget.paths.join(", ") })}
        </ConfirmDialog>
      )}

      {wizard && (
        <ScanRuleWizard
          library={library}
          target={wizard}
          existingRules={rules}
          onClose={() => setWizard(null)}
          onSaved={async () => { setWizard(null); await load(); }}
          onSavedAndScanned={async (name) => { setWizard(null); setNotice(t("controlAdmin:layout.scanQueued", { name })); await load(); }}
        />
      )}
    </>
  );
}
