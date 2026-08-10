import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
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
      setLoadError(err instanceof Error ? err.message : "Unable to load passkeys");
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
          ? "That was cancelled before your device finished. Try again."
          : err instanceof Error
            ? err.message
            : "Unable to add a passkey"
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
      setError(err instanceof Error ? err.message : "Unable to remove the passkey");
    } finally {
      setRemoving(false);
    }
  };

  const passkeys = status?.passkeys ?? [];

  return (
    <section className="passkeys-section" aria-labelledby="passkeys-heading">
      <h2 id="passkeys-heading">Passkeys</h2>
      <p className="passkeys-intro">
        Sign in with your fingerprint, face or device PIN instead of typing a password. The key itself never leaves
        your device, so there's nothing to steal or phish — and because your device checks it's you, no one-time code
        is needed either.
      </p>

      {loadError && <MessageBox tone="error" title="Unable to load">{loadError}</MessageBox>}
      {error && <MessageBox tone="error" title="Passkeys">{error}</MessageBox>}

      {/* Why the feature is missing rather than simply hiding it: an operator seeing
          this is being told what to change, and a member is being told who to ask. */}
      {status && !status.available ? (
        <MessageBox tone="info" title="Passkeys aren't available on this server">
          They need the server to be reached over HTTPS at a domain name — an address like
          <code> https://library.example.com</code>. On a home network reached by IP address, browsers won't allow
          them at all. Your administrator can set this up.
        </MessageBox>
      ) : status && !supported ? (
        <MessageBox tone="info" title="This browser can't use passkeys">
          Try a current version of Safari, Chrome, Edge or Firefox.
        </MessageBox>
      ) : (
        status && (
          <>
            <div className="passkeys-actions">
              <Button variant="primary" onClick={openAdd}>
                <KeyRound size={16} /> Add passkey
              </Button>
            </div>

            <div className="passkey-list">
              {passkeys.length === 0 ? (
                <p className="passkeys-intro">No passkeys yet. Add one for the device you use most.</p>
              ) : (
                passkeys.map((passkey) => (
                  <div className="passkey-row" key={passkey.id}>
                    <span className="passkey-icon" aria-hidden="true"><KeyRound size={18} /></span>
                    <div className="passkey-meta">
                      <strong>{passkey.label || "Passkey"}</strong>
                      <span className="passkeys-intro">
                        Added {new Date(passkey.createdAt).toLocaleDateString()}
                        {passkey.lastUsed
                          ? ` · last used ${new Date(passkey.lastUsed).toLocaleDateString()}`
                          : " · never used"}
                        {passkey.backedUp ? "" : " · this device only"}
                      </span>
                    </div>
                    <Button
                      variant="icon"
                      danger
                      title="Remove passkey"
                      aria-label={`Remove ${passkey.label || "passkey"}`}
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
        <Modal variant="card" title="Add a passkey" busy={adding} onClose={closeAdd} onSubmit={add}>
          <p className="passkeys-intro">
            Confirm your password, then your device will ask for your fingerprint, face or PIN.
          </p>
          <Field
            label="Current password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Field
            label="Name this device"
            value={label}
            onChange={setLabel}
            placeholder="e.g. iPhone"
            required={false}
          />
          {addError && <MessageBox tone="error" title="Unable to add a passkey">{addError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={closeAdd} disabled={adding}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={adding}>
              {adding ? "Waiting for your device…" : "Add passkey"}
            </Button>
          </div>
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={`Remove "${pendingRemove.label || "Passkey"}"?`}
          confirmLabel="Remove passkey"
          busyLabel="Removing…"
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          That device won't be able to sign in with a passkey any more. Your password and two-factor sign-in still
          work, and your other passkeys are not affected.
        </ConfirmDialog>
      )}
    </section>
  );
}
