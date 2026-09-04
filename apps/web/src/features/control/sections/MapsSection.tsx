import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Map } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";

interface RoutingDto {
  routing: { endpoint: string; hasApiKey: boolean };
  configured: boolean;
}

// Map routing: the one setting that decides whether a story's route follows
// real roads or is drawn straight between its stops.
//
// Off until an admin pastes a key, and even then the service is asked only when
// a route is SAVED — the line comes back once and is stored with the story, so
// reading one never leaves the house. Worth saying plainly on the page: the
// coordinates of somewhere the family actually went are what gets sent.
export function MapsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState(false);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    api<RoutingDto>("/api/config/routing")
      .then((data) => {
        setEndpoint(data.routing.endpoint);
        setHasApiKey(data.routing.hasApiKey);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:maps.loadFailed")))
      .finally(() => setLoading(false));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");
    setTestOk(false);
    setTestError("");
    try {
      // A blank key keeps the stored one — the same contract as the SMTP
      // password, so re-saving the endpoint doesn't wipe the key.
      const data = await api<RoutingDto>("/api/config/routing", {
        method: "PUT",
        body: JSON.stringify({ endpoint, ...(apiKey ? { apiKey } : {}) })
      });
      setHasApiKey(data.routing.hasApiKey);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  // Turning routing off again: existing routes keep the roads already drawn
  // into them, and nothing further is ever sent.
  const removeKey = async () => {
    setRemoving(true);
    setSaveError("");
    try {
      const data = await api<RoutingDto>("/api/config/routing", {
        method: "PUT",
        body: JSON.stringify({ endpoint, clearApiKey: true })
      });
      setHasApiKey(data.routing.hasApiKey);
      setApiKey("");
      setTestOk(false);
      setTestError("");
      setConfirmRemove(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setRemoving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestOk(false);
    setTestError("");
    try {
      await api("/api/config/routing/test", { method: "POST" });
      setTestOk(true);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : t("controlAdmin:maps.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="maps"
        icon={<Map size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:maps.headDescription")}
      />

      <section className="config-block">
        <p className="muted">{t("controlAdmin:maps.intro")}</p>

        {loadError && <MessageBox tone="error" title={t("controlAdmin:maps.title")}>{loadError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form className="mail-form" onSubmit={save}>
            <Field
              label={t("controlAdmin:maps.keyLabel")}
              value={apiKey}
              onChange={setApiKey}
              type="password"
              placeholder={hasApiKey ? t("controlAdmin:maps.keyStored") : t("controlAdmin:maps.keyEmpty")}
              autoComplete="new-password"
              required={false}
            />
            <p className="muted">{t("controlAdmin:maps.keyNote")}</p>

            <Field
              label={t("controlAdmin:maps.endpointLabel")}
              value={endpoint}
              onChange={setEndpoint}
              type="url"
              placeholder="https://api.openrouteservice.org"
              autoComplete="off"
              required={false}
            />
            <p className="muted">{t("controlAdmin:maps.endpointNote")}</p>

            <MessageBox tone="info" title={t("controlAdmin:maps.privacyTitle")}>
              {t("controlAdmin:maps.privacyBody")}
            </MessageBox>

            {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:maps.savedBody")}</MessageBox>}
            {testOk && <MessageBox tone="success" title={t("controlAdmin:maps.testOkTitle")}>{t("controlAdmin:maps.testOkBody")}</MessageBox>}
            {testError && <MessageBox tone="error" title={t("controlAdmin:maps.testFailed")}>{testError}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
              <Button variant="secondary" disabled={!hasApiKey || testing || saving} onClick={() => void test()}>
                {testing ? t("controlAdmin:maps.testing") : t("controlAdmin:maps.test")}
              </Button>
              {hasApiKey && (
                <Button variant="text" danger disabled={saving || removing} onClick={() => setConfirmRemove(true)}>
                  {t("controlAdmin:maps.removeKey")}
                </Button>
              )}
            </div>
          </form>
        )}
      </section>

      {confirmRemove && (
        <ConfirmDialog
          title={t("controlAdmin:maps.removeConfirmTitle")}
          confirmLabel={t("controlAdmin:maps.removeKey")}
          busyLabel={t("controlAdmin:maps.removing")}
          busy={removing}
          danger
          onConfirm={() => void removeKey()}
          onCancel={() => setConfirmRemove(false)}
        >
          {t("controlAdmin:maps.removeConfirmBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
