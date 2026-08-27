import { useState } from "react";
import { Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "./PartialDateField";
import { UNION_STATUS_OPTIONS, unionStatusLabel, type FamilyUnionDetail } from "./types";

// Edit an existing union's status and dates. The divorce date is what marks a
// partner as "former" on the profile, so entering one nudges the status to
// match (the user can still override the select afterwards).
export function UnionEditModal({
  union,
  personName,
  onClose,
  onSaved
}: {
  union: FamilyUnionDetail;
  personName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [status, setStatus] = useState(union.status);
  const [marriedDate, setMarriedDate] = useState(union.marriedDate ?? "");
  const [marriedPlace, setMarriedPlace] = useState(union.marriedPlace ?? "");
  const [divorcedDate, setDivorcedDate] = useState(union.divorcedDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const changeDivorcedDate = (value: string) => {
    setDivorcedDate(value);
    if (value.trim() && status !== "divorced" && status !== "widowed") setStatus("divorced");
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/unions/${union.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          marriedDate: marriedDate.trim() || null,
          marriedPlace: marriedPlace.trim() || null,
          divorcedDate: divorcedDate.trim() || null
        })
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:unionEdit.errors.default"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={union.partner
        ? t("family:unionEdit.titleWithPartner", { name: personName, partner: union.partner.name })
        : t("family:unionEdit.titleSingleParent", { name: personName })}
      icon={<Heart size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>}
      <div className="ft-field-stack">
        <label className="field">
          <span>{t("family:common.status")}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as FamilyUnionDetail["status"])}>
            {UNION_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{unionStatusLabel(option.value)}</option>
            ))}
          </select>
        </label>
        <PartialDateField
          label={status === "partners" ? t("family:unionEdit.togetherSince") : t("family:unionEdit.married")}
          value={marriedDate}
          placeholder={t("family:partialDate.example.married")}
          onChange={setMarriedDate}
        />
        <label className="field">
          <span>{t("family:addUnion.placeOfMarriage")}</span>
          <input type="text" value={marriedPlace} onChange={(event) => setMarriedPlace(event.target.value)} />
        </label>
        <PartialDateField
          label={t("family:unionEdit.divorcedSeparated")}
          value={divorcedDate}
          placeholder={t("family:partialDate.example.divorced")}
          onChange={changeDivorcedDate}
        />
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("family:common.saving") : t("family:common.saveChanges")}
        </Button>
      </div>
    </Modal>
  );
}
