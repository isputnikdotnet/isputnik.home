import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Wand2, Plus, Pencil, Trash2, Eye, Folder, FolderSearch, ArrowUp, X } from "lucide-react";
import { api } from "../../../api";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";

interface ScanRule {
  id: string;
  libraryId: string;
  name: string;
  enabled: boolean;
  preset: string | null;
  pattern: string;
  paths: string[];
}

interface PreviewRow {
  path: string;
  matched: boolean;
  author?: string;
  series?: string;
  position?: number;
  title?: string;
}

interface BrowseFolder { name: string; relativePath: string }
interface FoldersResponse { path: string; parent: string | null; folders: BrowseFolder[] }

interface RuleForm { id: string; name: string; folders: string[]; pattern: string }
type FormTab = "folders" | "rule";

const PRESET_DEFS: { labelKey: "presetSeriesBook" | "presetAuthorSeriesBook" | "presetAuthorBook"; pattern: string }[] = [
  { labelKey: "presetSeriesBook", pattern: "{series}/{position}. {title}" },
  { labelKey: "presetAuthorSeriesBook", pattern: "{author}/{series}/{position}. {title}" },
  { labelKey: "presetAuthorBook", pattern: "{author}/{title}" }
];

export function ScanRulesModal({
  library,
  onClose
}: {
  library: { id: string; name: string; type: "audiobook" | "ebook" };
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const PRESETS = PRESET_DEFS.map((preset) => ({ label: t(`controlAdmin:scanRules.${preset.labelKey}`), pattern: preset.pattern }));
  const [rules, setRules] = useState<ScanRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState<RuleForm | null>(null);
  const [activeTab, setActiveTab] = useState<FormTab>("folders");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScanRule | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseFolders, setBrowseFolders] = useState<BrowseFolder[]>([]);

  const base = `/api/library/libraries/${library.id}/scan-rules`;
  const foldersBase = `/api/library/libraries/${library.id}/folders`;

  const patternRef = useRef<HTMLInputElement>(null);
  const tokens: { token: string; desc: string }[] = [
    { token: "{author}", desc: t("controlAdmin:scanRules.tokenAuthor") },
    { token: "{series}", desc: t("controlAdmin:scanRules.tokenSeries") },
    { token: "{position}", desc: t("controlAdmin:scanRules.tokenPosition") },
    { token: "{title}", desc: t("controlAdmin:scanRules.tokenTitle") },
    ...(library.type === "audiobook" ? [{ token: "{narrator}", desc: t("controlAdmin:scanRules.tokenNarrator") }] : []),
    { token: "{ignore}", desc: t("controlAdmin:scanRules.tokenIgnore") }
  ];
  const insertToken = (token: string) => {
    setForm((current) => {
      if (!current) return current;
      const input = patternRef.current;
      const start = input?.selectionStart ?? current.pattern.length;
      const end = input?.selectionEnd ?? current.pattern.length;
      const pattern = current.pattern.slice(0, start) + token + current.pattern.slice(end);
      requestAnimationFrame(() => {
        if (input) { input.focus(); const caret = start + token.length; input.setSelectionRange(caret, caret); }
      });
      return { ...current, pattern };
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ rules: ScanRule[] }>(base);
      setRules(payload.rules);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const browse = useCallback(async (path: string) => {
    try {
      const payload = await api<FoldersResponse>(`${foldersBase}?path=${encodeURIComponent(path)}`);
      setBrowsePath(payload.path);
      setBrowseParent(payload.parent);
      setBrowseFolders(payload.folders);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.browseFailed"));
    }
  }, [foldersBase, t]);

  const openForm = (rule?: ScanRule) => {
    setForm(rule
      ? { id: rule.id, name: rule.name, folders: [...rule.paths], pattern: rule.pattern }
      : { id: "", name: "", folders: [], pattern: "" });
    setActiveTab("folders");
    setPreview(null);
    setError("");
  };

  // Open the browser rooted at the library source so the user can drill into any
  // subfolder and pick it. Reset to root each time, matching "browse from the top".
  const openPicker = () => { setError(""); setPickerOpen(true); void browse(""); };

  const addFolder = (relativePath: string) =>
    setForm((current) => (current && !current.folders.includes(relativePath) ? { ...current, folders: [...current.folders, relativePath] } : current));
  const removeFolder = (relativePath: string) =>
    setForm((current) => (current ? { ...current, folders: current.folders.filter((path) => path !== relativePath) } : current));

  const previewReady = Boolean(form && form.pattern.trim() && form.folders.length > 0);
  const formReady = Boolean(form && form.name.trim() && form.pattern.trim() && form.folders.length > 0);

  const runPreview = async () => {
    if (!form) return;
    setPreviewing(true);
    setError("");
    try {
      const payload = await api<{ rows: PreviewRow[] }>(`${base}/preview`, {
        method: "POST", body: JSON.stringify({ pattern: form.pattern, paths: form.folders })
      });
      setPreview(payload.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.previewFailed"));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      const body = JSON.stringify({ name: form.name, pattern: form.pattern, paths: form.folders });
      if (form.id) await api(`${base}/${form.id}`, { method: "PATCH", body });
      else await api(base, { method: "POST", body });
      setForm(null);
      setPreview(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: ScanRule) => {
    setError("");
    try {
      await api(`${base}/${rule.id}`, {
        method: "PATCH", body: JSON.stringify({ name: rule.name, pattern: rule.pattern, paths: rule.paths, enabled: !rule.enabled })
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.updateFailed"));
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await api(`${base}/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scanRules.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal title={t("controlAdmin:scanRules.modalTitle", { name: library.name })} variant="panel" icon={<Wand2 size={28} />} className="scan-rules-modal" busy={saving} onClose={onClose}>
        <div className="scan-rules-body">
          {error && <MessageBox tone="error" title={t("controlAdmin:scanRules.errorTitle")}>{error}</MessageBox>}

          {!form ? (
            <div className="modal-tab-content scan-rules-list">
              <p className="muted" style={{ margin: 0 }}>
                {t("controlAdmin:scanRules.intro")}
              </p>
              {library.type !== "ebook" && (
                <MessageBox tone="info" title={t("controlAdmin:scanRules.ebookOnlyTitle")}>{t("controlAdmin:scanRules.ebookOnlyBody")}</MessageBox>
              )}
              <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 0 }}>
                <Button variant="primary" onClick={() => openForm()}><Plus size={16} aria-hidden="true" /> {t("controlAdmin:scanRules.addRule")}</Button>
              </div>
              {loading ? (
                <p className="muted">{t("controlAdmin:ui.loading")}</p>
              ) : rules.length === 0 ? (
                <p className="muted">{t("controlAdmin:scanRules.emptyList")}</p>
              ) : (
                <ul className="scan-rules-rule-list">
                  {rules.map((rule) => (
                    <li key={rule.id} className="scan-rules-rule-item">
                      <div className="scan-rules-rule-meta">
                        <strong>{rule.name}</strong>
                        <code>{rule.pattern}</code>
                        <small className="muted">{rule.paths.map((path) => path || t("controlAdmin:scanRules.libraryRoot")).join(" · ")}</small>
                      </div>
                      <label className="field-checkbox" style={{ flex: "0 0 auto" }}>
                        <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} />
                        <span>{t("controlAdmin:scanRules.enabled")}</span>
                      </label>
                      <div className="row-actions">
                        <Button variant="icon" title={t("controlAdmin:scanRules.editRule")} aria-label={t("controlAdmin:scanRules.editAria", { name: rule.name })} onClick={() => openForm(rule)}><Pencil size={15} /></Button>
                        <Button variant="icon" danger title={t("controlAdmin:scanRules.deleteRule")} aria-label={t("controlAdmin:scanRules.deleteAria", { name: rule.name })} onClick={() => setDeleteTarget(rule)}><Trash2 size={15} /></Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="modal-tabs scan-rules-tabs">
                <button className={`modal-tab${activeTab === "folders" ? " active" : ""}`} onClick={() => setActiveTab("folders")}>
                  {form.folders.length > 0 ? t("controlAdmin:scanRules.tabFoldersCount", { count: form.folders.length }) : t("controlAdmin:scanRules.tabFolders")}
                </button>
                <button className={`modal-tab${activeTab === "rule" ? " active" : ""}`} onClick={() => setActiveTab("rule")}>
                  {t("controlAdmin:scanRules.tabRule")}
                </button>
              </div>

              <div className="modal-tab-content scan-rules-content">
                {activeTab === "folders" ? (
                  <>
                    <Field label={t("controlAdmin:scanRules.nameLabel")} value={form.name} onChange={(value) => setForm({ ...form, name: value })} placeholder={t("controlAdmin:scanRules.namePlaceholder")} />

                    <div className="field">
                      <div className="scan-rules-folders-head">
                        <span>{t("controlAdmin:scanRules.foldersLabel")}</span>
                        <Button variant="secondary" compact onClick={openPicker}>
                          <FolderSearch size={15} aria-hidden="true" /> {t("controlAdmin:scanRules.browseFolders")}
                        </Button>
                      </div>
                      {form.folders.length === 0 ? (
                        <button type="button" className="scan-rules-folder-empty" onClick={openPicker}>
                          <Folder size={20} aria-hidden="true" />
                          <span>{t("controlAdmin:scanRules.noFoldersChosen")}</span>
                        </button>
                      ) : (
                        <div className="scan-rules-folder-grid">
                          {form.folders.map((path) => {
                            const segments = path.split("/");
                            const name = path === "" ? t("controlAdmin:scanRules.libraryRoot") : segments[segments.length - 1];
                            const parent = path === "" ? "" : segments.slice(0, -1).join("/");
                            return (
                              <div key={path} className="scan-rules-folder-card">
                                <Folder size={16} aria-hidden="true" />
                                <div className="scan-rules-folder-label">
                                  <strong title={path}>{name}</strong>
                                  {parent && <small className="muted">{parent}</small>}
                                </div>
                                <Button variant="icon" danger compact title={t("controlAdmin:scanRules.removeFolder")} aria-label={t("controlAdmin:scanRules.removeFolderAria", { path })} onClick={() => removeFolder(path)}>
                                  <X size={14} />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>{t("controlAdmin:scanRules.layoutPreset")}</span>
                      <select value="" onChange={(event) => { const preset = PRESETS.find((option) => option.label === event.target.value); if (preset) setForm({ ...form, pattern: preset.pattern }); }}>
                        <option value="">{t("controlAdmin:scanRules.choosePreset")}</option>
                        {PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label} — {preset.pattern}</option>)}
                      </select>
                    </label>

                    <label className="field">
                      <span>{t("controlAdmin:scanRules.patternLabel")}</span>
                      <input ref={patternRef} type="text" value={form.pattern} onChange={(event) => setForm({ ...form, pattern: event.target.value })} placeholder="{series}/{position}. {title}" style={{ fontFamily: "monospace" }} />
                      <div className="scan-rules-token-palette">
                        <small className="muted">{t("controlAdmin:scanRules.insert")}</small>
                        {tokens.map((tok) => (
                          <Button key={tok.token} variant="secondary" compact title={tok.desc} onClick={() => insertToken(tok.token)} style={{ fontFamily: "monospace" }}>{tok.token}</Button>
                        ))}
                      </div>
                      <small className="muted" style={{ marginTop: 6 }}>
                        {t("controlAdmin:scanRules.patternHelp")}
                      </small>
                    </label>

                    <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 0 }}>
                      <Button variant="secondary" onClick={runPreview} disabled={previewing || !previewReady}>
                        <Eye size={16} aria-hidden="true" /> {previewing ? t("controlAdmin:scanRules.previewing") : t("controlAdmin:scanRules.preview")}
                      </Button>
                      {!previewReady && <small className="muted">{t("controlAdmin:scanRules.previewHint")}</small>}
                    </div>
                    {preview && (preview.length === 0 ? (
                      <p className="muted">{t("controlAdmin:scanRules.noMatches")}</p>
                    ) : (
                      <div className="scan-rules-preview">
                        <table>
                          <thead>
                            <tr>
                              <th style={{ width: "30%" }}>{t("controlAdmin:scanRules.thFromFile")}</th>
                              <th style={{ width: "20%" }}>{t("controlAdmin:scanRules.thAuthor")}</th>
                              <th style={{ width: "22%" }}>{t("controlAdmin:scanRules.thSeries")}</th>
                              <th style={{ width: "8%", textAlign: "center" }}>#</th>
                              <th style={{ width: "20%" }}>{t("controlAdmin:scanRules.thTitle")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.map((row) => (
                              <tr key={row.path} style={{ opacity: row.matched ? 1 : 0.55 }}>
                                <td className="muted">{row.path}</td>
                                <td>{row.author ?? "—"}</td>
                                <td>{row.series ?? "—"}</td>
                                <td style={{ textAlign: "center" }}>{row.position ?? "—"}</td>
                                <td>{row.title ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="scan-rules-footer">
                {!formReady && <small className="muted">{t("controlAdmin:scanRules.footerHint")}</small>}
                <div className="modal-actions" style={{ marginTop: 0 }}>
                  <Button variant="secondary" onClick={() => { setForm(null); setPreview(null); }} disabled={saving}>{t("common.cancel")}</Button>
                  <Button variant="primary" onClick={save} disabled={saving || !formReady}>{saving ? t("controlAdmin:ui.saving") : t("controlAdmin:scanRules.saveRule")}</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      {pickerOpen && form && (
        <Modal title={t("controlAdmin:scanRules.pickerTitle")} variant="card" icon={<FolderSearch size={22} />} className="folder-picker-modal scan-rules-picker" onClose={() => setPickerOpen(false)}>
          <p><Trans i18nKey="scanRules.pickerIntro" ns="controlAdmin" values={{ name: library.name }} components={{ bold: <strong /> }} /></p>

          <div className="folder-picker-browser">
            <div className="folder-picker-head">
              <div>
                <strong>{t("controlAdmin:scanRules.currentFolder")}</strong>
                <span>{browsePath ? `/${browsePath}` : t("controlAdmin:scanRules.libraryRoot")}</span>
              </div>
              <div className="row-actions">
                <Button variant="secondary" compact disabled={form.folders.includes(browsePath)} onClick={() => addFolder(browsePath)}>
                  {form.folders.includes(browsePath)
                    ? t("controlAdmin:scanRules.added")
                    : <><Plus size={14} aria-hidden="true" /> {browsePath ? t("controlAdmin:scanRules.addThisFolder") : t("controlAdmin:scanRules.addLibraryRoot")}</>}
                </Button>
                <Button variant="icon" title={t("controlAdmin:scanRules.upOneLevel")} aria-label={t("controlAdmin:scanRules.upOneLevel")} disabled={browseParent === null} onClick={() => browse(browseParent ?? "")}>
                  <ArrowUp size={16} />
                </Button>
              </div>
            </div>

            <div className="folder-picker-list">
              {browseFolders.length === 0 ? (
                <small className="muted" style={{ padding: "6px 4px" }}>{t("controlAdmin:scanRules.noSubfolders")}</small>
              ) : browseFolders.map((entry) => {
                const added = form.folders.includes(entry.relativePath);
                return (
                  <div key={entry.relativePath} className="scan-rules-pick-row">
                    <button type="button" className="folder-picker-row text-button" onClick={() => browse(entry.relativePath)} title={t("controlAdmin:scanRules.openFolder")}>
                      <Folder size={18} aria-hidden="true" />
                      <span>{entry.name}</span>
                    </button>
                    <Button variant="secondary" compact disabled={added} onClick={() => addFolder(entry.relativePath)}>
                      {added ? t("controlAdmin:scanRules.added") : <><Plus size={14} aria-hidden="true" /> {t("controlAdmin:scanRules.add")}</>}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="modal-actions" style={{ alignItems: "center" }}>
            <small className="muted" style={{ marginRight: "auto" }}>
              {form.folders.length === 0 ? t("controlAdmin:scanRules.noFoldersSelected") : t("controlAdmin:scanRules.foldersSelected", { count: form.folders.length })}
            </small>
            <Button variant="primary" onClick={() => setPickerOpen(false)}>{t("common.done")}</Button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t("controlAdmin:scanRules.deleteDialogTitle", { name: deleteTarget.name })}
          confirmLabel={t("controlAdmin:scanRules.deleteRule")}
          busyLabel={t("controlAdmin:scanRules.deleting")}
          busy={saving}
          danger
          onConfirm={() => void remove()}
          onCancel={() => { if (!saving) setDeleteTarget(null); }}
        >
          {t("controlAdmin:scanRules.deleteBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
