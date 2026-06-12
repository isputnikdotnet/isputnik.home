import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Plus, Search, Trash2, UserMinus, Users } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import type { ManagedGroup, GroupMember, ManagedUser } from "../types";

export function GroupsSection() {
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [managingGroup, setManagingGroup] = useState<ManagedGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [addUserId, setAddUserId] = useState("");
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

  const visibleGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => [
      group.name,
      `${group.memberCount} members`,
      `${group.libraryCount} libraries`
    ].some((value) => value.toLowerCase().includes(query)));
  }, [groups, searchQuery]);

  const nonMembers = useMemo(
    () => users.filter((user) => !members.some((member) => member.userId === user.id)),
    [members, users]
  );

  const openCreate = () => {
    setError("");
    setModalError("");
    setNewGroupName("");
    setCreateOpen(true);
  };

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
    setModalError("");
    try {
      await api("/api/groups", { method: "POST", body: JSON.stringify({ name: newGroupName }) });
      setCreateOpen(false);
      setNewGroupName("");
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to create group");
    } finally {
      setCreating(false);
    }
  };

  const deleteGroup = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setModalError("");
    try {
      await api(`/api/groups/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to delete group");
    } finally {
      setDeleting(false);
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
        body: JSON.stringify({ userId: addUserId })
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

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon groups" aria-hidden="true">
            <Users size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">User administration</p>
            <h1>Groups</h1>
            <p className="section-description">Manage shared access groups and library membership.</p>
          </div>
        </div>
        <div className="row-actions">
          <Button variant="primary" onClick={openCreate} title="New group">
            <Plus size={18} />
            <span>New group</span>
          </Button>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Groups error">{error}</MessageBox>}

      <div className="admin-controls-bar">
        <label className="search-field admin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search groups</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search groups..."
          />
        </label>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="management-empty">
          {groups.length === 0 ? "No groups configured." : "No groups match this search."}
        </p>
      ) : (
        <div className="datagrid-wrap admin-table-wrap">
          <table className="datagrid admin-table group-table">
            <thead>
              <tr>
                <th>Group</th>
                <th className="col-num">Members</th>
                <th className="col-num">Libraries</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <div className="datagrid-primary">
                      <strong>{group.name}</strong>
                      <small>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</small>
                    </div>
                  </td>
                  <td className="col-num datagrid-muted">{group.memberCount.toLocaleString()}</td>
                  <td className="col-num datagrid-muted">{group.libraryCount.toLocaleString()}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        compact
                        onClick={() => loadMembers(group).catch((err) => setError(err instanceof Error ? err.message : "Unable to load members"))}
                      >
                        Manage
                      </Button>
                      <Button
                        variant="icon"
                        danger
                        title="Delete group"
                        aria-label={`Delete ${group.name}`}
                        onClick={() => {
                          setModalError("");
                          setPendingDelete(group);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
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
          {modalError && <MessageBox tone="error" title="Unable to create group">{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={creating || !newGroupName.trim()}>
              {creating ? "Creating..." : "Create group"}
            </Button>
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
          {memberError && <MessageBox tone="error" title="Group members error">{memberError}</MessageBox>}

          {members.length === 0 ? (
            <p className="management-empty">No members yet.</p>
          ) : (
            <div className="datagrid-wrap">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="col-actions">Actions</th>
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
                      <td className="col-actions">
                        <div className="row-actions">
                          <Button
                            variant="icon"
                            danger
                            title="Remove from group"
                            aria-label={`Remove ${member.displayName} from group`}
                            disabled={memberWorking}
                            onClick={() => removeMember(member)}
                          >
                            <UserMinus size={15} />
                          </Button>
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
                <select value={addUserId} onChange={(event) => setAddUserId(event.target.value)} required>
                  <option value="">Select user...</option>
                  {nonMembers.map((user) => (
                    <option value={user.id} key={user.id}>{user.displayName} ({user.email})</option>
                  ))}
                </select>
              </label>
              <Button variant="primary" type="submit" disabled={memberWorking || !addUserId}>
                Add member
              </Button>
            </form>
          )}

          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setManagingGroup(null)} autoFocus>Close</Button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.name}"?`}
          confirmLabel="Delete group"
          busyLabel="Deleting..."
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteGroup}
          onCancel={() => setPendingDelete(null)}
        >
          <p>This will remove the group and its membership records.</p>
          <p><strong>User accounts, libraries, and files are not deleted.</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
