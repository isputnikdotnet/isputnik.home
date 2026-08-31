import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Trash2, UserMinus, Users } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { ManagedGroup, GroupMember, ManagedUser } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";

export function GroupsSection() {
  const { t } = useTranslation(["common", "control"]);
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
    load().catch((err) => setError(err instanceof Error ? err.message : t("control:groups.unableToLoad")));
  }, [load, t]);

  const visibleGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => [
      group.name,
      t("control:groups.memberCount", { count: group.memberCount }),
      String(group.libraryCount)
    ].some((value) => value.toLowerCase().includes(query)));
  }, [groups, searchQuery, t]);

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
      setModalError(err instanceof Error ? err.message : t("control:groups.unableToCreate"));
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
      setModalError(err instanceof Error ? err.message : t("control:groups.unableToDelete"));
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
      setMemberError(err instanceof Error ? err.message : t("control:groups.unableToAddMember"));
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
      setMemberError(err instanceof Error ? err.message : t("control:groups.unableToRemoveMember"));
    } finally {
      setMemberWorking(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="groups"
        icon={<Users size={30} />}
        iconClassName="groups"
        description={t("control:groups.description")}
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("control:groups.unableToRefresh"));
                throw err;
              }
            }}
          />
          <Button variant="primary" onClick={openCreate} title={t("control:groups.newGroup")}>
            <Plus size={18} />
            <span>{t("control:groups.newGroup")}</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("control:groups.errorTitle")}>{error}</MessageBox>}

      <div className="admin-controls-bar">
        <label className="search-field admin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">{t("control:groups.searchAria")}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("control:groups.searchPlaceholder")}
          />
        </label>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="management-empty">
          {groups.length === 0 ? t("control:groups.emptyNone") : t("control:groups.emptyFiltered")}
        </p>
      ) : (
        <div className="datagrid-wrap admin-table-wrap">
          <table className="datagrid admin-table group-table">
            <thead>
              <tr>
                <th>{t("control:groups.thGroup")}</th>
                <th className="col-num">{t("control:groups.thMembers")}</th>
                <th className="col-num">{t("control:groups.thLibraries")}</th>
                <th className="col-actions">{t("control:groups.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <div className="datagrid-primary">
                      <strong>{group.name}</strong>
                      <small>{t("control:groups.memberCount", { count: group.memberCount })}</small>
                    </div>
                  </td>
                  <td className="col-num datagrid-muted">{group.memberCount.toLocaleString()}</td>
                  <td className="col-num datagrid-muted">{group.libraryCount.toLocaleString()}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        compact
                        onClick={() => loadMembers(group).catch((err) => setError(err instanceof Error ? err.message : t("control:groups.unableToLoadMembers")))}
                      >
                        {t("control:groups.manage")}
                      </Button>
                      <Button
                        variant="icon"
                        danger
                        title={t("control:groups.deleteGroupAria", { name: group.name })}
                        aria-label={t("control:groups.deleteGroupAria", { name: group.name })}
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
          title={t("control:groups.newGroup")}
          className="create-group-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={createGroup}
        >
          <Field label={t("control:groups.groupName")} value={newGroupName} onChange={setNewGroupName} />
          {modalError && <MessageBox tone="error" title={t("control:groups.unableToCreate")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
              {t("control:ui.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={creating || !newGroupName.trim()}>
              {creating ? t("control:groups.creatingGroup") : t("control:groups.createGroup")}
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
          {memberError && <MessageBox tone="error" title={t("control:groups.membersErrorTitle")}>{memberError}</MessageBox>}

          {members.length === 0 ? (
            <p className="management-empty">{t("control:groups.noMembersYet")}</p>
          ) : (
            <div className="datagrid-wrap">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>{t("control:groups.thMember")}</th>
                    <th className="col-actions">{t("control:groups.thActions")}</th>
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
                            title={t("control:groups.removeFromGroupTitle")}
                            aria-label={t("control:groups.removeFromGroupAria", { name: member.displayName })}
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
                <span>{t("control:groups.addMember")}</span>
                <select value={addUserId} onChange={(event) => setAddUserId(event.target.value)} required>
                  <option value="">{t("control:groups.selectUser")}</option>
                  {nonMembers.map((user) => (
                    <option value={user.id} key={user.id}>{user.displayName} ({user.email})</option>
                  ))}
                </select>
              </label>
              <Button variant="primary" type="submit" disabled={memberWorking || !addUserId}>
                {t("control:groups.addMember")}
              </Button>
            </form>
          )}

          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setManagingGroup(null)} autoFocus>{t("control:ui.close")}</Button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:groups.deleteConfirmTitle", { name: pendingDelete.name })}
          confirmLabel={t("control:groups.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteGroup}
          onCancel={() => setPendingDelete(null)}
        >
          <p>{t("control:groups.deleteBody1")}</p>
          <p><strong>{t("control:groups.deleteBody2")}</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
