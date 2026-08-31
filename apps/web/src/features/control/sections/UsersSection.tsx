import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Fingerprint, KeyRound, LockOpen, MonitorSmartphone, MonitorX, Pencil, Plus, Search, ShieldCheck, ShieldOff, Trash2, User, Users } from "lucide-react";
import i18n from "../../../i18n";
import { api, type PublicUser } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { ActionMenu } from "../../../shared/ActionMenu";
import { RefreshButton } from "../../../shared/RefreshButton";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedUser } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";

type UserRole = "admin" | "member";

function roleLabel(role: UserRole): string {
  return role === "admin" ? i18n.t("controlAdmin:users.roleAdmin") : i18n.t("controlAdmin:users.roleMember");
}

function formatSessionCount(value: number) {
  return i18n.t("controlAdmin:ui.sessions", { count: value });
}

/** Whole minutes until an ISO instant, floored at zero. Read off a badge, so a
 *  rounded number beats a ticking clock — the list is not a countdown timer. */
function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
}

// Mirrors MIN/MAX/DEFAULT_WINDOW_MINUTES in the server's core/device-link.ts. This
// is the shape of the control, not the enforcement — the server clamps whatever
// arrives, because a number typed into a form is client input like any other.
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 60;
const DEFAULT_WINDOW_MINUTES = 60;

