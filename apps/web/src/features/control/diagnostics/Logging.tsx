import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Timer } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ChoiceGroup } from "../../../shared/ChoiceGroup";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { SelectMenu } from "../../../shared/SelectMenu";

// How much one part of iSputnik logs (docs/diagnostic-logging-plan.md): Normal, or
// Detailed / Everything for 15 minutes, an hour or 4 hours, then back to Normal by
// itself. This server answers GET/PUT /api/admin/logging (core/logging.ts); a
// container answers the same under its prefix, through the gateway. A container
// too old for it says so and can't be changed.

export type LoggingLevel = "normal" | "detailed" | "everything";

export interface LoggingState {
  level: LoggingLevel;
  until: string | null;
  minutes: number[];
}

const LEVELS: LoggingLevel[] = ["normal", "detailed", "everything"];

/** Where a part's logging is read and set: this server's own route, or the container's through the gateway. */
export function loggingUrl(prefix: string | null): string {
  return prefix === null ? "/api/admin/logging" : `${prefix}/api/admin/logging`;
}

export function useLogging(url: string | null) {
  const [state, setState] = useState<LoggingState | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      setState(await api<LoggingState>(url));
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  // Back to Normal by itself: look again when the time is up.
  useEffect(() => {
    if (!state?.until) return;
    const wait = Date.parse(state.until) - Date.now();
    const timer = window.setTimeout(() => void load(), Math.max(1000, wait + 1000));
    return () => window.clearTimeout(timer);
  }, [state?.until, load]);
  return { state, setState, missing, load };
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "Detailed until 15:40", "Normal", or why it can't be changed. */
export function useLoggingWords() {
  const { t } = useTranslation(["controlAdmin"]);
  return (state: LoggingState | null, missing: boolean): string => {
    if (missing) return t("controlAdmin:diagnostics.logging.cannot");
    if (!state) return t("controlAdmin:diagnostics.logging.reading");
    const level = t(`controlAdmin:diagnostics.logging.level.${state.level}.label`);
    return state.until ? t("controlAdmin:diagnostics.logging.until", { level, time: clock(state.until) }) : level;
  };
}

/** A part's diagnostic mode on the Diagnostics overview (owner, 2026-11-17):
 *  "Diagnostic mode ⓘ [Normal | Detailed | Full]" and, while raised, a timer —
 *  "⏱ [1 hour ▾] until 15:40" — for how long (15 minutes, an hour, 4 hours: what the
 *  part offers). Detailed or Full starts at an hour; changing the timer starts it
 *  again from now; Normal ends it now and the timer goes. Greyed out where the part can't be asked — not set
 *  up, not answering, or a container too old to change it. */
export function LoggingModes({ url, name }: { url: string | null; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { state, setState, missing } = useLogging(url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // How long it was last set for here; an hour until someone chooses otherwise.
  const [length, setLength] = useState<number | null>(null);
  const defaultLength = state ? (state.minutes.includes(60) ? 60 : state.minutes[0] ?? 60) : 60;
  const minutesNow = length ?? defaultLength;
  const put = async (level: LoggingLevel, minutes: number) => {
    if (!url || !state) return;
    setBusy(true);
    setError("");
    try {
      setState(await api<LoggingState>(url, { method: "PUT", body: JSON.stringify({ level, minutes }) }));
      setLength(minutes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.logging.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const choose = (level: LoggingLevel) => { if (state && level !== state.level) void put(level, minutesNow); };
  const lengthLabel = (value: number) => (value >= 60 ? t("controlAdmin:diagnostics.logging.hours", { count: value / 60 }) : t("controlAdmin:diagnostics.logging.minutesLabel", { count: value }));
  const raised = state !== null && state.level !== "normal";
  const off = !url || missing || !state;
  return (
    <span className={raised ? "diagnostics-mode is-raised" : "diagnostics-mode"} aria-busy={busy || undefined}>
      <span className="diagnostics-mode-label" title={missing ? t("controlAdmin:diagnostics.logging.cannot") : t("controlAdmin:diagnostics.logging.help")}>
        {t("controlAdmin:diagnostics.logging.label")}
        <Info size={14} aria-hidden="true" />
      </span>
      <SegmentedControl
        className="diagnostics-mode-switch"
        label={t("controlAdmin:diagnostics.logging.title", { name })}
        value={off ? null : state.level}
        disabled={off || busy}
        options={LEVELS.map((level) => ({ value: level, label: t(`controlAdmin:diagnostics.logging.level.${level}.label`) }))}
        onChange={choose}
      />
      {raised && state && (
        <span className="diagnostics-mode-timer">
          <SelectMenu
            className="diagnostics-mode-length"
            value={String(state.minutes.includes(minutesNow) ? minutesNow : defaultLength)}
            label={t("controlAdmin:diagnostics.logging.lengthLegend")}
            triggerIcon={<Timer size={14} />}
            disabled={busy}
            options={state.minutes.map((value) => ({ value: String(value), label: lengthLabel(value) }))}
            onChange={(value) => void put(state.level, Number(value))}
          />
          {state.until && <span className="diagnostics-logging-until">{t("controlAdmin:diagnostics.logging.untilShort", { time: clock(state.until) })}</span>}
        </span>
      )}
      {error && <span className="diagnostics-logging-error" role="alert">{error}</span>}
    </span>
  );
}

/** What each mode does, once, at the foot of the overview. */
export function LoggingModesLegend() {
  const { t } = useTranslation(["controlAdmin"]);
  return (
    <section className="diagnostics-modes" aria-labelledby="diagnostics-modes-title">
      <h2 id="diagnostics-modes-title"><Info size={18} aria-hidden="true" /> {t("controlAdmin:diagnostics.logging.legendTitle")}</h2>
      <dl>
        {LEVELS.map((level) => (
          <div key={level} className={`is-${level}`}>
            <dt>{t(`controlAdmin:diagnostics.logging.level.${level}.label`)}</dt>
            <dd>{t(`controlAdmin:diagnostics.logging.level.${level}.sub`)}</dd>
          </div>
        ))}
      </dl>
      {/* How long a raised mode lasts — the timer beside the switch. */}
      <p className="diagnostics-modes-time"><Timer size={15} aria-hidden="true" /> {t("controlAdmin:diagnostics.logging.legendTime")}</p>
    </section>
  );
}

/** A part's logging, as a line and a button that opens the choice. */
export function LoggingControl({ url, name }: { url: string | null; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { state, setState, missing } = useLogging(url);
  const words = useLoggingWords();
  const [open, setOpen] = useState(false);
  const raised = state !== null && state.level !== "normal";
  return (
    <div className={raised ? "diagnostics-logging is-raised" : "diagnostics-logging"}>
      <span>
        <span className="muted">{t("controlAdmin:diagnostics.logging.label")}</span>{" "}
        <strong>{words(state, missing)}</strong>
      </span>
      {!missing && state && (
        <Button variant="secondary" compact onClick={() => setOpen(true)}>{t("controlAdmin:diagnostics.logging.change")}</Button>
      )}
      {open && state && url && <LoggingDialog url={url} name={name} state={state} onSaved={setState} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LoggingDialog({ url, name, state, onSaved, onClose }: {
  url: string;
  name: string;
  state: LoggingState;
  onSaved: (state: LoggingState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [level, setLevel] = useState<LoggingLevel>(state.level === "normal" ? "detailed" : state.level);
  const [minutes, setMinutes] = useState(String(state.minutes.includes(60) ? 60 : state.minutes[0] ?? 60));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (next: LoggingLevel) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await api<LoggingState>(url, { method: "PUT", body: JSON.stringify({ level: next, minutes: Number(minutes) }) }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.logging.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const lengthLabel = (value: number) => (value >= 60 ? t("controlAdmin:diagnostics.logging.hours", { count: value / 60 }) : t("controlAdmin:diagnostics.logging.minutesLabel", { count: value }));

  return (
    <Modal
      title={t("controlAdmin:diagnostics.logging.title", { name })}
      subtitle={t("controlAdmin:diagnostics.logging.subtitle")}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void save(level); }}
    >
      {error && <MessageBox tone="error" title={t("controlAdmin:diagnostics.logging.saveFailed")}>{error}</MessageBox>}
      <ChoiceGroup
        legend={t("controlAdmin:diagnostics.logging.levelLegend")}
        value={level}
        onChange={setLevel}
        disabled={busy}
        options={LEVELS.filter((entry) => entry !== "normal").map((entry) => ({
          value: entry,
          label: t(`controlAdmin:diagnostics.logging.level.${entry}.label`),
          description: t(`controlAdmin:diagnostics.logging.level.${entry}.sub`)
        }))}
      />
      <ChoiceGroup
        legend={t("controlAdmin:diagnostics.logging.lengthLegend")}
        value={minutes}
        onChange={setMinutes}
        disabled={busy}
        options={state.minutes.map((value) => ({ value: String(value), label: lengthLabel(value) }))}
      />
      <p className="muted">{t("controlAdmin:diagnostics.logging.note")}</p>
      <div className="modal-actions">
        {state.level !== "normal" && (
          <Button variant="secondary" disabled={busy} onClick={() => void save("normal")}>{t("controlAdmin:diagnostics.logging.backToNormal")}</Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t("controlAdmin:diagnostics.logging.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t("controlAdmin:diagnostics.logging.turningOn") : t("controlAdmin:diagnostics.logging.turnOn")}</Button>
      </div>
    </Modal>
  );
}
