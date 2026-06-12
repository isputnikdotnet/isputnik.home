import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, User, Users } from "lucide-react";
import { api, type PublicUser } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedUser } from "../types";

type UserRole = "admin" | "member";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin",
  member: "Member"
};

function formatSessionCount(value: number) {
  return `${value.toLocaleString()} ${value === 1 ? "session" : "sessions"}`;
}

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

  const roleLocked = editingUser ? editingUser.protectedFromDelete || editingUser.id === currentUser.id : false;

  return (
    <>
      <div className="section-head user-section-head">
        <div className="user-title-wrap">
          <span className="user-page-icon" aria-hidden="true">
            <Users size={30} />
          </span>
          <div className="user-heading-copy">
            <p className="eyebrow">User administration</p>
            <h1>User management</h1>
            <p className="section-description">Manage accounts, roles, sessions, and passwords.</p>
          </div>
        </div>
        <div className="row-actions">
          <Button variant="primary" onClick={openCreate} title="New user">
            <Plus size={18} />
            <span>New user</span>
          </Button>
        </div>
      </div>

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
        <div className="datagrid-wrap user-table-wrap">
          <table className="datagrid user-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th className="col-num">Sessions</th>
                <th>Created</th>
                <th className="col-actions">Actions</th>
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
                      <div className="row-actions">
                        <Button
                          variant="icon"
                          title="Edit user"
                          aria-label={`Edit ${account.displayName}`}
                          onClick={() => openEdit(account)}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="icon"
                          title="Change password"
                          aria-label={`Change password for ${account.displayName}`}
                          onClick={() => openPassword(account)}
                        >
                          <KeyRound size={15} />
                        </Button>
                        <Button
                          variant="icon"
                          danger
                          title={deleteDisabled ? "This user cannot be deleted here" : "Delete user"}
                          aria-label={`Delete ${account.displayName}`}
                          disabled={deleteDisabled}
                          onClick={() => {
                            setModalError("");
                            setPendingDelete(account);
                          }}
                        >
                          <Trash2 size={15} />
                        </Button>
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
    </>
  );
}
