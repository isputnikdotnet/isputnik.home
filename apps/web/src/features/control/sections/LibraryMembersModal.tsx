import { useState, useEffect, useCallback } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { LIBRARY_ROLE_OPTIONS, type LibraryMember, type LibraryRole } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";

const ROLE_LABEL: Record<LibraryRole, string> = Object.fromEntries(
  LIBRARY_ROLE_OPTIONS.map((option) => [option.value, option.label])
) as Record<LibraryRole, string>;

export function LibraryMembersModal({
  library,
  users,
  groups,
  onClose
}: {
  library: { id: string; name: string };
  users: ManagedUser[];
  groups: ManagedGroup[];
  onClose: () => void;
}) {
  const [members, setMembers] = useState<LibraryMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<LibraryRole>("member");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ members: LibraryMember[] }>(`/api/library/libraries/${library.id}/members`);
      setMembers(payload.members);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load members");
    } finally {
      setLoading(false);
    }
  }, [library.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, saving]);

  const addGrant = async () => {
    if (!subject) {
      setError("Choose a user or group to grant a role.");
      return;
    }
    const [subjectType, subjectId] = subject.split(":");
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members`, {
        method: "POST",
        body: JSON.stringify({ subjectType, subjectId, role })
      });
      setSubject("");
      setRole("member");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to grant role");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (member: LibraryMember) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members/${member.subjectType}/${member.subjectId}`, {
        method: "DELETE"
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke role");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !saving && onClose()}>
      <div
        className="confirm-modal library-members-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-members-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="library-members-title">Members — {library.name}</h2>
        <p className="muted" style={{ fontSize: "0.82rem", lineHeight: 1.4 }}>
          Grant additional users or groups a role on this library — or <strong>Deny</strong> to block
          one. The owner and app admins always have full access and aren't listed here. Public access
          (the Everyone baseline) is set on the library itself, not here.
        </p>

        <div className="member-grant-row">
          <select value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="User or group">
            <option value="">Select a user or group…</option>
            {users.length > 0 && (
              <optgroup label="Users">
                {users.map((user) => (
                  <option value={`user:${user.id}`} key={`u-${user.id}`}>{user.displayName} ({user.email})</option>
                ))}
              </optgroup>
            )}
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((group) => (
                  <option value={`group:${group.id}`} key={`g-${group.id}`}>{group.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <select value={role} onChange={(event) => setRole(event.target.value as LibraryRole)} aria-label="Role">
            {LIBRARY_ROLE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label} — {option.summary}</option>
            ))}
          </select>
          <button className="primary-button compact-button" onClick={addGrant} disabled={saving || !subject}>
            <UserPlus size={15} /> Grant
          </button>
        </div>

        {error && <MessageBox tone="error" title="Members error">{error}</MessageBox>}

        {loading ? (
          <p className="management-empty">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="management-empty">No additional members. Only the owner and admins have access.</p>
        ) : (
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Type</th>
                  <th>Role</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={`${member.subjectType}:${member.subjectId}`}>
                    <td>
                      <div className="datagrid-primary">
                        <strong>{member.name}{member.missing ? " (deleted)" : ""}</strong>
                        {member.email && <small>{member.email}</small>}
                      </div>
                    </td>
                    <td className="datagrid-muted">{member.subjectType === "group" ? "Group" : "User"}</td>
                    <td><span className="status-badge">{ROLE_LABEL[member.role] ?? member.role}</span></td>
                    <td className="col-actions">
                      <button
                        className="icon-button danger"
                        title="Revoke role"
                        onClick={() => revoke(member)}
                        disabled={saving}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </div>
  );
}
