import { useState } from "react";
import { Baby } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import { CHILD_RELATION_OPTIONS, childRelationLabel, type FamilyChildLink, type FamilyPersonProfile } from "./types";
import type { FamilyPerson } from "./types";

// Add a child under one of `person`'s unions. With no union yet (or "just
// {person}" chosen), a single-parent union is created on the fly, so the
// caller never has to think about unions as a prerequisite.
export function AddChildModal({
  person,
  onClose,
  onAdded
}: {
  person: FamilyPersonProfile;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const singleUnion = person.unions.find((u) => u.partner == null);
  const [unionId, setUnionId] = useState<string>(person.unions[0]?.id ?? "single");
  const [child, setChild] = useState<FamilyPerson | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [relation, setRelation] = useState<FamilyChildLink["relation"]>("biological");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const unionOptions = [
    ...person.unions.map((u) => ({
      value: u.id,
      label: u.partner
        ? t("family:addChild.unionOptionWithPartner", { name: u.partner.name })
        : t("family:addChild.unionOptionJust", { name: person.name })
    })),
    // Offer an on-the-fly single-parent family unless one already exists.
    ...(singleUnion
      ? []
      : [{ value: "single", label: t("family:addChild.unionOptionJustSingleParent", { name: person.name }) }])
  ];

  const excludeIds = [
    person.id,
    ...person.parents.map((p) => p.id),
    ...person.unions.flatMap((u) => [u.partner?.id, ...u.children.map((c) => c.id)]).filter((id): id is string => id != null)
  ];

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!child) return;
    setSaving(true);
    setError("");
    try {
      let targetUnionId = unionId;
      if (targetUnionId === "single") {
        const created = await api<{ union: { id: string } }>("/api/family-tree/unions", {
          method: "POST",
          body: JSON.stringify({ person1Id: person.id, person2Id: null })
        });
        targetUnionId = created.union.id;
      }
      await api(`/api/family-tree/unions/${targetUnionId}/children`, {
        method: "POST",
        body: JSON.stringify({ childId: child.id, relation })
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:addChild.errors.default"));
      setSaving(false);
    }
  };

  if (pickerOpen) {
    return (
      <PersonPickerModal
        title={t("family:addChild.pickerTitle", { name: person.name })}
        excludeIds={excludeIds}
        onPick={(picked) => { setChild(picked); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    );
  }

  return (
    <Modal
      variant="card"
      title={t("family:addChild.modalTitle", { name: person.name })}
      icon={<Baby size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("family:common.unableToAdd")}>{error}</MessageBox>}
      <div className="ft-partner-pick">
        {child ? (
          <button type="button" className="ft-picker-row" onClick={() => setPickerOpen(true)} disabled={saving}>
            <PersonAvatar person={child} size={36} />
            <span className="ft-picker-row-name"><strong>{child.name}</strong><small>{t("family:addChild.changeChild")}</small></span>
          </button>
        ) : (
          <Button variant="secondary" onClick={() => setPickerOpen(true)} disabled={saving}>
            {t("family:addChild.chooseChild")}
          </Button>
        )}
      </div>
      <div className="ft-field-stack">
        {unionOptions.length > 1 && (
          <label className="field">
            <span>{t("family:addChild.familyFieldLabel")}</span>
            <select value={unionId} onChange={(event) => setUnionId(event.target.value)}>
              {unionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t("family:common.relation")}</span>
          <select value={relation} onChange={(event) => setRelation(event.target.value as FamilyChildLink["relation"])}>
            {CHILD_RELATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{childRelationLabel(option.value)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving || !child}>
          {saving ? t("family:common.adding") : t("family:addChild.submit")}
        </Button>
      </div>
    </Modal>
  );
}
