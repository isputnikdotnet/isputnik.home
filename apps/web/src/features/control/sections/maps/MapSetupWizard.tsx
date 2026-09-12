import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import { controlHref, navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { forgetMapConfig } from "../../../../shared/map/map-style";
import type { MapSettingsDto } from "./map-settings";

// Turning maps on (docs/map-approach-proposal.md, "Setup wizard"). Three steps,
// because enabling means choosing what to keep, knowing where it will go, and
// then fetching it — and each of those is worth a moment of its own:
//
//   1. What   — the levels, each with its size. Towns are not offered: that
//               database comes from the owner, so it is added on the Data tab.
//   2. Where  — the folders it lands in, and the way to change them.
//   3. Run    — one at a time, each saying how it went. A level that fails is
//               left off rather than half on.

type Level = "cache" | "countries";
type Outcome = { state: "waiting" } | { state: "working" } | { state: "done" } | { state: "failed"; error: string };

export function MapSetupWizard({
  status,
  onClose,
  onFinished
}: {
  status: MapSettingsDto;
  onClose: () => void;
  /** After step 3, whatever happened: the page reloads what is now on. */
  onFinished: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const cacheOn = status.settings.cache;
  const countriesOn = status.locations.countryFilePresent;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [chosen, setChosen] = useState<Record<Level, boolean>>({ cache: !cacheOn, countries: !countriesOn });
  const [outcomes, setOutcomes] = useState<Partial<Record<Level, Outcome>>>({});
  const [running, setRunning] = useState(false);

  const levels = (["cache", "countries"] as Level[]).filter((level) => chosen[level]);
  const label: Record<Level, string> = {
    cache: t("controlAdmin:mapSetup.cacheName"),
    countries: t("controlAdmin:mapSetup.countriesName")
  };

  const run = async () => {
    setStep(3);
    setRunning(true);
    setOutcomes(Object.fromEntries(levels.map((level) => [level, { state: "waiting" }])));
    for (const level of levels) {
      setOutcomes((current) => ({ ...current, [level]: { state: "working" } }));
      try {
        if (level === "cache") {
          await api("/api/map/settings", { method: "PUT", body: JSON.stringify({ cache: true }) });
        } else {
          await api("/api/dashboard/locations/database", { method: "POST" });
        }
        setOutcomes((current) => ({ ...current, [level]: { state: "done" } }));
      } catch (err) {
        setOutcomes((current) => ({ ...current, [level]: { state: "failed", error: err instanceof Error ? err.message : "" } }));
      }
    }
    // Maps already open elsewhere in this tab asked the server once; the next
    // one should ask again and draw through the cache.
    forgetMapConfig();
    setRunning(false);
    onFinished();
  };

  const outcomeText = (outcome: Outcome | undefined): string => {
    switch (outcome?.state) {
      case "working": return t("controlAdmin:mapWizard.working");
      case "done": return t("controlAdmin:mapWizard.done");
      case "failed": return t("controlAdmin:mapWizard.failed", { error: outcome.error });
      default: return t("controlAdmin:mapWizard.waiting");
    }
  };

  const finished = step === 3 && !running;
  const anyFailed = Object.values(outcomes).some((outcome) => outcome?.state === "failed");

  const checkbox = (level: Level, hint: string, alreadyOn: boolean) => (
    <label className="field-checkbox">
      <input
        type="checkbox"
        checked={alreadyOn || chosen[level]}
        disabled={alreadyOn}
        onChange={(event) => setChosen((current) => ({ ...current, [level]: event.target.checked }))}
      />
      <span>
        {label[level]}
        <small>{alreadyOn ? t("controlAdmin:mapWizard.alreadyOn") : hint}</small>
      </span>
    </label>
  );

  return (
    <Modal
      variant="card"
      title={t("controlAdmin:mapWizard.title")}
      subtitle={t("controlAdmin:mapWizard.stepOf", { step })}
      busy={running}
      onClose={onClose}
      className="map-wizard"
    >
      {step === 1 && (
        <>
          <p>{t("controlAdmin:mapWizard.chooseIntro")}</p>
          <div className="map-wizard-choices">
            {checkbox("cache", t("controlAdmin:mapWizard.cacheHint"), cacheOn)}
            {checkbox("countries", t("controlAdmin:mapWizard.countriesHint"), countriesOn)}
          </div>
          <p className="datagrid-muted">
            {t("controlAdmin:mapWizard.townsNote")}{" "}
            <Button variant="text" compact onClick={() => { onClose(); navigate(controlHref("mapData")); }}>
              {t("controlAdmin:mapSetup.addDatabase")}
            </Button>
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={levels.length === 0} onClick={() => setStep(2)}>
              {t("controlAdmin:mapWizard.next")}
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h3>{t("controlAdmin:mapWizard.whereTitle")}</h3>
          {chosen.cache && (
            <p>
              {t("controlAdmin:mapWizard.whereCache", { path: status.cache.folder })}{" "}
              <Button variant="text" compact onClick={() => { onClose(); navigate(controlHref("storage")); }}>
                {t("controlAdmin:mapWizard.changeWhere")}
              </Button>
            </p>
          )}
          {chosen.countries && <p>{t("controlAdmin:mapWizard.whereCountries", { path: status.locations.directory })}</p>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>{t("controlAdmin:mapWizard.back")}</Button>
            <Button variant="primary" onClick={() => void run()}>{t("controlAdmin:mapWizard.start")}</Button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h3>{t("controlAdmin:mapWizard.runTitle")}</h3>
          <ul className="map-wizard-run">
            {levels.map((level) => (
              <li key={level} className={`is-${outcomes[level]?.state ?? "waiting"}`}>
                <strong>{label[level]}</strong>
                <span>{outcomeText(outcomes[level])}</span>
              </li>
            ))}
          </ul>
          {finished && (
            anyFailed
              ? <MessageBox tone="warning" title={t("controlAdmin:mapWizard.someFailedTitle")}>{t("controlAdmin:mapWizard.someFailed")}</MessageBox>
              : <MessageBox tone="success" title={t("controlAdmin:mapWizard.allDoneTitle")}>{t("controlAdmin:mapWizard.allDone")}</MessageBox>
          )}
          <div className="modal-actions">
            <Button variant="primary" disabled={running} onClick={onClose}>
              {running ? t("controlAdmin:mapWizard.settingUp") : t("common.close")}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
