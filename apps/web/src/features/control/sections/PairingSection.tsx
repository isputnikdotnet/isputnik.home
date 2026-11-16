import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  AlertTriangle, Box, Check, CircleCheck, CircleHelp, Copy, ExternalLink, Info, KeyRound, Link2, Plug, RefreshCw,
  Save, Terminal, Wand2, XCircle
} from "lucide-react";
import { api } from "../../../api";
import { followRoute, queryParam, replaceQuery } from "../../../router";
import { ActionMenu } from "../../../shared/ActionMenu";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { formatManagedDate } from "../../../shared/utils";
import { guideHref } from "../../help/catalog";
import { ControlSectionHead } from "../ControlSectionHead";
import { backupHref } from "../links";
import { useAppName, useAppsStatus, type AppStatus } from "./AppsSection";

// Infrastructure › Services › Pairing (appsSetup, ?app=): how this server and one
// container trust each other — its address on the Docker network and a shared
// secret. Two faces of one page:
//   - SETUP, while there is no secret or no address (or a secret was just made and
//     is still to be copied): four numbered steps and a footer to test them;
//   - SUMMARY, once paired: a banner saying whether it works, the facts in a row,
//     the secret and what the container must hold, and the actions in the head.
// An address or secret set in this container's environment wins over this page;
// both faces say so instead of offering to change it. The secret is never shown
// again after it is made: this server keeps it sealed.

type Health = "ok" | "down" | "refused" | "unchecked";

function healthOf(app: AppStatus): Health {
  if (app.server && !app.server.ok) return "down";
  if (app.secretAccepted === false) return "refused";
  if (app.configured && app.server?.ok && app.secretAccepted === true) return "ok";
  return "unchecked";
}

