import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users, UsersRound } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { AddRow, GroupedList, GroupedSearch, NavRow } from "../../../shared/GroupedList";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { ManagedGroup } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { groupHref, navigate } from "../../../router";
import { groupAccessHref, initialParam } from "../links";

// Members › Groups as rows (control panel v2): a search field over the groups,
// each row opening the group's page — members, access, and Delete live there.
export function GroupsSection() {
  const { t } = useTranslation(["common", "control"]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

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
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("control:groups.errorTitle")}>{error}</MessageBox>}

      <div className="grouped-page">
        <GroupedSearch value={searchQuery} onChange={setSearchQuery} label={t("control:groups.searchAria")} placeholder={t("control:groups.searchPlaceholder")} />
        <GroupedList note={visibleGroups.length === 0 ? (groups.length === 0 ? t("control:groups.emptyNone") : t("control:groups.emptyFiltered")) : undefined}>
          {visibleGroups.map((group) => (
            <NavRow
              key={group.id}
              icon={<UsersRound size={17} />}
              iconShape="round"
              label={group.name}
              sub={t("control:groups.memberCount", { count: group.memberCount })}
              value={t("control:groups.libraryCount", { count: group.libraryCount })}
              href={groupHref(group.id)}
            />
          ))}
          {!searchQuery.trim() && (
            <AddRow icon={<Plus size={17} />} label={t("control:groups.newGroup")} onClick={openCreate} />
          )}
        </GroupedList>
      </div>

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

    </>
  );
}