export function UsersSection({ currentUser }: { currentUser: PublicUser }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("member");
  const [creating, setCreating] = useState(false);

  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("member");
  const [saving, setSaving] = useState(false);

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

  const loadUsers = useCallback(async () => {
    const payload = await api<{ users: ManagedUser[] }>("/api/users");
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    loadUsers().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:users.loadFailed")));
  }, [loadUsers, t]);

  const visibleUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((account) => [
      account.displayName,
      account.email,
      roleLabel(account.role),
      account.protectedFromDelete ? "protected" : "",
      account.id === currentUser.id ? "current" : ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [currentUser.id, searchQuery, users]);

  const openCreate = () => {
    setError("");
    setNotice("");
    setModalError("");
    setNewDisplayName("");
    setNewEmail("");
    setNewPassword("");
    setNewRole("member");
    setCreateOpen(true);
  };

  const openEdit = (account: ManagedUser) => {
    setError("");
    setModalError("");
    setEditingUser(account);
    setEditDisplayName(account.displayName);
    setEditEmail(account.email);
    setEditRole(account.role);
  };

  const openPassword = (account: ManagedUser) => {
    setError("");
    setModalError("");
    setPasswordUser(account);
    setPassword("");
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setModalError("");
    try {
      const result = await api<{ restored?: boolean }>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          displayName: newDisplayName,
          email: newEmail,
          password: newPassword,
          role: newRole
        })
      });
      // The address belonged to a deleted account, so this took that account's place
      // rather than making a second one. Say so — what came back with it is not
      // obvious, and the admin is the one who has to tell the new user.
      setNotice(
        result.restored
          ? t("controlAdmin:users.restoredNotice", { name: newDisplayName })
          : ""
      );
      setCreateOpen(false);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const saveUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingUser) return;

    setSaving(true);
    setModalError("");
    try {
      await api(`/api/users/${editingUser.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editDisplayName,
          email: editEmail,
          role: editRole
        })
      });
      setEditingUser(null);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.saveUserFailed"));
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordUser) return;

    setChangingPassword(true);
    setModalError("");
    try {
      await api(`/api/users/${passwordUser.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password })
      });
      setPasswordUser(null);
      await loadUsers();
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
      setPendingDelete(null);
      await loadUsers();
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
      await api(`/api/users/${pendingWindow.id}/device-link-window`, {
        method: "POST",
        body: JSON.stringify({ minutes: Number(windowMinutes) })
      });
      setPendingWindow(null);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.allowFailed"));
    } finally {
      setOpeningWindow(false);
    }
  };

  const closeWindow = async (account: ManagedUser) => {
    setClosingWindowId(account.id);
    setError("");
    try {
      await api(`/api/users/${account.id}/device-link-window`, { method: "DELETE" });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:users.cancelWindowFailed"));
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
      await loadUsers();
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
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.removePasskeysFailed"));
    } finally {
      setResettingPasskeys(false);
    }
  };

  const unlockUser = async (account: ManagedUser) => {
    setUnlockingId(account.id);
    setError("");
    try {
      await api(`/api/users/${account.id}/unlock`, { method: "POST" });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:users.unlockFailed"));
    } finally {
      setUnlockingId(null);
    }
  };

  const roleLocked = editingUser ? editingUser.protectedFromDelete || editingUser.id === currentUser.id : false;

  return (
    <>
      <ControlSectionHead
        section="users"
        icon={<Users size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:users.headDescription")}
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadUsers();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:users.refreshFailed"));
                throw err;
              }
            }}
          />
          <Button variant="primary" onClick={openCreate} title={t("controlAdmin:users.newUser")}>
            <Plus size={18} />
            <span>{t("controlAdmin:users.newUser")}</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:users.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="info" title={t("controlAdmin:users.reusedTitle")}>{notice}</MessageBox>}

      <div className="user-controls-bar">
        <label className="search-field user-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">{t("controlAdmin:users.searchUsers")}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("controlAdmin:users.searchPlaceholder")}
          />
        </label>
      </div>

      {visibleUsers.length === 0 ? (
        <p className="management-empty">
          {users.length === 0 ? t("controlAdmin:users.noUsers") : t("controlAdmin:users.noMatch")}
        </p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid user-table">
            <thead>
              <tr>
                <th>{t("controlAdmin:users.thUser")}</th>
                <th>{t("controlAdmin:users.thRole")}</th>
                <th className="col-num">{t("controlAdmin:users.thSessions")}</th>
                <th>{t("controlAdmin:users.thCreated")}</th>
                {/* The word is wider than the column now that the column holds one
                    ⋮ button, and in a fixed-layout table a heading that doesn't fit
                    puts the whole grid into a horizontal scroll. Kept for screen
                    readers, which is the only audience it was serving anyway. */}
                <th className="col-actions"><span className="sr-only">{t("controlAdmin:users.thActions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((account) => {
                const isCurrent = account.id === currentUser.id;
                const deleteDisabled = account.protectedFromDelete || isCurrent;
                return (
                  <tr key={account.id}>
                    <td>
                      <div className="user-account-cell">
                        <span className="user-avatar-icon" aria-hidden="true">
                          <User size={20} />
                        </span>
                        <div className="datagrid-primary">
                          <span className="user-name-line">
                            <strong>{account.displayName}</strong>
                            {isCurrent && <span className="status-badge current">{t("controlAdmin:users.badgeCurrent")}</span>}
                            {account.protectedFromDelete && <span className="status-badge protected">{t("controlAdmin:users.badgeProtected")}</span>}
                            {account.locked && <span className="status-badge locked">{t("controlAdmin:users.badgeLocked")}</span>}
                            {/* Only ever visible for the hour it is open, which is
                                the whole design: there is no lasting state here to
                                forget about. */}
                            {account.deviceLinkWindowExpiresAt && (
                              <span className="status-badge device-window">
                                {t("controlAdmin:users.remoteLinking", { count: minutesLeft(account.deviceLinkWindowExpiresAt) })}
                              </span>
                            )}
                          </span>
                          <small>{account.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${account.role}`}>{roleLabel(account.role)}</span>
                    </td>
                    <td className="col-num datagrid-muted">{formatSessionCount(account.activeSessions)}</td>
                    <td className="datagrid-muted">{formatManagedDate(account.createdAt)}</td>
                    <td className="col-actions">
                      {/* One menu rather than seven icon buttons. Everything here is
                          occasional — nothing is reached for often enough to earn a
                          permanent square — and as icons their meaning lived in
                          tooltips. In the menu each one gets its name back, and the
                          reason an unavailable action is unavailable is its tooltip
                          rather than a mystery grey glyph. */}
                      <div className="row-actions">
                        <ActionMenu
                          trigger="icon"
                          label={t("controlAdmin:users.manageAria", { name: account.displayName })}
                          items={[
                            {
                              key: "edit",
                              label: t("controlAdmin:users.editUser"),
                              icon: <Pencil size={15} />,
                              onSelect: () => openEdit(account)
                            },
                            {
                              key: "password",
                              label: t("controlAdmin:users.changePassword"),
                              icon: <KeyRound size={15} />,
                              onSelect: () => openPassword(account)
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
                              // Never disabled on the "Locked" badge: that badge is
                              // computed when the list is fetched, from failures inside
                              // a window that keeps sliding, so it is stale the moment
                              // after it loads and goes false on its own well before an
                              // admin looking at this page believes it has. Clearing an
                              // account that isn't locked costs nothing.
                              disabledReason: unlockingId === account.id ? t("controlAdmin:users.clearing") : undefined,
                              onSelect: () => unlockUser(account)
                            },
                            {
                              key: "delete",
                              label: t("controlAdmin:users.deleteUser"),
                              icon: <Trash2 size={15} />,
                              danger: true,
                              disabledReason: deleteDisabled ? t("controlAdmin:users.cannotDelete") : undefined,
                              onSelect: () => {
                                setModalError("");
                                setPendingDelete(account);
                              }
                            }
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <Modal
          title={t("controlAdmin:users.createUser")}
          className="user-form-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={createUser}
        >
          <Field label={t("controlAdmin:users.displayName")} value={newDisplayName} onChange={setNewDisplayName} autoComplete="name" />
          <Field label={t("common.email")} type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
          <Field
            label={t("common.password")}
            type="password"
            minLength={8}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <label className="field">
            <span>{t("controlAdmin:users.role")}</span>
            <select value={newRole} onChange={(event) => setNewRole(event.target.value as UserRole)}>
              <option value="member">{t("controlAdmin:users.roleMember")}</option>
              <option value="admin">{t("controlAdmin:users.roleAdmin")}</option>
            </select>
          </label>
          {modalError && <MessageBox tone="error" title={t("controlAdmin:users.createFailed")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating || !newDisplayName.trim() || !newEmail.trim() || newPassword.length < 8}
            >
              {creating ? t("controlAdmin:users.creating") : t("controlAdmin:users.createUser")}
            </Button>
          </div>
        </Modal>
      )}

      {editingUser && (
        <Modal
          title={t("controlAdmin:users.editTitle", { name: editingUser.displayName })}
          className="user-form-modal"
          busy={saving}
          onClose={() => setEditingUser(null)}
          onSubmit={saveUser}
        >
          <Field label={t("controlAdmin:users.displayName")} value={editDisplayName} onChange={setEditDisplayName} autoComplete="name" />
          <Field label={t("common.email")} type="email" value={editEmail} onChange={setEditEmail} autoComplete="email" />
          <label className="field">
            <span>{t("controlAdmin:users.role")}</span>
            <select
              value={editRole}
              disabled={roleLocked}
              onChange={(event) => setEditRole(event.target.value as UserRole)}
            >
              <option value="member">{t("controlAdmin:users.roleMember")}</option>
              <option value="admin">{t("controlAdmin:users.roleAdmin")}</option>
            </select>
          </label>
          {roleLocked && (
            <MessageBox tone="info" title={t("controlAdmin:users.roleLockedTitle")}>
              {t("controlAdmin:users.roleLockedBody")}
            </MessageBox>
          )}
          {modalError && <MessageBox tone="error" title={t("controlAdmin:users.saveUserFailed")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setEditingUser(null)} disabled={saving} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !editDisplayName.trim() || !editEmail.trim()}>
              {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:users.saveChanges")}
            </Button>
          </div>
        </Modal>
      )}

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
          <p className="section-description">
            {t("controlAdmin:users.windowIntro")}
          </p>
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
          <p>
            {t("controlAdmin:users.pkBody", { count: pendingPasskeyReset.passkeyCount })}
          </p>
          <p><strong>{t("controlAdmin:users.pkBodyBold")}</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
