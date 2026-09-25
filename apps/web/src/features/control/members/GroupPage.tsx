import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, Trash2, UsersRound } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, navigate } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { SelectField } from "../../../shared/SelectField";
import { useAccessSubject } from "../access/AccessTabs";

// One group, one page: Members › Groups › <name>. Who is in it, and Delete in
// a danger zone — nothing else. What a group is GIVEN is set where each thing
// lives (a library's Members, a person's sharing, a collection's Access) and
// read on each member's page under "Where their access comes from".

const SYSTEM_GROUP_IDS = new Set(["grp-everyone", "grp-system-admins"]);

export function GroupPage({ groupId }: { groupId: string }) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const subject = useMemo(() => ({ subjectType: "group" as const, subjectId: groupId }), [groupId]);
  const { overview, error, busy, write } = useAccessSubject(subject);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const group = overview?.subject.subjectType === "group" ? overview.subject : null;
  const name = group?.name ?? "";
  const system = group ? group.system || SYSTEM_GROUP_IDS.has(group.subjectId) : false;
  const del = { method: "DELETE" };

  const deleteGroup = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/groups/${encodeURIComponent(groupId)}`, del);
      navigate(controlHref("groups"));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("control:groups.unableToDelete"));
      setDeleting(false);
    }
  };

  const groupsHref = controlHref("groups");

  return (
    <div className="member-page">
      <div className="member-page-head">
        <a className="text-button member-page-back" href={groupsHref} onClick={(event) => followRoute(event, groupsHref)}>
          <ArrowLeft size={15} aria-hidden="true" />
          {t("controlAdmin:group.backToGroups")}
        </a>
        <div className="member-page-title-row">
          <div className="member-page-identity">
            <span className="member-page-avatar member-page-avatar-group" aria-hidden="true">
              <UsersRound size={30} />
            </span>
            <div className="member-page-copy">
              <h1>{name || t("controlAdmin:access.loading")}</h1>
              {group && (
                <p className="member-page-subtitle">
                  <span className={`status-badge ${system ? "protected" : "member"}`}>
                    {system ? t("controlAdmin:group.badgeSystem") : t("controlAdmin:group.badgeGroup")}
                  </span>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:access.errors.title")}>{error}</MessageBox>}
      {!overview && !error && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}

      {group && (
        <div className="member-page-grid">
          <div className="member-page-column">
            <MembersCard
              members={group.members}
              busy={busy}
              onAdd={(userId) => void write(() => api(`/api/groups/${encodeURIComponent(groupId)}/members`, { method: "POST", body: JSON.stringify({ userId }) }))}
              onRemove={(userId) => void write(() => api(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, del))}
            />

            <section className="member-card member-card-danger" aria-labelledby="group-danger-title">
              <h2 id="group-danger-title">
                <AlertTriangle size={17} aria-hidden="true" />
                {t("controlAdmin:member.dangerTitle")}
              </h2>
              <p className="access-muted">{t("controlAdmin:group.dangerBody")}</p>
              <div className="member-danger-actions">
                <Button
                  variant="danger"
                  disabled={busy || system}
                  title={system ? t("controlAdmin:group.systemCannotDelete") : undefined}
                  onClick={() => { setDeleteError(""); setPendingDelete(true); }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {t("control:groups.deleteConfirmLabel")}
                </Button>
                {system && <small className="access-muted">{t("controlAdmin:group.systemCannotDelete")}</small>}
              </div>
            </section>
          </div>
        </div>
      )}

      {pendingDelete && group && (
        <ConfirmDialog
          title={t("control:groups.deleteConfirmTitle", { name })}
          confirmLabel={t("control:groups.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={deleteError}
          onConfirm={deleteGroup}
          onCancel={() => setPendingDelete(false)}
        >
          <p>{t("control:groups.deleteBody1")}</p>
          <p><strong>{t("control:groups.deleteBody2")}</strong></p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// Who is in the group, and the picker to add someone.
function MembersCard({ members, busy, onAdd, onRemove }: {
  members: { id: string; name: string; email: string }[];
  busy: boolean;
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [all, setAll] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    api<{ users: { id: string; displayName: string }[] }>("/api/users").then((payload) => setAll(payload.users)).catch(() => setAll([]));
  }, []);
  const inGroup = new Set(members.map((member) => member.id));
  const addable = all.filter((user) => !inGroup.has(user.id));
  return (
    <section className="member-card" aria-labelledby="group-members-title">
      <h2 id="group-members-title">
        <UsersRound size={17} aria-hidden="true" />
        {t("controlAdmin:group.tabMembers")}
      </h2>
      <p className="access-muted">{t("controlAdmin:access.members.hint")}</p>
      {members.length === 0
        ? <p className="access-muted">{t("controlAdmin:access.members.none")}</p>
        : (
          <table className="member-table member-people">
            <thead>
              <tr>
                <th>{t("controlAdmin:member.photos.colPerson")}</th>
                <th><span className="sr-only">{t("controlAdmin:member.photos.colActions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <span className="member-table-primary">
                      <strong>{member.name}</strong>
                      <small>{member.email}</small>
                    </span>
                  </td>
                  <td className="member-table-actions">
                    <Button variant="secondary" compact disabled={busy} onClick={() => onRemove(member.id)}>{t("controlAdmin:access.remove")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {addable.length > 0 && (
        <div className="member-add-row">
          <SelectField
            label={t("controlAdmin:access.members.add")}
            value=""
            disabled={busy}
            onChange={(userId) => { if (userId) onAdd(userId); }}
            options={[{ value: "", label: t("controlAdmin:access.members.choose") }, ...addable.map((user) => ({ value: user.id, label: user.displayName }))]}
          />
        </div>
      )}
    </section>
  );
}
