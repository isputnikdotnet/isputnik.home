import { useState, type FormEvent } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { MessageBox } from "./MessageBox";

// The time-window control for activity views: a row of relative presets with a
// Custom escape hatch. Presets are resolved to concrete instants the moment they
// are picked, so every consumer (chart, table, KPI) asks the server about exactly
// the same window and a reload doesn't silently drift.

export type DateRangePreset = "all" | "1h" | "7h" | "24h" | "7d" | "30d" | "custom";

export interface DateRangeValue {
  preset: DateRangePreset;
  /** ISO instants, inclusive — both empty for "all", which means no bound at all. */
  from: string;
  to: string;
}

/** No window: the whole archive. Only pickers with `allowAll` offer it. */
export const ALL_TIME: DateRangeValue = { preset: "all", from: "", to: "" };

const PRESETS: { value: Exclude<DateRangePreset, "custom">; label: string; hours: number }[] = [
  { value: "1h", label: "1h", hours: 1 },
  { value: "7h", label: "7h", hours: 7 },
  { value: "24h", label: "24h", hours: 24 },
  { value: "7d", label: "7d", hours: 24 * 7 },
  { value: "30d", label: "30d", hours: 24 * 30 }
];

export function resolveDateRange(preset: Exclude<DateRangePreset, "custom">): DateRangeValue {
  const hours = PRESETS.find((entry) => entry.value === preset)?.hours ?? 24;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { preset, from: from.toISOString(), to: to.toISOString() };
}

/** ISO → value for <input type="datetime-local"> (local wall-clock, minute precision). */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRangeLabel(range: DateRangeValue): string {
  if (range.preset === "all") return "All time";
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const sameDay = from.toDateString() === to.toDateString();
  const date = (value: Date) => value.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = (value: Date) => value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `${date(from)}, ${time(from)} – ${time(to)}`
    : `${date(from)}, ${time(from)} – ${date(to)}, ${time(to)}`;
}

/** How long the window is, phrased the way the picker labels it ("24h", "3 days"). */
export function formatRangeSpan(range: DateRangeValue): string {
  if (range.preset === "all") return "all time";
  const preset = PRESETS.find((entry) => entry.value === range.preset);
  if (preset) return preset.label;
  const hours = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return "period";
  if (hours < 48) {
    const rounded = Math.max(1, Math.round(hours));
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function DateRangePicker({
  value,
  onChange,
  label = "Time range",
  disabled = false,
  allowAll = false
}: {
  value: DateRangeValue;
  onChange: (range: DateRangeValue) => void;
  label?: string;
  disabled?: boolean;
  /** Offer "All" — no window — first. For archives (Logs), not for charts, which
   *  need a bounded span to bucket. */
  allowAll?: boolean;
}) {
  const [customOpen, setCustomOpen] = useState(false);

  return (
    <>
      <div className="range-picker" role="group" aria-label={label}>
        {allowAll && (
          <button
            type="button"
            className={value.preset === "all" ? "active" : undefined}
            aria-pressed={value.preset === "all"}
            disabled={disabled}
            onClick={() => onChange(ALL_TIME)}
          >
            All
          </button>
        )}
        {PRESETS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className={value.preset === entry.value ? "active" : undefined}
            aria-pressed={value.preset === entry.value}
            disabled={disabled}
            onClick={() => onChange(resolveDateRange(entry.value))}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          className={`range-picker-custom${value.preset === "custom" ? " active" : ""}`}
          aria-pressed={value.preset === "custom"}
          disabled={disabled}
          onClick={() => setCustomOpen(true)}
        >
          Custom
          <CalendarRange size={15} aria-hidden="true" />
        </button>
      </div>

      {customOpen && (
        <CustomRangeModal
          value={value}
          onClose={() => setCustomOpen(false)}
          onApply={(range) => {
            onChange(range);
            setCustomOpen(false);
          }}
        />
      )}
    </>
  );
}

function CustomRangeModal({
  value,
  onApply,
  onClose
}: {
  value: DateRangeValue;
  onApply: (range: DateRangeValue) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(() => toLocalInput(value.from));
  const [to, setTo] = useState(() => toLocalInput(value.to));
  const [error, setError] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setError("Enter both a start and an end date.");
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setError("The end of the range has to come after its start.");
      return;
    }
    onApply({ preset: "custom", from: start.toISOString(), to: end.toISOString() });
  };

  return (
    <Modal title="Custom range" onClose={onClose} onSubmit={submit}>
      <p className="muted">Times are your local time.</p>

      {error && <MessageBox tone="error" title="Unable to apply">{error}</MessageBox>}

      <div className="range-picker-custom-fields">
        <label className="field">
          <span>From</span>
          <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>To</span>
          <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit">Apply range</Button>
      </div>
    </Modal>
  );
}
