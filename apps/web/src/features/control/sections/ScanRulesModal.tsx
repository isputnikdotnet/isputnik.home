import { useCallback, useEffect, useRef, useState } from "react";
import { Wand2, Plus, Pencil, Trash2, Eye, Folder, ArrowUp, X } from "lucide-react";
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

const PRESETS: { label: string; pattern: string }[] = [
  { label: "Series / Book", pattern: "{series}/{position}. {title}" },
  { label: "Author / Series / Book", pattern: "{author}/{series}/{position}. {title}" },
  { label: "Author / Book", pattern: "{author}/{title}" }
];

export function ScanRulesModal({
  library,
  onClose
}: {
  library: { id: string; name: string; type: "audiobook" | "ebook" };
  onClose: () => void;
}) {
  const [rules, setRules] = useState<ScanRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState<RuleForm | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScanRule | null>(null);

  const [browsePath, setBrowsePath] = useState("");
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseFolders, setBrowseFolders] = useState<BrowseFolder[]>([]);

  const base = `/api/library/libraries/${library.id}/scan-rules`;
  const foldersBase = `/api/library/libraries/${library.id}/folders`;

  const patternRef = useRef<HTMLInputElement>(null);
  const tokens: { token: string; desc: string }[] = [
    { token: "{author}", desc: "Author name" },
    { token: "{series}", desc: "Series name" },
    { token: "{position}", desc: "Number in the series" },
    { token: "{title}", desc: "Book title" },
    ...(library.type === "audiobook" ? [{ token: "{narrator}", desc: "Narrator name (audiobook)" }] : []),
    { token: "{ignore}", desc: "Skip this folder level" }
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
      setError(err instanceof Error ? err.message : "Unable to load scan rules");
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
      setError(err instanceof Error ? err.message : "Unable to browse folders");
    }
  }, [foldersBase]);

  const openForm = (rule?: ScanRule) => {
    setForm(rule
      ? { id: rule.id, name: rule.name, folders: [...rule.paths], pattern: rule.pattern }
      : { id: "", name: "", folders: [], pattern: "" });
    setPreview(null);
    setError("");
    void browse("");
  };

  const addFolder = (relativePath: string) =>
    setForm((current) => (current && !current.folders.includes(relativePath) ? { ...current, folders: [...current.folders, relativePath] } : current));
  const removeFolder = (relativePath: string) =>
    setForm((current) => (current ? { ...current, folders: current.folders.filter((path) => path !== relativePath) } : current));

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
      setError(err instanceof Error ? err.message : "Preview failed");
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
      setError(err instanceof Error ? err.message : "Unable to save rule");
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
      setError(err instanceof Error ? err.message : "Unable to update rule");
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
      setError(err instanceof Error ? err.message : "Unable to delete rule");
    } finally {
      setSaving(false);
    }
  };

  const chip = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px 2px 10px", border: "1px solid var(--line)", borderRadius: 999, fontSize: "0.82rem" } as const;

  return (
    <>
      <Modal title={`Scan rules — ${library.name}`} variant="panel" icon={<Wand2 size={28} />} className="scan-rules-modal" busy={saving} onClose={onClose}>
        <div style={{ display: "grid", gap: 14, padding: "4px 2px" }}>
          <p className="muted" style={{ margin: 0 }}>
            Custom rules scan specific folders with their own layout, overriding the default scan there. Changes take effect on the next rescan.
          </p>
          {library.type !== "ebook" && (
            <MessageBox tone="info" title="Ebook libraries only">Scan rules currently apply when scanning ebook libraries.</MessageBox>
          )}
          {error && <MessageBox tone="error" title="Scan rules">{error}</MessageBox>}

          {!form && (
            <>
              <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 0 }}>
                <Button variant="primary" onClick={() => openForm()}><Plus size={16} aria-hidden="true" /> Add rule</Button>
              </div>
              {loading ? (
                <p className="muted">Loading…</p>
              ) : rules.length === 0 ? (
                <p className="muted">No scan rules yet. Add one to organize an unusual folder.</p>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                  {rules.map((rule) => (
                    <li key={rule.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8 }}>
                      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                        <strong>{rule.name}</strong>
                        <code style={{ fontSize: "0.85rem", color: "var(--muted)", wordBreak: "break-all" }}>{rule.pattern}</code>
                        <small className="muted" style={{ wordBreak: "break-word" }}>{rule.paths.join(" · ")}</small>
                      </div>
                      <label className="field-checkbox" style={{ flex: "0 0 auto" }}>
                        <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} />
                        <span>Enabled</span>
                      </label>
                      <div className="row-actions">
                        <Button variant="icon" title="Edit rule" aria-label={`Edit ${rule.name}`} onClick={() => openForm(rule)}><Pencil size={15} /></Button>
                        <Button variant="icon" danger title="Delete rule" aria-label={`Delete ${rule.name}`} onClick={() => setDeleteTarget(rule)}><Trash2 size={15} /></Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {form && (
            <section style={{ display: "grid", gap: 12 }}>
              <h3 style={{ margin: 0 }}>{form.id ? "Edit rule" : "New rule"}</h3>
              <Field label="Name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} placeholder="e.g. Круз Андрей" />

              <div className="field">
                <span>Folders</span>
                {form.folders.length === 0 ? (
                  <small className="muted">No folders selected — browse below and choose one or more.</small>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {form.folders.map((path) => (
                      <span key={path} style={chip}>
                        {path}
                        <button type="button" aria-label={`Remove ${path}`} title="Remove" onClick={() => removeFolder(path)} style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--muted)", lineHeight: 1, padding: 2 }}>
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 8, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--line)", background: "var(--field)" }}>
                    <Button variant="icon" title="Up one level" aria-label="Up one level" disabled={browseParent === null} onClick={() => browse(browseParent ?? "")}>
                      <ArrowUp size={15} />
                    </Button>
                    <code className="muted" style={{ wordBreak: "break-all" }}>/{browsePath}</code>
                  </div>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 180, overflowY: "auto" }}>
                    {browseFolders.length === 0 ? (
                      <li style={{ padding: "8px 10px" }}><small className="muted">No subfolders here.</small></li>
                    ) : browseFolders.map((entry) => (
                      <li key={entry.relativePath} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", borderTop: "1px solid var(--line)" }}>
                        <button type="button" onClick={() => browse(entry.relativePath)} title="Open folder" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, border: 0, background: "transparent", cursor: "pointer", textAlign: "left", color: "var(--ink)" }}>
                          <Folder size={15} aria-hidden="true" /> <span style={{ wordBreak: "break-word" }}>{entry.name}</span>
                        </button>
                        <Button variant="secondary" compact disabled={form.folders.includes(entry.relativePath)} onClick={() => addFolder(entry.relativePath)}>
                          {form.folders.includes(entry.relativePath) ? "Added" : "Add"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <label className="field">
                <span>Layout preset</span>
                <select value="" onChange={(event) => { const preset = PRESETS.find((option) => option.label === event.target.value); if (preset) setForm({ ...form, pattern: preset.pattern }); }}>
                  <option value="">Choose a preset…</option>
                  {PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label} — {preset.pattern}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Pattern</span>
                <input ref={patternRef} type="text" value={form.pattern} onChange={(event) => setForm({ ...form, pattern: event.target.value })} placeholder="{series}/{position}. {title}" style={{ fontFamily: "monospace" }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
                  <small className="muted">Insert:</small>
                  {tokens.map((tok) => (
                    <Button key={tok.token} variant="secondary" compact title={tok.desc} onClick={() => insertToken(tok.token)} style={{ fontFamily: "monospace" }}>{tok.token}</Button>
                  ))}
                </div>
                <small className="muted" style={{ marginTop: 6 }}>
                  Folders are separated by “/”; text between tokens is matched literally. Use {"{ignore}"} for a folder level you don't want to map.
                </small>
              </label>

              <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: 0 }}>
                <Button variant="secondary" onClick={runPreview} disabled={previewing || !formReady}>
                  <Eye size={16} aria-hidden="true" /> {previewing ? "Previewing…" : "Preview"}
                </Button>
              </div>
              {preview && (preview.length === 0 ? (
                <p className="muted">No files matched in those folders.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", width: "36%", padding: "0 8px 6px 0", color: "var(--muted)", fontWeight: 600 }}>From file</th>
                      <th style={{ textAlign: "left", width: "26%", padding: "0 8px 6px", color: "var(--muted)", fontWeight: 600 }}>Series</th>
                      <th style={{ textAlign: "center", width: "8%", padding: "0 8px 6px", color: "var(--muted)", fontWeight: 600 }}>#</th>
                      <th style={{ textAlign: "left", width: "30%", padding: "0 0 6px 8px", color: "var(--muted)", fontWeight: 600 }}>Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr key={row.path} style={{ borderTop: "1px solid var(--line)", opacity: row.matched ? 1 : 0.55 }}>
                        <td style={{ padding: "6px 8px 6px 0", color: "var(--muted)", wordBreak: "break-word" }}>{row.path}</td>
                        <td style={{ padding: "6px 8px", wordBreak: "break-word" }}>{row.series ?? "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center" }}>{row.position ?? "—"}</td>
                        <td style={{ padding: "6px 0 6px 8px", wordBreak: "break-word" }}>{row.title ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}

              <div className="modal-actions">
                <Button variant="secondary" onClick={() => { setForm(null); setPreview(null); }} disabled={saving}>Cancel</Button>
                <Button variant="primary" onClick={save} disabled={saving || !formReady}>{saving ? "Saving…" : "Save rule"}</Button>
              </div>
            </section>
          )}
        </div>
      </Modal>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          confirmLabel="Delete rule"
          busyLabel="Deleting…"
          busy={saving}
          danger
          onConfirm={() => void remove()}
          onCancel={() => { if (!saving) setDeleteTarget(null); }}
        >
          The rule's folders return to the default scanner on the next rescan. No catalog data is removed now.
        </ConfirmDialog>
      )}
    </>
  );
}
