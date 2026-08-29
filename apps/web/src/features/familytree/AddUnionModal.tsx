import { useState } from "react";
import { Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "../../shared/PartialDateField";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import { UNION_STATUS_OPTIONS, unionStatusLabel, type FamilyPerson, type FamilyUnion } from "./types";

// Add a spouse/partner union for `person`: pick the partner (or create them),
// set the status and dates. Partner is optional — omitting one records a
// single-parent family children can hang off.
export function AddUnionModal({
  person,
  onClose,
  onAdded
}: {
  person: FamilyPerson;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [partner, setPartner] = useState<FamilyPerson | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState<FamilyUnion["status"]>("married");
  const [marriedDate, setMarriedDate] = useState("");
  const [marriedPlace, setMarriedPlace] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api("/api/family-tree/unions", {
        method: "POST",
        body: JSON.stringify({
          person1Id: person.id,
          person2Id: partner?.id ?? null,
          status,
          marriedDate: marriedDate.trim() || null,
          marriedPlace: marriedPlace.trim() || null
        })
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:addUnion.errors.default"));
      setSaving(false);
    }
  };

  if (pickerOpen) {
    return (
      <PersonPickerModal
        title={t("family:addUnion.pickerTitle", { name: person.name })}
        excludeIds={[person.id]}
        onPick={(picked) => { setPartner(picked); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    );
  }

  return (
    <Modal
      variant="card"
      title={t("family:addUnion.modalTitle", { name: person.name })}
      icon={<Heart size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("family:common.unableToAdd")}>{error}</MessageBox>}
      <div className="ft-partner-pick">
        {partner ? (
          <button type="button" className="ft-picker-row" onClick={() => setPickerOpen(true)} disabled={saving}>
            <PersonAvatar person={partner} size={36} />
            <span className="ft-picker-row-name"><strong>{partner.name}</strong><small>{t("family:addUnion.changePartner")}</small></span>
          </button>
        ) : (
          <Button variant="secondary" onClick={() => setPickerOpen(true)} disabled={saving}>
            {t("family:addUnion.choosePartner")}
          </Button>
        )}
        {partner && (
          <Button variant="text" compact onClick={() => setPartner(null)} disabled={saving}>
            {t("family:addUnion.noPartnerSingleParent")}
          </Button>
        )}
      </div>
      <div className="ft-field-stack">
        <label className="field">
          <span>{t("family:common.status")}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as FamilyUnion["status"])}>
            {UNION_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{unionStatusLabel(option.value)}</option>
            ))}
          </select>
        </label>
        <PartialDateField
          label={t("family:addUnion.marriedSinceLabel")}
          value={marriedDate}
          placeholder={t("partialDate.example.married")}
          onChange={setMarriedDate}
        />
        <label className="field">
          <span>{t("family:addUnion.placeOfMarriage")}</span>
          <input type="text" value={marriedPlace} onChange={(event) => setMarriedPlace(event.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("family:common.adding") : t("family:addUnion.submit")}
        </Button>
      </div>
    </Modal>
  );
}
