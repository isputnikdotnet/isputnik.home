import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2, ArrowRight, Check } from "lucide-react";
import { api } from "../../../api";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { FoldersStep } from "./FoldersStep";
import { LayoutStep } from "./LayoutStep";
import { PreviewStep } from "./PreviewStep";
import { humanize, patternOf, problemsOf, textDraft, type LayoutDraft } from "./layout-model";
import { rulesBase, type LayoutLibrary, type PreviewRow, type ScanRule } from "./types";
import { useRoleLabels } from "./useRoleLabels";

// What the wizard is editing: a folder rule (new or existing), the library's
// default layout (folders fixed to the root, so the Folders step is skipped), or
// an existing rule opened straight at its preview.
export type WizardTarget =
  | { kind: "rule"; rule: ScanRule | null }
  | { kind: "default"; rule: ScanRule | null }
  | { kind: "preview"; rule: ScanRule };

type Step = "folders" | "layout" | "preview";

export function ScanRuleWizard({
  library,
  target,
  existingRules,
  onClose,
  onSaved,
  onSavedAndScanned
}: {
  library: LayoutLibrary;
  target: WizardTarget;
  existingRules: ScanRule[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onSavedAndScanned: (name: string) => void | Promise<void>;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const roleLabels = useRoleLabels();
  const base = rulesBase(library.id);
  const isDefault = target.kind === "default" || (target.kind === "preview" && target.rule.isDefault);
  const editing = target.rule;
  const steps: Step[] = isDefault ? ["layout", "preview"] : ["folders", "layout", "preview"];

  const [step, setStep] = useState<Step>(target.kind === "preview" ? "preview" : steps[0]);
  const [folders, setFolders] = useState<string[]>(isDefault ? [""] : (editing?.paths ?? []));
  const [name, setName] = useState(editing?.name ?? "");
  const [nameEdited, setNameEdited] = useState(Boolean(editing));
  // Existing layouts start in text mode: the example they were built from is gone,
  // and the pattern text is the truth. The user can pick an example to rebuild.
  const [drafts, setDrafts] = useState<LayoutDraft[]>(() => (editing?.layouts ?? []).map((layout) => textDraft(layout)));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);

  const layouts = useMemo(() => drafts.map(patternOf).filter((p) => p.length > 0), [drafts]);
  const draftErrors = useMemo(
    () => drafts.flatMap((draft) => problemsOf(draft, library.type).filter((p) => p.kind === "error")),
    [drafts, library.type]
  );

  // Auto-name a new rule after its first folder and layout until the user types one.
  useEffect(() => {
    if (nameEdited) return;
    const folder = folders[0] === "" ? t("controlAdmin:layout.wholeLibrary") : (folders[0] ?? "").split("/").pop() ?? "";
    const layout = layouts[0] ? humanize(layouts[0], roleLabels) : "";
    setName(folder && layout ? `${folder} · ${layout}` : folder || layout);
  }, [folders, layouts, nameEdited, roleLabels, t]);

  const folderLabel = folders.length === 0 ? library.name
    : folders.includes("") ? t("controlAdmin:layout.wholeLibrary")
    : folders.length === 1 ? folders[0] : t("controlAdmin:layout.selectionCount", { count: folders.length });

  const canLeaveFolders = folders.length > 0;
  const canLeaveLayout = layouts.length > 0 && draftErrors.length === 0 && (isDefault || name.trim().length > 0);

  const stepIndex = steps.indexOf(step);
  const goNext = () => { const next = steps[stepIndex + 1]; if (next) { setError(""); setStep(next); } };
  const goBack = () => { const prev = steps[stepIndex - 1]; if (prev) { setError(""); setStep(prev); } };

  const save = async (thenScan: boolean) => {
    setSaving(true);
    setError("");
    try {
      let saved: ScanRule;
      if (isDefault) {
        const payload = await api<{ rule: ScanRule }>(`/api/library/libraries/${library.id}/default-layout`, {
          method: "PUT", body: JSON.stringify({ layouts, enabled: editing?.enabled ?? true })
        });
        saved = payload.rule;
      } else {
        const body = JSON.stringify({ name: name.trim(), layouts, paths: folders, enabled: editing?.enabled ?? true });
        const payload = editing
          ? await api<{ rule: ScanRule }>(`${base}/${editing.id}`, { method: "PATCH", body })
          : await api<{ rule: ScanRule }>(base, { method: "POST", body });
        saved = payload.rule;
      }
      if (thenScan) {
        await api(`${base}/${saved.id}/scan`, { method: "POST", body: "{}" });
        await onSavedAndScanned(isDefault ? t("controlAdmin:layout.wholeLibrary") : saved.name);
      } else {
        await onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:layout.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const title = target.kind === "preview" && !isDefault
    ? t("controlAdmin:layout.wizardTitleEdit")
    : isDefault ? t("controlAdmin:layout.wizardTitleDefault")
    : editing ? t("controlAdmin:layout.wizardTitleEdit") : t("controlAdmin:layout.wizardTitleAdd");
  const subtitle = step === "folders"
    ? t("controlAdmin:layout.subFolders", { name: library.name })
    : step === "layout" ? t("controlAdmin:layout.subLayout", { folder: folderLabel })
    : t("controlAdmin:layout.subPreview", { folder: folderLabel });
  const stepLabel = (s: Step) => s === "folders" ? t("controlAdmin:layout.stepFolders") : s === "layout" ? t("controlAdmin:layout.stepLayout") : t("controlAdmin:layout.stepPreview");

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      variant="panel"
      icon={<Wand2 size={28} />}
      className="layout-wizard"
      busy={saving}
      onClose={onClose}
    >
      <div className="layout-wizard-body">
        <ol className="layout-stepper" aria-label={t("controlAdmin:layout.stepsAria")}>
          {steps.map((s, i) => {
            const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "todo";
            return (
              <li key={s} className={`layout-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="layout-step-dot">{state === "done" ? <Check size={14} aria-hidden="true" /> : i + 1}</span>
                <span>{stepLabel(s)}</span>
              </li>
            );
          })}
        </ol>

        {error && <MessageBox tone="error" title={t("controlAdmin:layout.errorTitle")}>{error}</MessageBox>}

        <div className="layout-wizard-content">
          {step === "folders" && (
            <FoldersStep
              library={library}
              selected={folders}
              editingRuleId={editing?.id ?? null}
              onChange={setFolders}
            />
          )}
          {step === "layout" && (
            <LayoutStep
              library={library}
              folders={folders}
              ruleId={editing?.id ?? null}
              isDefault={isDefault}
              name={name}
              nameEdited={nameEdited}
              onName={(value) => { setName(value); setNameEdited(true); }}
              drafts={drafts}
              onDrafts={setDrafts}
            />
          )}
          {step === "preview" && (
            <PreviewStep
              library={library}
              folders={folders}
              layouts={layouts}
              ruleId={editing?.id ?? null}
              rows={previewRows}
              onRows={setPreviewRows}
              existingRules={existingRules}
            />
          )}
        </div>
      </div>

      <div className="layout-wizard-foot">
        {stepIndex > 0 ? (
          <Button variant="secondary" onClick={goBack} disabled={saving}>{t("controlAdmin:layout.back")}</Button>
        ) : (
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
        )}
        <span className="layout-spacer" />
        {step === "folders" && (
          <>
            {!canLeaveFolders && <span className="muted">{t("controlAdmin:layout.chooseToContinue")}</span>}
            <Button variant="primary" onClick={goNext} disabled={!canLeaveFolders}>{t("controlAdmin:layout.next", { step: stepLabel("layout") })} <ArrowRight size={16} aria-hidden="true" /></Button>
          </>
        )}
        {step === "layout" && (
          <Button variant="primary" onClick={goNext} disabled={!canLeaveLayout}>{t("controlAdmin:layout.next", { step: stepLabel("preview") })} <ArrowRight size={16} aria-hidden="true" /></Button>
        )}
        {step === "preview" && (
          <>
            <Button variant="secondary" onClick={() => save(false)} disabled={saving || !canLeaveLayout}>
              {saving ? t("controlAdmin:layout.saving") : isDefault ? t("controlAdmin:layout.saveDefault") : t("controlAdmin:layout.save")}
            </Button>
            <Button variant="primary" onClick={() => save(true)} disabled={saving || !canLeaveLayout}>
              {saving ? t("controlAdmin:layout.saving") : t("controlAdmin:layout.saveAndScan")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
