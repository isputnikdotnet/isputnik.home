import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "../../api";
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
      const body: { ids: string[]; takenAt?: string; shiftMinutes?: number } = { ids: itemIds };
      if (mode === "set") body.takenAt = new Date(date).toISOString();
      else body.shiftMinutes = shiftMinutes;
      const result = await api<{ updated: number; forbidden: number; noDate: number }>(
        "/api/library/gallery/assets/bulk-place-time",
        { method: "POST", body: JSON.stringify(body) }
      );
      onApplied(result.updated, result.forbidden, result.noDate);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the selected items");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Set date taken"
      icon={<CalendarClock size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void apply(); }}
    >
      <p className="muted">
        Applies to {count} selected item{count === 1 ? "" : "s"}. The date you set here survives the next scan.
      </p>

      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

      <div className="gallery-bulk-edit-modes" role="radiogroup" aria-label="How to change the date">
        <label>
          <input type="radio" name="date-mode" checked={mode === "set"} onChange={() => setMode("set")} disabled={busy} />
          <span>Set one date</span>
        </label>
        <label>
          <input type="radio" name="date-mode" checked={mode === "shift"} onChange={() => setMode("shift")} disabled={busy} />
          <span>Shift by an offset</span>
        </label>
      </div>

      <div className="gallery-bulk-edit-field">
        {mode === "set" ? (
          <>
            <label>
              <span className="sr-only">Date and time taken</span>
              <input
                type="datetime-local"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                disabled={busy}
                autoFocus
              />
            </label>
            <span className="muted gallery-bulk-edit-hint">
              Every selected item gets this exact date and time, so they’ll sort together in the timeline.
            </span>
          </>
        ) : (
          <>
            <div className="gallery-bulk-edit-shift">
              <label>
                <span className="sr-only">Shift amount</span>
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
                <span className="sr-only">Unit</span>
                <select value={shiftUnit} onChange={(event) => setShiftUnit(event.target.value as ShiftUnit)} disabled={busy}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </label>
              <label>
                <span className="sr-only">Direction</span>
                <select value={shiftBack ? "back" : "forward"} onChange={(event) => setShiftBack(event.target.value === "back")} disabled={busy}>
                  <option value="forward">later</option>
                  <option value="back">earlier</option>
                </select>
              </label>
            </div>
            <span className="muted gallery-bulk-edit-hint">
              Each item moves by this much from its own date, so the order and spacing the camera
              recorded are kept. Items with no date at all can’t be shifted.
            </span>
          </>
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? "Applying…" : "Apply"}
        </Button>
      </div>
    </Modal>
  );
}
