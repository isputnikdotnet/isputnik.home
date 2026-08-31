import { useState } from "react";
import { UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import { CHILD_RELATION_OPTIONS, childRelationLabel, type FamilyChildLink, type FamilyPerson, type FamilyPersonProfile } from "./types";

// Add a sibling: another child under the person's parent union. The caller
// only offers this when a parent union exists — a sibling link has to hang
// off shared parents.
export function AddSiblingModal({
  person,
  parentUnionId,
  siblingIds,
  onClose,
  onAdded
}: {
  person: FamilyPersonProfile;
  parentUnionId: string;
  /** Already-linked siblings, excluded from the picker. */
  siblingIds: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [sibling, setSibling] = useState<FamilyPerson | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [relation, setRelation] = useState<FamilyChildLink["relation"]>("biological");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const excludeIds = [
    person.id,
    ...siblingIds,
    ...person.parents.map((p) => p.id),
    ...person.unions.flatMap((u) => [u.partner?.id, ...u.children.map((c) => c.id)]).filter((id): id is string => id != null)
  ];

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sibling) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/unions/${parentUnionId}/children`, {
        method: "POST",
        body: JSON.stringify({ childId: sibling.id, relation })
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:addSibling.errors.default"));
      setSaving(false);
    }
  };

  if (pickerOpen) {
    return (
      <PersonPickerModal
        title={t("family:addSibling.pickerTitle", { name: person.name })}
        excludeIds={excludeIds}
        onPick={(picked) => { setSibling(picked); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    );
  }

  return (
    <Modal
      variant="card"
      title={t("family:addSibling.modalTitle", { name: person.name })}
      icon={<UsersRound size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("family:common.unableToAdd")}>{error}</MessageBox>}
      <p className="ft-modal-hint">
        {t("family:addSibling.addedAsChildOf", {
          parents: person.parents.map((p) => p.name).join(" & ") || t("family:addSibling.sameParentsFallback")
        })}
      </p>
      <div className="ft-partner-pick">
        {sibling ? (
          <button type="button" className="ft-picker-row" onClick={() => setPickerOpen(true)} disabled={saving}>
            <PersonAvatar person={sibling} size={36} />
            <span className="ft-picker-row-name"><strong>{sibling.name}</strong><small>{t("family:addSibling.changeSibling")}</small></span>
          </button>
        ) : (
          <Button variant="secondary" onClick={() => setPickerOpen(true)} disabled={saving}>
            {t("family:addSibling.chooseSibling")}
          </Button>
        )}
      </div>
      <div className="ft-field-stack">
        <label className="field">
          <span>{t("family:addSibling.relationToParents")}</span>
          <select value={relation} onChange={(event) => setRelation(event.target.value as FamilyChildLink["relation"])}>
            {CHILD_RELATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{childRelationLabel(option.value)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving || !sibling}>
          {saving ? t("family:common.adding") : t("family:addSibling.submit")}
        </Button>
      </div>
    </Modal>
  );
}
