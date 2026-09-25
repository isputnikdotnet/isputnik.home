import { useState, type FormEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Fingerprint, KeyRound, LockOpen, MonitorSmartphone, MonitorX, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import type { ActionMenuItem } from "../../../shared/ActionMenu";
import type { ManagedUser } from "../types";

// The occasional things an admin does to one account — a new password, a
// two-factor or passkey reset, an hour of remote device linking, a lockout
// cleared, the account deleted — as one set of menu items and the dialogs they
// open. The Users list puts them in each row's ⋮ menu; a member's page puts the
// same ones in its header, so the two never drift apart.

// Mirrors MIN/MAX/DEFAULT_WINDOW_MINUTES in the server's core/device-link.ts. This
// is the shape of the control, not the enforcement — the server clamps whatever
// arrives, because a number typed into a form is client input like any other.
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 60;
const DEFAULT_WINDOW_MINUTES = 60;

export function useUserActions({ currentUserId, onChanged, onDeleted, onError }: {
  currentUserId: string;
  /** The account changed in a way a list or header shows: reload it. */
  onChanged: () => Promise<void> | void;
  /** The account is gone; the caller decides where to go. */
  onDeleted?: (account: ManagedUser) => void;
  /** An action with no dialog of its own failed (unlock, cancelling a window). */
  onError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [modalError, setModalError] = useState("");

  const [passwordUser, setPasswordUser] = useState<ManagedUser | null>(null);
  const [password, setPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [pendingMfaReset, setPendingMfaReset] = useState<ManagedUser | null>(null);
  const [resettingMfa, setResettingMfa] = useState(false);

  const [pendingPasskeyReset, setPendingPasskeyReset] = useState<ManagedUser | null>(null);
  const [resettingPasskeys, setResettingPasskeys] = useState(false);

  const [unlockingId, setUnlockingId] = useState<string | null>(null);

  const [pendingWindow, setPendingWindow] = useState<ManagedUser | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(String(DEFAULT_WINDOW_MINUTES));
  const [openingWindow, setOpeningWindow] = useState(false);
  const [closingWindowId, setClosingWindowId] = useState<string | null>(null);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordUser) return;
    setChangingPassword(true);
    setModalError("");
    try {
      await api(`/api/users/${passwordUser.id}/password`, { method: "PATCH", body: JSON.stringify({ password }) });
      setPasswordUser(null);
      await onChanged();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.pwFailed"));
    } finally {
      setChangingPassword(false);
    }
  };

  const deleteUser = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setModalError("");
    try {
      await api(`/api/users/${pendingDelete.id}`, { method: "DELETE" });
      const account = pendingDelete;
      setPendingDelete(null);
      if (onDeleted) onDeleted(account);
      else await onChanged();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  // Linking a device is refused from outside the house and the app doesn't offer
  // it there. This turns it on for one person, for an hour, for one device — after
  // which it closes itself. There is no way to leave one open.
  const openWindow = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingWindow) return;
    setOpeningWindow(true);
    setModalError("");
    try {
      await api(`/api/users/${pendingWindow.id}/device-link-window`, { method: "POST", body: JSON.stringify({ minutes: Number(windowMinutes) }) });
      setPendingWindow(null);
      await onChanged();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.allowFailed"));
    } finally {
      setOpeningWindow(false);
    }
  };

  const closeWindow = async (account: ManagedUser) => {
    setClosingWindowId(account.id);
    try {
      await api(`/api/users/${account.id}/device-link-window`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("controlAdmin:users.cancelWindowFailed"));
    } finally {
      setClosingWindowId(null);
    }
  };

  const resetMfa = async () => {
    if (!pendingMfaReset) return;
    setResettingMfa(true);
    setModalError("");
    try {
      await api(`/api/users/${pendingMfaReset.id}/mfa/reset`, { method: "POST" });
      setPendingMfaReset(null);
      await onChanged();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.resetMfaFailed"));
    } finally {
      setResettingMfa(false);
    }
  };

  const resetPasskeys = async () => {
    if (!pendingPasskeyReset) return;
    setResettingPasskeys(true);
    setModalError("");
    try {
      await api(`/api/users/${pendingPasskeyReset.id}/passkeys/reset`, { method: "POST" });
      setPendingPasskeyReset(null);
      await onChanged();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.removePasskeysFailed"));
    } finally {
      setResettingPasskeys(false);
    }
  };

  const unlockUser = async (account: ManagedUser) => {
    setUnlockingId(account.id);
    try {
      await api(`/api/users/${account.id}/unlock`, { method: "POST" });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("controlAdmin:users.unlockFailed"));
    } finally {
      setUnlockingId(null);
    }
  };

  const canDelete = (account: ManagedUser) => !account.protectedFromDelete && account.id !== currentUserId;

  /** Delete, on its own: a member's page keeps it apart in a danger zone. */
  const askDelete = (account: ManagedUser) => {
    setModalError("");
    setPendingDelete(account);
  };

  /** The menu, less Delete when the caller shows it elsewhere. */
  const menuItems = (account: ManagedUser, { withDelete = true }: { withDelete?: boolean } = {}): ActionMenuItem[] => [
    {
      key: "password",
      label: t("controlAdmin:users.changePassword"),
      icon: <KeyRound size={15} />,
      onSelect: () => {
        setModalError("");
        setPasswordUser(account);
        setPassword("");
      }
    },
    {
      key: "mfa",
      label: account.mfaEnabled
        ? (account.mfaMethod === "email" ? t("controlAdmin:users.resetMfaEmail") : t("controlAdmin:users.resetMfaApp"))
        : t("controlAdmin:users.resetMfa"),
      icon: <ShieldOff size={15} />,
      disabledReason: account.mfaEnabled ? undefined : t("controlAdmin:users.noMfa"),
      onSelect: () => {
        setModalError("");
        setPendingMfaReset(account);
      }
    },
    {
      key: "passkeys",
      label: account.passkeyCount > 0
        ? t("controlAdmin:users.removePasskeysCount", { count: account.passkeyCount })
        : t("controlAdmin:users.removePasskeys"),
      icon: <Fingerprint size={15} />,
      disabledReason: account.passkeyCount > 0 ? undefined : t("controlAdmin:users.noPasskeys"),
      onSelect: () => {
        setModalError("");
        setPendingPasskeyReset(account);
      }
    },
    account.deviceLinkWindowExpiresAt
      ? {
          key: "device-window",
          label: t("controlAdmin:users.cancelRemoteLinking"),
          icon: <MonitorX size={15} />,
          danger: true,
          disabledReason: closingWindowId === account.id ? t("controlAdmin:users.cancelling") : undefined,
          onSelect: () => closeWindow(account)
        }
      : {
          key: "device-window",
          label: t("controlAdmin:users.allowDeviceOutside"),
          icon: <MonitorSmartphone size={15} />,
          disabledReason: account.isActive ? undefined : t("controlAdmin:users.deactivated"),
          onSelect: () => {
            setModalError("");
            setWindowMinutes(String(DEFAULT_WINDOW_MINUTES));
            setPendingWindow(account);
          }
        },
    {
      key: "unlock",
      label: t("controlAdmin:users.clearLockout"),
      icon: <LockOpen size={15} />,
      // Never disabled on the "Locked" badge: that badge is computed when the
      // list is fetched, from failures inside a window that keeps sliding, so it
      // is stale the moment after it loads and goes false on its own well before
      // an admin looking at this page believes it has. Clearing an account that
      // isn't locked costs nothing.
      disabledReason: unlockingId === account.id ? t("controlAdmin:users.clearing") : undefined,
      onSelect: () => unlockUser(account)
    },
    ...(withDelete ? [{
      key: "delete",
      label: t("controlAdmin:users.deleteUser"),
      icon: <Trash2 size={15} />,
      danger: true,
      disabledReason: canDelete(account) ? undefined : t("controlAdmin:users.cannotDelete"),
      onSelect: () => askDelete(account)
    }] : [])
  ];

  const dialogs: ReactNode = (
    <>
      {passwordUser && (
        <Modal
          title={t("controlAdmin:users.pwTitle", { name: passwordUser.displayName })}
          className="user-form-modal"
          busy={changingPassword}
          onClose={() => setPasswordUser(null)}
          onSubmit={changePassword}
        >
          <Field
            label={t("controlAdmin:users.newPassword")}
            type="password"
            minLength={8}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          {modalError && <MessageBox tone="error" title={t("controlAdmin:users.pwFailed")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPasswordUser(null)} disabled={changingPassword} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={changingPassword || password.length < 8}>
              <ShieldCheck size={15} />
              {changingPassword ? t("controlAdmin:users.changing") : t("controlAdmin:users.changePassword")}
            </Button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("controlAdmin:users.deleteTitle", { name: pendingDelete.displayName })}
          confirmLabel={t("controlAdmin:users.deleteUser")}
          busyLabel={t("controlAdmin:users.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteUser}
          onCancel={() => setPendingDelete(null)}
        >
          <p>{t("controlAdmin:users.deleteBody1")}</p>
          <p><strong>{t("controlAdmin:users.deleteBody2")}</strong></p>
        </ConfirmDialog>
      )}

      {/* A Modal rather than a ConfirmDialog now that it collects something: the
          confirmation primitive answers yes/no, and this asks "how long". */}
      {pendingWindow && (
        <Modal
          variant="card"
          title={t("controlAdmin:users.windowTitle", { name: pendingWindow.displayName })}
          busy={openingWindow}
          onClose={() => setPendingWindow(null)}
          onSubmit={openWindow}
        >
          <p className="section-description">{t("controlAdmin:users.windowIntro")}</p>
          <Field
            label={t("controlAdmin:users.minutes")}
            type="number"
            value={windowMinutes}
            onChange={setWindowMinutes}
            min={MIN_WINDOW_MINUTES}
            max={MAX_WINDOW_MINUTES}
          />
          <p className="section-description">
            {t("controlAdmin:users.windowRange", { min: MIN_WINDOW_MINUTES, max: MAX_WINDOW_MINUTES })}
          </p>
          <p className="section-description">
            <Trans i18nKey="users.windowNote" ns="controlAdmin" components={{ bold: <strong /> }} />
          </p>
          {modalError && <MessageBox tone="error" title={t("controlAdmin:users.allowFailed")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPendingWindow(null)} disabled={openingWindow}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={openingWindow}>
              <MonitorSmartphone size={15} />
              {openingWindow ? t("controlAdmin:users.allowing") : t("controlAdmin:users.allowFor", { count: windowMinutes })}
            </Button>
          </div>
        </Modal>
      )}

      {pendingMfaReset && (
        <ConfirmDialog
          title={t("controlAdmin:users.mfaTitle", { name: pendingMfaReset.displayName })}
          confirmLabel={t("controlAdmin:users.mfaConfirm")}
          busyLabel={t("controlAdmin:users.resetting")}
          confirmIcon={<ShieldOff size={15} />}
          danger
          rich
          busy={resettingMfa}
          error={modalError}
          onConfirm={resetMfa}
          onCancel={() => setPendingMfaReset(null)}
        >
          <p>
            {pendingMfaReset.mfaMethod === "email" ? t("controlAdmin:users.mfaBodyEmail") : t("controlAdmin:users.mfaBodyApp")}
          </p>
          <p><strong>{t("controlAdmin:users.mfaBodyBold")}</strong></p>
        </ConfirmDialog>
      )}

      {pendingPasskeyReset && (
        <ConfirmDialog
          title={t("controlAdmin:users.pkTitle", { name: pendingPasskeyReset.displayName })}
          confirmLabel={t("controlAdmin:users.pkConfirm")}
          busyLabel={t("controlAdmin:users.removing")}
          confirmIcon={<Fingerprint size={15} />}
          danger
          rich
          busy={resettingPasskeys}
          error={modalError}
          onConfirm={resetPasskeys}
          onCancel={() => setPendingPasskeyReset(null)}
        >
          <p>{t("controlAdmin:users.pkBody", { count: pendingPasskeyReset.passkeyCount })}</p>
          <p><strong>{t("controlAdmin:users.pkBodyBold")}</strong></p>
        </ConfirmDialog>
      )}
    </>
  );

  return { menuItems, dialogs, askDelete, canDelete };
}
