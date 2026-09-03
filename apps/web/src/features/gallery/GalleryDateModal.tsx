import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock } from "lucide-react";
import { api } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
type ShiftUnit = keyof typeof UNIT_MINUTES;

// Fix the date taken on the selected photos and videos — the camera whose clock
// was never set, or a folder of scans that share one occasion. Two ways to do it:
// pin everything to one instant, or shift each item from its own date so the
// spacing the camera recorded survives. Location is a separate dialog; single-item
// edits live in the lightbox Info panel.
export function GalleryDateModal({
  itemIds,
  onClose,
  onApplied
}: {
  itemIds: string[];
  onClose: () => void;
  onApplied: (updated: number, forbidden: number, noDate: number) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [mode, setMode] = useState<"set" | "shift">("set");
  const [date, setDate] = useState("");
  const [shiftAmount, setShiftAmount] = useState("1");
  const [shiftUnit, setShiftUnit] = useState<ShiftUnit>("hours");
  const [shiftBack, setShiftBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const count = itemIds.length;
  const amount = Number(shiftAmount);
  const shiftMinutes = Number.isFinite(amount) && amount > 0
    ? Math.round(amount * UNIT_MINUTES[shiftUnit]) * (shiftBack ? -1 : 1)
    : 0;
  const ready = mode === "set" ? date !== "" : shiftMinutes !== 0;

  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const when = mode === "set"
        ? { takenAt: new Date(date).toISOString() }
        : { shiftMinutes };
      const result = await sendInBatches<{ updated: number; forbidden: number; noDate: number }>(itemIds, (ids) =>
        api("/api/library/gallery/assets/bulk-place-time", {
          method: "POST",
          body: JSON.stringify({ ids, ...when })
        }));
      onApplied(result.updated, result.forbidden, result.noDate);
      onClose();
    } catch (err) {
      // Batched: a failure part-way through has already changed everything the
      // earlier batches carried, and saying only "unable to update" would hide it.
      setError(err instanceof PartialBulkError
        ? t("galleryModals:common.partiallyApplied", { count: err.applied, error: err.message })
        : err instanceof Error ? err.message : t("galleryModals:date.unableToUpdate"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("galleryModals:date.title")}
      icon={<CalendarClock size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void apply(); }}
    >
      <p className="muted">
        {t("galleryModals:date.appliesTo", { count })}
      </p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-modes" role="radiogroup" aria-label={t("galleryModals:date.modeAria")}>
        <label>
          <input type="radio" name="date-mode" checked={mode === "set"} onChange={() => setMode("set")} disabled={busy} />
          <span>{t("galleryModals:date.modeSet")}</span>
        </label>
        <label>
          <input type="radio" name="date-mode" checked={mode === "shift"} onChange={() => setMode("shift")} disabled={busy} />
          <span>{t("galleryModals:date.modeShift")}</span>
        </label>
      </div>

      <div className="gallery-bulk-edit-field">
        {mode === "set" ? (
          <>
            <label>
              <span className="sr-only">{t("galleryModals:date.dateTimeSr")}</span>
              <input
                type="datetime-local"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                disabled={busy}
                autoFocus
              />
            </label>
            <span className="muted gallery-bulk-edit-hint">
              {t("galleryModals:date.setHint")}
            </span>
          </>
        ) : (
          <>
            <div className="gallery-bulk-edit-shift">
              <label>
                <span className="sr-only">{t("galleryModals:date.shiftAmountSr")}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={shiftAmount}
                  onChange={(event) => setShiftAmount(event.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </label>
              <label>
                <span className="sr-only">{t("galleryModals:date.unitSr")}</span>
                <select value={shiftUnit} onChange={(event) => setShiftUnit(event.target.value as ShiftUnit)} disabled={busy}>
                  <option value="minutes">{t("galleryModals:date.unitMinutes")}</option>
                  <option value="hours">{t("galleryModals:date.unitHours")}</option>
                  <option value="days">{t("galleryModals:date.unitDays")}</option>
                </select>
              </label>
              <label>
                <span className="sr-only">{t("galleryModals:date.directionSr")}</span>
                <select value={shiftBack ? "back" : "forward"} onChange={(event) => setShiftBack(event.target.value === "back")} disabled={busy}>
                  <option value="forward">{t("galleryModals:date.later")}</option>
                  <option value="back">{t("galleryModals:date.earlier")}</option>
                </select>
              </label>
            </div>
            <span className="muted gallery-bulk-edit-hint">
              {t("galleryModals:date.shiftHint")}
            </span>
          </>
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? t("galleryModals:common.applying") : t("galleryModals:common.apply")}
        </Button>
      </div>
    </Modal>
  );
}