/** "isputnik-games" from "http://isputnik-games:4200": the container's name on the network. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function PairingSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const appName = useAppName();
  const { apps, error: appsError, load } = useAppsStatus();
  const [chosen, setChosen] = useState<string | null>(() => queryParam("app"));
  const current = apps?.find((app) => app.id === chosen) ?? apps?.[0] ?? null;
  const [fresh, setFresh] = useState<{ app: string; secret: string } | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "forget" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [address, setAddress] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);

  // The field starts from what is saved, again whenever another app is chosen or
  // the saved address changes.
  const currentId = current?.id;
  const currentUrl = current?.url ?? "";
  useEffect(() => {
    setAddress(currentUrl);
    setAddressError("");
  }, [currentId, currentUrl]);

  const choose = (id: string) => {
    setChosen(id);
    setFresh(null);
    setTested(false);
    replaceQuery("app", id);
  };

  const saveAddress = async (): Promise<boolean> => {
    if (!current) return false;
    setSavingAddress(true);
    setAddressError("");
    try {
      await api(`/api/apps/admin/address/${encodeURIComponent(current.id)}`, { method: "PUT", body: JSON.stringify({ url: address }) });
      setTested(false);
      await load().catch(() => undefined);
      return true;
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.addressSaveFailed"));
      return false;
    } finally {
      setSavingAddress(false);
    }
  };

  const generate = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const made = await api<{ secret: string }>(`/api/apps/admin/pairing/${encodeURIComponent(current.id)}`, { method: "POST" });
      setFresh({ app: current.id, secret: made.secret });
      setConfirm(null);
      setTested(false);
      await load().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.pairFailed"));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/apps/admin/pairing/${encodeURIComponent(current.id)}`, { method: "DELETE" });
      setFresh(null);
      setConfirm(null);
      await load().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.forgetFailed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard (an insecure LAN origin): the text can still be selected */
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      await load();
      setTested(true);
    } finally {
      setTesting(false);
    }
  };

  const head = (children?: ReactNode) => (
    <ControlSectionHead section="appsSetup" icon={<KeyRound size={30} />} iconClassName="blue" description={t("controlAdmin:apps.setup.description")}>
      {children}
    </ControlSectionHead>
  );

  if (!apps || !current) {
    return (
      <>
        {head()}
        {appsError && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{appsError}</MessageBox>}
        {!apps && !appsError && <p className="muted">{t("controlAdmin:ui.loading")}</p>}
      </>
    );
  }

  const name = appName(current.id);
  const shown = fresh && fresh.app === current.id ? fresh.secret : null;
  const fromEnvUrl = current.urlSource === "environment";
  const fromEnvSecret = current.secretSource === "environment";
  const setup = current.secretSource === "none" || !current.url || shown !== null;
  const health = healthOf(current);
  const helpHref = guideHref("apps");

  const appPicker = apps.length > 1 && (
    <SelectField
      label={t("controlAdmin:apps.appLabel")}
      hideLabel={!setup}
      compact={!setup}
      icon={<Box size={17} />}
      value={current.id}
      options={apps.map((app) => ({ value: app.id, label: appName(app.id) }))}
      onChange={choose}
    />
  );

  const containerPill = !current.server
    ? <span className="pairing-pill is-muted"><Info size={15} aria-hidden="true" />{t("controlAdmin:games.serverNotAsked")}</span>
    : current.server.ok
      ? <span className="pairing-pill is-ok"><CircleCheck size={15} aria-hidden="true" />{t("controlAdmin:games.serverVersion", { version: current.server.version ?? "—" })}</span>
      : <span className="pairing-pill is-warn"><AlertTriangle size={15} aria-hidden="true" />{current.server.error ?? t("controlAdmin:games.serverDown")}</span>;

  const testResult = tested && (
    health === "ok"
      ? <MessageBox tone="success" title={t("controlAdmin:apps.setup.testOkTitle")}>{t("controlAdmin:apps.setup.testOkBody", { app: name })}</MessageBox>
      : health === "refused"
        ? <MessageBox tone="error" title={t("controlAdmin:games.refusedTitle")}>{t("controlAdmin:apps.setup.testRefusedBody", { variable: current.variables.container })}</MessageBox>
        : <MessageBox tone="warning" title={t("controlAdmin:apps.setup.testFailedTitle")}>{current.reason ?? current.server?.error ?? t("controlAdmin:games.serverDown")}</MessageBox>
  );

  const backupsLink = !current.stateless && (
    <a href={backupHref(current.id)} onClick={(event) => followRoute(event, backupHref(current.id))}>{t("controlAdmin:apps.setup.backupsLink")}</a>
  );

  const dialogs = (
    <>
      {confirm === "replace" && (
        <ConfirmDialog
          title={t("controlAdmin:apps.setup.replaceTitle", { app: name })}
          confirmLabel={t("controlAdmin:apps.pairing.changeSecret")}
          busyLabel={t("controlAdmin:apps.setup.generating")}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void generate()}
          onCancel={() => setConfirm(null)}
        >
          {t("controlAdmin:apps.setup.replaceBody", { app: name, variable: current.variables.container })}
        </ConfirmDialog>
      )}
      {confirm === "forget" && (
        <ConfirmDialog
          title={t("controlAdmin:apps.setup.forgetTitle", { app: name })}
          confirmLabel={t("controlAdmin:apps.setup.forget")}
          busyLabel={t("controlAdmin:apps.setup.forgetting")}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void forget()}
          onCancel={() => setConfirm(null)}
        >
          {t("controlAdmin:apps.setup.forgetBody", { app: name })}
        </ConfirmDialog>
      )}
      {editingAddress && (
        <Modal
          title={t("controlAdmin:apps.pairing.changeAddressTitle", { app: name })}
          busy={savingAddress}
          onClose={() => setEditingAddress(false)}
          onSubmit={(event) => { event.preventDefault(); void saveAddress().then((saved) => { if (saved) setEditingAddress(false); }); }}
        >
          <Field label={t("controlAdmin:apps.setup.addressLabel")} value={address} onChange={setAddress} placeholder={current.exampleUrl} disabled={savingAddress} />
          <p className="muted pairing-hint">{t("controlAdmin:apps.setup.addressIntro")}</p>
          {addressError && <MessageBox tone="error" title={t("controlAdmin:apps.setup.addressSaveFailed")}>{addressError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setEditingAddress(false)} disabled={savingAddress}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={savingAddress || address.trim() === (current.url ?? "")}>
              {savingAddress ? t("controlAdmin:apps.setup.addressSaving") : t("controlAdmin:apps.setup.addressSave")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );

  // ── Setup: four steps, then test them ─────────────────────────────────────
  if (setup) {
    return (
      <>
        {head()}
        {appsError && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{appsError}</MessageBox>}
        {error && <MessageBox tone="error" title={t("controlAdmin:apps.setup.pairFailed")}>{error}</MessageBox>}
        <ol className="pairing-steps">
          {appPicker && (
            <PairingStep n={1} title={t("controlAdmin:apps.pairing.step1Title")} body={t("controlAdmin:apps.pairing.step1Body")}>
              {appPicker}
            </PairingStep>
          )}

          <PairingStep n={apps.length > 1 ? 2 : 1} icon={<Box size={26} />} title={t("controlAdmin:apps.setup.addressTitle")} body={t("controlAdmin:apps.pairing.step2Body")}>
            {fromEnvUrl ? (
              <MessageBox tone="info" title={t("controlAdmin:apps.setup.fromEnvironmentTitle")}>
                <code>{current.url ?? t("controlAdmin:apps.setup.addressUnset")}</code>{" "}
                <Trans i18nKey="apps.setup.addressFromEnvironmentBody" ns="controlAdmin" values={{ variable: current.variables.url }} components={{ code: <code /> }} />
              </MessageBox>
            ) : (
              <form className="pairing-address" onSubmit={(event) => { event.preventDefault(); void saveAddress(); }}>
                <Field label={t("controlAdmin:apps.setup.addressLabel")} value={address} onChange={setAddress} placeholder={current.exampleUrl} disabled={savingAddress} required={false} />
                <Button variant="secondary" type="submit" disabled={savingAddress || address.trim() === (current.url ?? "")}>
                  <Save size={16} aria-hidden="true" />
                  {savingAddress ? t("controlAdmin:apps.setup.addressSaving") : t("controlAdmin:apps.setup.addressSave")}
                </Button>
              </form>
            )}
            <div className="pairing-status-row">
              <Plug size={17} aria-hidden="true" />
              <strong>{t("controlAdmin:apps.card.container")}</strong>
              {containerPill}
            </div>
            {addressError && <MessageBox tone="error" title={t("controlAdmin:apps.setup.addressSaveFailed")}>{addressError}</MessageBox>}
            <p className="muted pairing-hint">{t("controlAdmin:apps.setup.addressIntro")} {backupsLink}</p>
          </PairingStep>

          <PairingStep n={apps.length > 1 ? 3 : 2} icon={<KeyRound size={26} />} title={t("controlAdmin:apps.setup.secretTitle")} body={t("controlAdmin:apps.pairing.step3Body")}>
            {fromEnvSecret ? (
              <MessageBox tone="info" title={t("controlAdmin:apps.setup.fromEnvironmentTitle")}>
                <Trans i18nKey="apps.setup.fromEnvironmentBody" ns="controlAdmin" values={{ variable: current.variables.secret }} components={{ code: <code /> }} />
              </MessageBox>
            ) : shown ? (
              <div className="pairing-secret-once">
                <MessageBox tone="warning" title={t("controlAdmin:apps.setup.shownOnce")}>{null}</MessageBox>
                <div className="pairing-secret-row">
                  <code className="pairing-secret-value">{shown}</code>
                  <Button variant="secondary" onClick={() => void copy(shown)}>
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {copied ? t("controlAdmin:games.copied") : t("controlAdmin:games.copy")}
                  </Button>
                </div>
              </div>
            ) : current.secretSource === "paired" ? (
              <p className="pairing-set"><CircleCheck size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.secretIsSet")}</p>
            ) : (
              <>
                <MessageBox tone="warning" title={t("controlAdmin:apps.setup.noSecret")}>{null}</MessageBox>
                <div>
                  <Button variant="primary" disabled={busy} onClick={() => void generate()}>
                    <Wand2 size={16} aria-hidden="true" />
                    {busy ? t("controlAdmin:apps.setup.generating") : t("controlAdmin:apps.setup.generate")}
                  </Button>
                </div>
              </>
            )}
            <p className="muted pairing-hint">{t("controlAdmin:apps.setup.secretIntro")}</p>
          </PairingStep>

          <PairingStep n={apps.length > 1 ? 4 : 3} icon={<Terminal size={26} />} title={t("controlAdmin:apps.setup.containerTitle", { app: name })} body={t("controlAdmin:apps.pairing.step4Body")}>
            <div className="pairing-variable">
              <code>{current.variables.container}</code>
              <span className="muted">
                {fromEnvSecret
                  ? t("controlAdmin:apps.setup.containerSameAsEnv", { variable: current.variables.secret })
                  : t("controlAdmin:apps.setup.containerSecret")}
              </span>
            </div>
            <p className="muted pairing-hint">{t("controlAdmin:apps.setup.containerIntro")}</p>
          </PairingStep>
        </ol>

        <div className="pairing-footer">
          <Button variant="primary" disabled={testing} onClick={() => void runTest()}>
            <RefreshCw size={16} aria-hidden="true" />
            {testing ? t("controlAdmin:apps.setup.testing") : t("controlAdmin:apps.setup.test")}
          </Button>
          <a className="pairing-help" href={helpHref} onClick={(event) => followRoute(event, helpHref)}>
            <CircleHelp size={17} aria-hidden="true" />
            {t("controlAdmin:apps.pairing.viewHelp")}
          </a>
        </div>
        {testResult}
        {dialogs}
      </>
    );
  }

  // ── Summary: paired ───────────────────────────────────────────────────────
  const pill = {
    ok: <span className="pairing-pill is-ok"><CircleCheck size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.state.paired")}</span>,
    down: <span className="pairing-pill is-warn"><AlertTriangle size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.state.down")}</span>,
    refused: <span className="pairing-pill is-danger"><XCircle size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.state.refused")}</span>,
    unchecked: <span className="pairing-pill is-muted"><Info size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.state.unchecked")}</span>
  }[health];
  const menuItems = [
    ...(!fromEnvUrl ? [{ key: "address", label: t("controlAdmin:apps.pairing.changeAddress"), icon: <Link2 size={16} />, onSelect: () => { setAddress(current.url ?? ""); setEditingAddress(true); } }] : []),
    ...(current.secretSource === "paired" ? [{ key: "forget", label: t("controlAdmin:apps.setup.forget"), icon: <XCircle size={16} />, danger: true, onSelect: () => setConfirm("forget") }] : [])
  ];
  const banner = {
    ok: <MessageBox tone="success" title={t("controlAdmin:apps.pairing.okTitle")}>{t("controlAdmin:apps.pairing.okBody", { app: name })}</MessageBox>,
    down: <MessageBox tone="warning" title={t("controlAdmin:apps.pairing.downTitle")}>{current.server?.error ?? current.reason ?? t("controlAdmin:games.serverDown")}</MessageBox>,
    refused: <MessageBox tone="error" title={t("controlAdmin:games.refusedTitle")}>{t("controlAdmin:apps.setup.testRefusedBody", { variable: current.variables.container })}</MessageBox>,
    unchecked: <MessageBox tone="info" title={t("controlAdmin:apps.pairing.uncheckedTitle")}>{current.reason ?? t("controlAdmin:apps.pairing.uncheckedBody")}</MessageBox>
  }[health];
  const containerState = current.secretAccepted === true ? "matches" : current.secretAccepted === false ? "refused" : "unchecked";

  return (
    <>
      {head(
        <div className="pairing-head-actions">
          {pill}
          <Button variant="secondary" disabled={testing} onClick={() => void runTest()}>
            <RefreshCw size={16} aria-hidden="true" />
            {testing ? t("controlAdmin:apps.setup.testing") : t("controlAdmin:apps.setup.test")}
          </Button>
          {!fromEnvSecret && (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirm("replace")}>
              <KeyRound size={16} aria-hidden="true" />
              {t("controlAdmin:apps.pairing.changeSecret")}
            </Button>
          )}
          {menuItems.length > 0 && <ActionMenu label={t("controlAdmin:apps.pairing.moreAria")} trigger="icon" items={menuItems} />}
        </div>
      )}
      {appsError && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{appsError}</MessageBox>}
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.setup.pairFailed")}>{error}</MessageBox>}
      {tested ? testResult : banner}

      <dl className="pairing-facts">
        <div>
          <dt><Box size={18} aria-hidden="true" />{t("controlAdmin:apps.pairing.factApp")}</dt>
          <dd>{appPicker || name}</dd>
        </div>
        <div>
          <dt><Plug size={18} aria-hidden="true" />{t("controlAdmin:apps.card.container")}</dt>
          <dd>{hostOf(current.url) ?? "—"}{current.server?.version && <small>{t("controlAdmin:apps.pairing.version", { version: current.server.version })}</small>}</dd>
        </div>
        <div>
          <dt><Link2 size={18} aria-hidden="true" />{t("controlAdmin:apps.setup.addressLabel")}</dt>
          <dd><code>{current.url ?? "—"}</code>{fromEnvUrl && <small>{t("controlAdmin:apps.pairing.fromVariable", { variable: current.variables.url })}</small>}</dd>
        </div>
        <div>
          <dt>{current.server?.ok ? <CircleCheck size={18} aria-hidden="true" className="is-ok" /> : <AlertTriangle size={18} aria-hidden="true" className="is-warn" />}{t("controlAdmin:apps.pairing.factConnection")}</dt>
          <dd>{!current.server
            ? t("controlAdmin:apps.pairing.connectionUnknown")
            : current.server.ok
              ? t("controlAdmin:apps.pairing.connectionOk", { ms: current.server.roundTripMs ?? "?" })
              : t("controlAdmin:apps.pairing.connectionDown")}</dd>
        </div>
      </dl>

      <div className="pairing-cards">
        <section className="pairing-card" aria-labelledby="pairing-secret">
          <header>
            <span className="pairing-card-icon" aria-hidden="true"><KeyRound size={20} /></span>
            <div>
              <h2 id="pairing-secret">{t("controlAdmin:apps.setup.secretTitle")}</h2>
              <p className="muted">{t("controlAdmin:apps.pairing.secretCardBody")}</p>
            </div>
          </header>
          {fromEnvSecret ? (
            <p className="pairing-set"><CircleCheck size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.fromVariable", { variable: current.variables.secret })}</p>
          ) : (
            <>
              <div className="pairing-masked" aria-label={t("controlAdmin:apps.pairing.secretHidden")}>••••••••••••••••••••</div>
              <p className="pairing-set"><CircleCheck size={16} aria-hidden="true" />{t("controlAdmin:apps.pairing.secretIsSet")}</p>
              {current.pairing && <p className="muted pairing-hint">{t("controlAdmin:apps.setup.pairedOn", { date: formatManagedDate(current.pairing.pairedAt), name: current.pairing.pairedBy ?? "—" })} {t("controlAdmin:apps.pairing.sealed")}</p>}
            </>
          )}
        </section>

        <section className="pairing-card" aria-labelledby="pairing-container">
          <header>
            <span className="pairing-card-icon" aria-hidden="true"><Terminal size={20} /></span>
            <div>
              <h2 id="pairing-container">{t("controlAdmin:apps.pairing.containerCardTitle")}</h2>
              <p className="muted">{t("controlAdmin:apps.pairing.containerCardBody")}</p>
            </div>
          </header>
          <div className="pairing-variable">
            <code>{current.variables.container}</code>
            <span className={`pairing-pill is-${containerState === "matches" ? "ok" : containerState === "refused" ? "danger" : "muted"}`}>
              {containerState === "matches" ? <CircleCheck size={15} aria-hidden="true" /> : containerState === "refused" ? <XCircle size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
              {t(`controlAdmin:apps.pairing.container.${containerState}`)}
            </span>
          </div>
          <p className="muted pairing-hint">{t(`controlAdmin:apps.pairing.container.${containerState}Body`, { variable: current.variables.container })}</p>
        </section>
      </div>

      <section className="pairing-about" aria-labelledby="pairing-about">
        <Info size={22} aria-hidden="true" />
        <div>
          <h2 id="pairing-about">{t("controlAdmin:apps.pairing.aboutTitle")}</h2>
          <p className="muted">{t("controlAdmin:apps.pairing.aboutBody")} {backupsLink}</p>
        </div>
        <a href={helpHref} onClick={(event) => followRoute(event, helpHref)}>
          <ExternalLink size={16} aria-hidden="true" />
          {t("controlAdmin:apps.pairing.learnMore")}
        </a>
      </section>
      {dialogs}
    </>
  );
}

/** One numbered step of Setup: what it is on the left, its controls on the right. */
function PairingStep({ n, icon, title, body, children }: { n: number; icon?: ReactNode; title: string; body: string; children: ReactNode }) {
  return (
    <li className="pairing-step">
      <div className="pairing-step-about">
        <span className="pairing-step-n" aria-hidden="true">{n}</span>
        <div>
          <h2>{title}</h2>
          <p className="muted">{body}</p>
          {icon && <span className="pairing-step-icon" aria-hidden="true">{icon}</span>}
        </div>
      </div>
      <div className="pairing-step-body">{children}</div>
    </li>
  );
}
