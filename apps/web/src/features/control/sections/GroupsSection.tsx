import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, Trash2, UserMinus, ShieldCheck, User } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import type { ManagedGroup, GroupMember, ManagedUser } from "../types";

export function GroupsSection() {
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const [managingGroup, setManagingGroup] = useState<ManagedGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"member" | "manager">("member");
  const [memberError, setMemberError] = useState("");
  const [memberWorking, setMemberWorking] = useState(false);

  const load = useCallback(async () => {
    const [groupsPayload, usersPayload] = await Promise.all([
      api<{ groups: ManagedGroup[] }>("/api/groups"),
      api<{ users: ManagedUser[] }>("/api/users")
    ]);
    setGroups(groupsPayload.groups);
    setUsers(usersPayload.users);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load groups"));
  }, [load]);

  const loadMembers = async (group: ManagedGroup) => {
    const payload = await api<{ members: GroupMember[] }>(`/api/groups/${group.id}/members`);
    setMembers(payload.members);
    setManagingGroup(group);
    setAddUserId("");
    setMemberError("");
  };

  const createGroup = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      await api("/api/groups", { method: "POST", body: JSON.stringify({ name: newGroupName }) });
      setCreateOpen(false);
      setNewGroupName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create group");
    } finally {
      setCreating(false);
    }
  };

  const deleteGroup = async (group: ManagedGroup) => {
    setError("");
    try {
      await api(`/api/groups/${group.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete group");
    }
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!managingGroup || !addUserId) return;
    setMemberWorking(true);
    setMemberError("");
    try {
      await api(`/api/groups/${managingGroup.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: addUserId, role: addRole })
      });
      const payload = await api<{ members: GroupMember[] }>(`/api/groups/${managingGroup.id}/members`);
      setMembers(payload.members);
      setAddUserId("");
      await load();
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : "Unable to add member");
    } finally {
      setMemberWorking(false);
    }
  };

  const changeRole = async (member: GroupMember, role: "member" | "manager") => {
    if (!managingGroup) return;
    setMemberWorking(true);
    setMemberError("");
    try {
      await api(`/api/groups/${managingGroup.id}/members/${member.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      const payload = await api<{ members: GroupMember[] }>(`/api/groups/${managingGroup.id}/members`);
      setMembers(payload.members);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : "Unable to update role");
    } finally {
      setMemberWorking(false);
    }
  };

  const removeMember = async (member: GroupMember) => {
    if (!managingGroup) return;
    setMemberWorking(true);
    setMemberError("");
    try {
      await api(`/api/groups/${managingGroup.id}/members/${member.userId}`, { method: "DELETE" });
      const payload = await api<{ members: GroupMember[] }>(`/api/groups/${managingGroup.id}/members`);
      setMembers(payload.members);
      await load();
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : "Unable to remove member");
    } finally {
      setMemberWorking(false);
    }
  };

  const nonMembers = users.filter((u) => !members.some((m) => m.userId === u.id));

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">User administration</p>
          <h1>Groups</h1>
        </div>
        <button className="primary-button" onClick={() => { setError(""); setCreateOpen(true); }}>
          <Plus size={18} />
          <span>New group</span>
        </button>
      </div>

      {error && <MessageBox tone="error" title="Groups error">{error}</MessageBox>}

      {groups.length === 0 ? (
        <p className="management-empty">No groups configured.</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Name</th>
                <th className="col-num">Members</th>
                <th className="col-num">Libraries</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td><strong>{group.name}</strong></td>
                  <td className="col-num datagrid-muted">{group.memberCount}</td>
                  <td className="col-num datagrid-muted">{group.libraryCount}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <button
                        className="secondary-button compact-button"
                        onClick={() => loadMembers(group).catch((err) => setError(err instanceof Error ? err.message : "Unable to load members"))}
                      >
                        Manage
                      </button>
                      <button
                        className="icon-button danger"
                        title="Delete group"
                        onClick={() => deleteGroup(group)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <Modal
          title="New group"
          className="create-group-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={createGroup}
        >
            <Field label="Group name" value={newGroupName} onChange={setNewGroupName} />
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>Cancel</Button>
              <Button variant="primary" type="submit" disabled={creating || !newGroupName.trim()}>{creating ? "Creating..." : "Create group"}</Button>
            </div>
        </Modal>
      )}

      {managingGroup && (
        <Modal
          title={managingGroup.name}
          className="manage-group-modal"
          busy={memberWorking}
          onClose={() => setManagingGroup(null)}
        >
            {memberError && <MessageBox tone="error" title="Error">{memberError}</MessageBox>}

            {members.length === 0 ? (
              <p className="management-empty">No members yet.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Role</th>
                      <th className="col-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.userId}>
                        <td>
                          <div className="datagrid-primary">
                            <strong>{member.displayName}</strong>
                            <small>{member.email}</small>
                          </div>
                        </td>
                        <td>
                          <span className={`status-badge ${member.role}`}>{member.role}</span>
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            {member.role === "member" ? (
                              <button className="icon-button" title="Promote to manager" disabled={memberWorking} onClick={() => changeRole(member, "manager")}>
                                <ShieldCheck size={15} />
                              </button>
                            ) : (
                              <button className="icon-button" title="Demote to member" disabled={memberWorking} onClick={() => changeRole(member, "member")}>
                                <User size={15} />
                              </button>
                            )}
                            <button className="icon-button danger" title="Remove from group" disabled={memberWorking} onClick={() => removeMember(member)}>
                              <UserMinus size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {nonMembers.length > 0 && (
              <form className="add-member-form" onSubmit={addMember}>
                <label className="field">
                  <span>Add member</span>
                  <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} required>
                    <option value="">Select user…</option>
                    {nonMembers.map((u) => (
                      <option value={u.id} key={u.id}>{u.displayName} ({u.email})</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Role</span>
                  <select value={addRole} onChange={(e) => setAddRole(e.target.value as "member" | "manager")}>
                    <option value="member">Member</option>
                    <option value="manager">Manager</option>
                  </select>
                </label>
                <button className="primary-button" disabled={memberWorking || !addUserId}>Add</button>
              </form>
            )}

            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setManagingGroup(null)} autoFocus>Close</Button>
            </div>
        </Modal>
      )}
    </>
  );
}
