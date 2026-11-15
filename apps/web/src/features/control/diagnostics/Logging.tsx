import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ChoiceGroup } from "../../../shared/ChoiceGroup";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";

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

/** A part's logging on the Diagnostics overview: "Logging [Normal ▾]" and, while
 *  raised, "until 15:40". Detailed or Everything is set for an hour (the part's own
 *  page offers 15 minutes and 4 hours); Normal ends it now. A container too old to
 *  change it says so instead. */
export function LoggingSelect({ url, name }: { url: string; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { state, setState, missing } = useLogging(url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = t("controlAdmin:diagnostics.logging.label");
  if (missing) return <span className="diagnostics-logging-inline muted">{label}: {t("controlAdmin:diagnostics.logging.cannot")}</span>;
  const choose = async (level: LoggingLevel) => {
    if (!state || level === state.level) return;
    setBusy(true);
    setError("");
    try {
      const minutes = state.minutes.includes(60) ? 60 : state.minutes[0] ?? 60;
      setState(await api<LoggingState>(url, { method: "PUT", body: JSON.stringify({ level, minutes }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:diagnostics.logging.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const raised = state !== null && state.level !== "normal";
  return (
    <span className={raised ? "diagnostics-logging-inline is-raised" : "diagnostics-logging-inline"} aria-busy={busy || undefined}>
      <span className="muted">{label}</span>
      {state ? (
        <SelectField
          compact
          hideLabel
          className="diagnostics-logging-select"
          label={t("controlAdmin:diagnostics.logging.title", { name })}
          value={state.level}
          disabled={busy}
          options={LEVELS.map((level) => ({ value: level, label: t(`controlAdmin:diagnostics.logging.level.${level}.label`) }))}
          onChange={(level) => void choose(level)}
        />
      ) : (
        <span className="muted">{t("controlAdmin:diagnostics.logging.reading")}</span>
      )}
      {raised && state?.until && <span className="diagnostics-logging-until">{t("controlAdmin:diagnostics.logging.untilShort", { time: clock(state.until) })}</span>}
      {error && <span className="diagnostics-logging-error" role="alert">{error}</span>}
    </span>
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
