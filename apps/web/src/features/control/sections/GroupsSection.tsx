import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Trash2, Users, UsersRound } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { ManagedGroup } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { groupHref, navigate } from "../../../router";
import { groupAccessHref, initialParam } from "../links";
import { formatNumber } from "../../../shared/dates";

export function GroupsSection() {
  const { t } = useTranslation(["common", "control"]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The Access dialog used to open over this list from ?group=&tab=; those links
  // land on the group's page instead (members/GroupPage).
  useEffect(() => {
    const id = initialParam("group");
    if (id) navigate(groupAccessHref(id, initialParam("tab") || undefined));
  }, []);

  const load = useCallback(async () => {
    const groupsPayload = await api<{ groups: ManagedGroup[] }>("/api/groups");
    setGroups(groupsPayload.groups);
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

  const openCreate = () => {
    setError("");
    setModalError("");
    setNewGroupName("");
    setCreateOpen(true);
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
                    <div className="user-account-cell">
                      <span className="user-avatar-icon" aria-hidden="true">
                        <UsersRound size={20} />
                      </span>
                      <div className="datagrid-primary">
                        <Button variant="text" className="user-name-link" onClick={() => navigate(groupHref(group.id))}>
                          <strong>{group.name}</strong>
                        </Button>
                        <small>{t("control:groups.memberCount", { count: group.memberCount })}</small>
                      </div>
                    </div>
                  </td>
                  <td className="col-num datagrid-muted">{formatNumber(group.memberCount)}</td>
                  <td className="col-num datagrid-muted">{formatNumber(group.libraryCount)}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        compact
                        onClick={() => navigate(groupHref(group.id))}
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
