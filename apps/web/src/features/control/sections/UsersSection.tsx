import { useState, useEffect } from "react";
import { api, type PublicUser } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import type { ManagedUser } from "../types";

export function UsersSection({ currentUser }: { currentUser: PublicUser }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savingRoleId, setSavingRoleId] = useState("");

  const loadUsers = async () => {
    const payload = await api<{ users: ManagedUser[] }>("/api/users");
    setUsers(payload.users);
  };

  useEffect(() => {
    loadUsers().catch((err) => setError(err instanceof Error ? err.message : "Unable to load users"));
  }, []);

  useEffect(() => {
    if (!pendingDelete) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        setPendingDelete(null);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [pendingDelete, deleting]);

  const changeRole = async (account: ManagedUser, role: "admin" | "member") => {
    setSavingRoleId(account.id);
    setError("");
    try {
      await api(`/api/users/${account.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change account role");
    } finally {
      setSavingRoleId("");
    }
  };

  const deleteUser = async () => {
    if (!pendingDelete) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      await api(`/api/users/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete user");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Management</p>
          <h1>User management</h1>
        </div>
      </div>

      {error && <MessageBox tone="error" title="User management error">{error}</MessageBox>}

      <div className="user-list">
        {users.map((account) => (
          <article className="user-row" key={account.id}>
            <div>
              <strong>{account.displayName}</strong>
              <span>{account.email}</span>
              <span>{account.activeSessions} active {account.activeSessions === 1 ? "session" : "sessions"}</span>
            </div>
            <div className="user-controls">
              <label>
                <span className="sr-only">Role for {account.displayName}</span>
                <select
                  className="role-select"
                  value={account.role}
                  disabled={account.protectedFromDelete || account.id === currentUser.id || savingRoleId === account.id}
                  onChange={(event) => changeRole(account, event.target.value as "admin" | "member")}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              {account.protectedFromDelete && <span className="protected-badge">Protected</span>}
            </div>
            <button
              className="text-button"
              disabled={account.protectedFromDelete || account.id === currentUser.id}
              onClick={() => setPendingDelete(account)}
            >
              Delete
            </button>
          </article>
        ))}
      </div>

      {pendingDelete && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingDelete(null)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-user-title">Delete {pendingDelete.displayName}?</h2>
            <p>This account will be deactivated and signed out on all devices.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingDelete(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteUser} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete user"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
