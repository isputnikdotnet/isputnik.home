import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";

interface Passkey {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsed: string | null;
  /** Whether the credential syncs to a keychain. A device-bound one dies with the
   *  device, which is worth saying while there's still time to add another. */
  backedUp: boolean;
}

interface PasskeyStatus {
  available: boolean;
  passkeys: Passkey[];
}

export function PasskeysSection() {
  const { t } = useTranslation(["common", "misc"]);
  const [status, setStatus] = useState<PasskeyStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [pendingRemove, setPendingRemove] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState(false);

  const supported = browserSupportsWebAuthn();

  const refresh = async () => {
    try {
      setStatus(await api<PasskeyStatus>("/api/profile/passkeys"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("misc:passkeys.unableToLoadFallback"));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openAdd = () => {
    setPassword("");
    setLabel("");
    setAddError("");
    setAddOpen(true);
  };

  const closeAdd = () => {
    setAddOpen(false);
    setPassword("");
    setLabel("");
    setAddError("");
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      // Step 1: prove the password and collect the ceremony options.
      const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        "/api/profile/passkeys/options",
        { method: "POST", body: JSON.stringify({ currentPassword: password }) }
      );
      // Step 2: the browser prompts for the fingerprint / face / PIN.
      const response = await startRegistration({ optionsJSON: options });
      // Step 3: the server verifies the attestation and stores the public key.
      await api("/api/profile/passkeys", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || undefined, response })
      });
      closeAdd();
      await refresh();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      setAddError(
        name === "NotAllowedError" || name === "AbortError"
          ? t("misc:passkeys.cancelledRetry")
          : err instanceof Error
            ? err.message
            : t("misc:passkeys.unableToAdd")
      );
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    setError("");
    try {
      await api(`/api/profile/passkeys/${pendingRemove.id}`, { method: "DELETE" });
      setPendingRemove(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("misc:passkeys.unableToRemove"));
    } finally {
      setRemoving(false);
    }
  };

  const passkeys = status?.passkeys ?? [];

  return (
    <section className="passkeys-section" aria-labelledby="passkeys-heading">
      <h2 id="passkeys-heading">{t("misc:passkeys.heading")}</h2>
      <p className="passkeys-intro">
        {t("misc:passkeys.intro")}
      </p>

      {loadError && <MessageBox tone="error" title={t("misc:common.unableToLoad")}>{loadError}</MessageBox>}
      {error && <MessageBox tone="error" title={t("misc:passkeys.genericErrorTitle")}>{error}</MessageBox>}

      {/* Why the feature is missing rather than simply hiding it: an operator seeing
          this is being told what to change, and a member is being told who to ask. */}
      {status && !status.available ? (
        <MessageBox tone="info" title={t("misc:passkeys.notAvailableTitle")}>
          <Trans i18nKey="passkeys.notAvailableBody" ns="misc" components={{ code: <code /> }} />
        </MessageBox>
      ) : status && !supported ? (
        <MessageBox tone="info" title={t("misc:passkeys.unsupportedTitle")}>
          {t("misc:passkeys.unsupportedBody")}
        </MessageBox>
      ) : (
        status && (
          <>
            <div className="passkeys-actions">
              <Button variant="primary" onClick={openAdd}>
                <KeyRound size={16} /> {t("misc:passkeys.addButton")}
              </Button>
            </div>

            <div className="passkey-list">
              {passkeys.length === 0 ? (
                <p className="passkeys-intro">{t("misc:passkeys.emptyList")}</p>
              ) : (
                passkeys.map((passkey) => (
                  <div className="passkey-row" key={passkey.id}>
                    <span className="passkey-icon" aria-hidden="true"><KeyRound size={18} /></span>
                    <div className="passkey-meta">
                      <strong>{passkey.label || t("misc:passkeys.defaultLabel")}</strong>
                      <span className="passkeys-intro">
                        {t("misc:passkeys.metaAdded", { date: new Date(passkey.createdAt).toLocaleDateString() })}
                        {passkey.lastUsed
                          ? t("misc:passkeys.metaLastUsed", { date: new Date(passkey.lastUsed).toLocaleDateString() })
                          : t("misc:passkeys.metaNeverUsed")}
                        {passkey.backedUp ? "" : t("misc:passkeys.metaDeviceOnly")}
                      </span>
                    </div>
                    <Button
                      variant="icon"
                      danger
                      title={t("misc:passkeys.removeTitle")}
                      aria-label={t("misc:passkeys.removeAria", { label: passkey.label || t("misc:passkeys.defaultLabel") })}
                      onClick={() => setPendingRemove(passkey)}
                    >
                      <Trash2 size={18} />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )
      )}

      {addOpen && (
        <Modal variant="card" title={t("misc:passkeys.addModalTitle")} busy={adding} onClose={closeAdd} onSubmit={add}>
          <p className="passkeys-intro">
            {t("misc:passkeys.addModalIntro")}
          </p>
          <Field
            label={t("misc:common.currentPassword")}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Field
            label={t("misc:passkeys.nameDeviceLabel")}
            value={label}
            onChange={setLabel}
            placeholder={t("misc:passkeys.nameDevicePlaceholder")}
            required={false}
          />
          {addError && <MessageBox tone="error" title={t("misc:passkeys.addErrorTitle")}>{addError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={closeAdd} disabled={adding}>{t("common:common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={adding}>
              {adding ? t("misc:passkeys.waitingBusy") : t("misc:passkeys.addButton")}
            </Button>
          </div>
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t("misc:passkeys.confirmRemoveTitle", { label: pendingRemove.label || t("misc:passkeys.defaultLabel") })}
          confirmLabel={t("misc:passkeys.removeTitle")}
          busyLabel={t("misc:passkeys.confirmRemoveBusy")}
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          {t("misc:passkeys.confirmRemoveBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
