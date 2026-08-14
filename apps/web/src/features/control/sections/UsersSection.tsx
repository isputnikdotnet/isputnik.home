import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Fingerprint, KeyRound, LockOpen, MonitorSmartphone, MonitorX, Pencil, Plus, Search, ShieldCheck, ShieldOff, Trash2, User, Users } from "lucide-react";
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

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin",
  member: "Member"
};

function formatSessionCount(value: number) {
  return `${value.toLocaleString()} ${value === 1 ? "session" : "sessions"}`;
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
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
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
    loadUsers().catch((err) => setError(err instanceof Error ? err.message : "Unable to load users"));
  }, [loadUsers]);

  const visibleUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((account) => [
      account.displayName,
      account.email,
      ROLE_LABEL[account.role],
      account.protectedFromDelete ? "protected" : "",
      account.id === currentUser.id ? "current" : ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [currentUser.id, searchQuery, users]);

  const openCreate = () => {
    setError("");
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
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          displayName: newDisplayName,
          email: newEmail,
          password: newPassword,
          role: newRole
        })
      });
      setCreateOpen(false);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to create user");
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
      setModalError(err instanceof Error ? err.message : "Unable to save user");
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
      setModalError(err instanceof Error ? err.message : "Unable to change password");
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
      setModalError(err instanceof Error ? err.message : "Unable to delete user");
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
      setModalError(err instanceof Error ? err.message : "Unable to allow remote linking");
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
      setError(err instanceof Error ? err.message : "Unable to cancel remote linking");
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
      setModalError(err instanceof Error ? err.message : "Unable to reset two-factor");
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
      setModalError(err instanceof Error ? err.message : "Unable to remove passkeys");
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
      setError(err instanceof Error ? err.message : "Unable to unlock account");
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
        description="Accounts, roles, and password resets."
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadUsers();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to refresh users");
                throw err;
              }
            }}
          />
          <Button variant="primary" onClick={openCreate} title="New user">
            <Plus size={18} />
            <span>New user</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title="User management error">{error}</MessageBox>}

      <div className="user-controls-bar">
        <label className="search-field user-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search users</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search users..."
          />
        </label>
      </div>

      {visibleUsers.length === 0 ? (
        <p className="management-empty">
          {users.length === 0 ? "No users configured." : "No users match this search."}
        </p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid user-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th className="col-num">Sessions</th>
                <th>Created</th>
                {/* The word is wider than the column now that the column holds one
                    ⋮ button, and in a fixed-layout table a heading that doesn't fit
                    puts the whole grid into a horizontal scroll. Kept for screen
                    readers, which is the only audience it was serving anyway. */}
                <th className="col-actions"><span className="sr-only">Actions</span></th>
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
                            {isCurrent && <span className="status-badge current">Current</span>}
                            {account.protectedFromDelete && <span className="status-badge protected">Protected</span>}
                            {account.locked && <span className="status-badge locked">Locked</span>}
                            {/* Only ever visible for the hour it is open, which is
                                the whole design: there is no lasting state here to
                                forget about. */}
                            {account.deviceLinkWindowExpiresAt && (
                              <span className="status-badge device-window">
                                Remote linking · {minutesLeft(account.deviceLinkWindowExpiresAt)} min left
                              </span>
                            )}
                          </span>
                          <small>{account.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${account.role}`}>{ROLE_LABEL[account.role]}</span>
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
                          label={`Manage ${account.displayName}`}
                          items={[
                            {
                              key: "edit",
                              label: "Edit user",
                              icon: <Pencil size={15} />,
                              onSelect: () => openEdit(account)
                            },
                            {
                              key: "password",
                              label: "Change password",
                              icon: <KeyRound size={15} />,
                              onSelect: () => openPassword(account)
                            },
                            {
                              key: "mfa",
                              label: account.mfaEnabled
                                ? `Reset two-factor (${account.mfaMethod === "email" ? "codes by email" : "authenticator app"})`
                                : "Reset two-factor",
                              icon: <ShieldOff size={15} />,
                              disabledReason: account.mfaEnabled ? undefined : "This user doesn't have two-factor on",
                              onSelect: () => {
                                setModalError("");
                                setPendingMfaReset(account);
                              }
                            },
                            {
                              key: "passkeys",
                              label: account.passkeyCount > 0
                                ? `Remove ${account.passkeyCount} passkey${account.passkeyCount === 1 ? "" : "s"}`
                                : "Remove passkeys",
                              icon: <Fingerprint size={15} />,
                              disabledReason: account.passkeyCount > 0 ? undefined : "This user has no passkeys",
                              onSelect: () => {
                                setModalError("");
                                setPendingPasskeyReset(account);
                              }
                            },
                            account.deviceLinkWindowExpiresAt
                              ? {
                                  key: "device-window",
                                  label: "Cancel remote device linking",
                                  icon: <MonitorX size={15} />,
                                  danger: true,
                                  disabledReason: closingWindowId === account.id ? "Cancelling…" : undefined,
                                  onSelect: () => closeWindow(account)
                                }
                              : {
                                  key: "device-window",
                                  label: "Allow a device from outside",
                                  icon: <MonitorSmartphone size={15} />,
                                  disabledReason: account.isActive ? undefined : "This account is deactivated",
                                  onSelect: () => {
                                    setModalError("");
                                    setWindowMinutes(String(DEFAULT_WINDOW_MINUTES));
                                    setPendingWindow(account);
                                  }
                                },
                            {
                              key: "unlock",
                              label: "Clear sign-in lockout",
                              icon: <LockOpen size={15} />,
                              disabledReason: !account.locked
                                ? "This account isn't locked"
                                : unlockingId === account.id
                                  ? "Clearing…"
                                  : undefined,
                              onSelect: () => unlockUser(account)
                            },
                            {
                              key: "delete",
                              label: "Delete user",
                              icon: <Trash2 size={15} />,
                              danger: true,
                              disabledReason: deleteDisabled ? "This user cannot be deleted here" : undefined,
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
          title="New user"
          className="user-form-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={createUser}
        >
          <Field label="Display name" value={newDisplayName} onChange={setNewDisplayName} autoComplete="name" />
          <Field label="Email" type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
          <Field
            label="Password"
            type="password"
            minLength={8}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <label className="field">
            <span>Role</span>
            <select value={newRole} onChange={(event) => setNewRole(event.target.value as UserRole)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {modalError && <MessageBox tone="error" title="Unable to create user">{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating || !newDisplayName.trim() || !newEmail.trim() || newPassword.length < 8}
            >
              {creating ? "Creating..." : "Create user"}
            </Button>
          </div>
        </Modal>
      )}

      {editingUser && (
        <Modal
          title={`Edit ${editingUser.displayName}`}
          className="user-form-modal"
          busy={saving}
          onClose={() => setEditingUser(null)}
          onSubmit={saveUser}
        >
          <Field label="Display name" value={editDisplayName} onChange={setEditDisplayName} autoComplete="name" />
          <Field label="Email" type="email" value={editEmail} onChange={setEditEmail} autoComplete="email" />
          <label className="field">
            <span>Role</span>
            <select
              value={editRole}
              disabled={roleLocked}
              onChange={(event) => setEditRole(event.target.value as UserRole)}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {roleLocked && (
            <MessageBox tone="info" title="Role locked">
              This administrator role is protected from changes here.
            </MessageBox>
          )}
          {modalError && <MessageBox tone="error" title="Unable to save user">{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setEditingUser(null)} disabled={saving} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !editDisplayName.trim() || !editEmail.trim()}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </Modal>
      )}

      {passwordUser && (
        <Modal
          title={`Change password for ${passwordUser.displayName}`}
          className="user-form-modal"
          busy={changingPassword}
          onClose={() => setPasswordUser(null)}
          onSubmit={changePassword}
        >
          <Field
            label="New password"
            type="password"
            minLength={8}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          {modalError && <MessageBox tone="error" title="Unable to change password">{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPasswordUser(null)} disabled={changingPassword} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={changingPassword || password.length < 8}>
              <ShieldCheck size={15} />
              {changingPassword ? "Changing..." : "Change password"}
            </Button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.displayName}"?`}
          confirmLabel="Delete user"
          busyLabel="Deleting..."
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteUser}
          onCancel={() => setPendingDelete(null)}
        >
          <p>This will deactivate the account and sign the user out on all devices.</p>
          <p><strong>Libraries, groups, activity history, and files are not deleted.</strong></p>
        </ConfirmDialog>
      )}

      {/* A Modal rather than a ConfirmDialog now that it collects something: the
          confirmation primitive answers yes/no, and this asks "how long". */}
      {pendingWindow && (
        <Modal
          variant="card"
          title={`Allow "${pendingWindow.displayName}" to link a device from outside?`}
          busy={openingWindow}
          onClose={() => setPendingWindow(null)}
          onSubmit={openWindow}
        >
          <p className="section-description">
            They can sign a TV, display or kiosk in from anywhere, instead of only from your home network. It ends
            as soon as one device is linked, or when the time below runs out — whichever comes first.
          </p>
          <Field
            label="Minutes"
            type="number"
            value={windowMinutes}
            onChange={setWindowMinutes}
            min={MIN_WINDOW_MINUTES}
            max={MAX_WINDOW_MINUTES}
          />
          <p className="section-description">
            Between {MIN_WINDOW_MINUTES} and {MAX_WINDOW_MINUTES} minutes. Long enough to walk someone through it;
            short enough that forgetting costs nothing.
          </p>
          <p className="section-description">
            <strong>They will still need their own password to authorize it</strong>, and the linked device still
            can't reach the control panel or authorize others. You'll be emailed if one is linked.
          </p>
          {modalError && <MessageBox tone="error" title="Unable to allow remote linking">{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPendingWindow(null)} disabled={openingWindow}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={openingWindow}>
              <MonitorSmartphone size={15} />
              {openingWindow ? "Allowing…" : `Allow for ${windowMinutes} min`}
            </Button>
          </div>
        </Modal>
      )}

      {pendingMfaReset && (
        <ConfirmDialog
          title={`Reset two-factor for "${pendingMfaReset.displayName}"?`}
          confirmLabel="Reset two-factor"
          busyLabel="Resetting…"
          confirmIcon={<ShieldOff size={15} />}
          danger
          rich
          busy={resettingMfa}
          error={modalError}
          onConfirm={resetMfa}
          onCancel={() => setPendingMfaReset(null)}
        >
          <p>
            This turns off two-factor and clears their backup codes along with
            {pendingMfaReset.mfaMethod === "email" ? " the emailed-code setting" : " their authenticator"}.
          </p>
          <p><strong>They'll sign in with just their password until they set it up again.</strong></p>
        </ConfirmDialog>
      )}

      {pendingPasskeyReset && (
        <ConfirmDialog
          title={`Remove passkeys for "${pendingPasskeyReset.displayName}"?`}
          confirmLabel="Remove passkeys"
          busyLabel="Removing…"
          confirmIcon={<Fingerprint size={15} />}
          danger
          rich
          busy={resettingPasskeys}
          error={modalError}
          onConfirm={resetPasskeys}
          onCancel={() => setPendingPasskeyReset(null)}
        >
          <p>
            This removes all {pendingPasskeyReset.passkeyCount} of their passkeys — for when they've lost every device
            that held one.
          </p>
          <p><strong>Their password and two-factor sign-in still work, and they can add a new passkey afterwards.</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
