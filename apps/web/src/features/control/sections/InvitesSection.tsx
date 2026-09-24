import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Search, Trash2, UserPlus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedInvite } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import i18n from "../../../i18n";

// Plain lookup functions rather than module-level consts, so a language switch
// is picked up (see docs/i18n-plan.md's namespace-key typing pitfall about
// module-level lookups needing to be functions, not frozen consts).
function inviteRoleLabel(role: ManagedInvite["role"]): string {
  return role === "admin" ? i18n.t("control:invites.roleAdmin") : i18n.t("control:invites.roleMember");
}

function inviteStatusLabel(status: ManagedInvite["status"]): string {
  switch (status) {
    case "active": return i18n.t("control:invites.statusActive");
    case "expired": return i18n.t("control:invites.statusExpired");
    case "used": return i18n.t("control:invites.statusUsed");
  }
}

export function InvitesSection() {
  const { t } = useTranslation(["common", "control"]);
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedInvite | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Groups the invite's person joins on sign-up, so they arrive with access (D19).
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [joinGroups, setJoinGroups] = useState<Set<string>>(new Set());

  const loadInvites = useCallback(async () => {
    const payload = await api<{ invites: ManagedInvite[] }>("/api/invites");
    setInvites(payload.invites);
  }, []);

  useEffect(() => {
    loadInvites().catch((err) => setError(err instanceof Error ? err.message : t("control:invites.unableToLoad")));
  }, [loadInvites, t]);

  const visibleInvites = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return invites;
    return invites.filter((invite) => [
      inviteRoleLabel(invite.role),
      inviteStatusLabel(invite.status),
      invite.createdByName,
      invite.usedByName ?? ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [invites, searchQuery]);

  const openCreate = () => {
    setInviteUrl("");
    setError("");
    setModalError("");
    setJoinGroups(new Set());
    setCreateOpen(true);
    api<{ groups: { id: string; name: string }[] }>("/api/groups")
      .then((payload) => setGroups(payload.groups.filter((group) => group.id !== "grp-everyone" && group.id !== "grp-system-admins")))
      .catch(() => setGroups([]));
  };

  const createInvite = async () => {
    setCreating(true);
    setModalError("");
    try {
      const payload = await api<{ invite: { url: string } }>("/api/invites", {
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7, groupIds: [...joinGroups] })
      });
      setInviteUrl(payload.invite.url);
      await loadInvites();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("control:invites.unableToCreate"));
    } finally {
      setCreating(false);
    }
  };

  const deleteInvite = async () => {
    if (!pendingDelete) return;

    setDeleting(true);
    setModalError("");
    try {
      await api(`/api/invites/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await loadInvites();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("control:invites.unableToDelete"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="invites"
        icon={<UserPlus size={30} />}
        iconClassName="invites"
        description={t("control:invites.description")}
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadInvites();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("control:invites.unableToRefresh"));
                throw err;
              }
            }}
          />
          <Button variant="primary" onClick={openCreate} title={t("control:invites.newInvite")}>
            <UserPlus size={18} />
            <span>{t("control:invites.newInvite")}</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("control:invites.errorTitle")}>{error}</MessageBox>}

      <div className="admin-controls-bar">
        <label className="search-field admin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">{t("control:invites.searchAria")}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("control:invites.searchPlaceholder")}
          />
        </label>
      </div>

      {visibleInvites.length === 0 ? (
        <p className="management-empty">
          {invites.length === 0 ? t("control:invites.emptyNone") : t("control:invites.emptyFiltered")}
        </p>
      ) : (
        <div className="datagrid-wrap admin-table-wrap">
          <table className="datagrid admin-table invite-table">
            <thead>
              <tr>
                <th>{t("control:invites.thInvite")}</th>
                <th>{t("control:invites.thStatus")}</th>
                <th>{t("control:invites.thExpires")}</th>
                <th>{t("control:invites.thUsed")}</th>
                <th className="col-actions">{t("control:invites.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvites.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    <div className="datagrid-primary">
                      <strong>{t("control:invites.inviteRow", { role: inviteRoleLabel(invite.role) })}</strong>
                      <small>{t("control:invites.createdBy", { name: invite.createdByName, date: formatManagedDate(invite.createdAt) })}</small>
                      {invite.groups.length > 0 && <small>{t("control:invites.joinsRow", { names: invite.groups.map((group) => group.name).join(", ") })}</small>}
                    </div>
                  </td>
                  <td>
                    <span className={`status-badge ${invite.status}`}>{inviteStatusLabel(invite.status)}</span>
                  </td>
                  <td className="datagrid-muted">{formatManagedDate(invite.expiresAt)}</td>
                  <td className="datagrid-muted">
                    {invite.usedAt
                      ? (invite.usedByName
                        ? t("control:invites.usedOnByName", { date: formatManagedDate(invite.usedAt), name: invite.usedByName })
                        : formatManagedDate(invite.usedAt))
                      : t("control:invites.notUsed")}
                  </td>
                  <td className="col-actions">
                    <Button
                      variant="icon"
                      danger
                      title={t("control:invites.deleteTitle")}
                      aria-label={t("control:invites.deleteAria", { role: inviteRoleLabel(invite.role) })}
                      onClick={() => {
                        setModalError("");
                        setPendingDelete(invite);
                      }}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <Modal
          title={t("control:invites.createTitle")}
          className="create-invite-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
        >
          {!inviteUrl ? (
            <>
              <p>{t("control:invites.createIntro")}</p>
              <fieldset className="invite-groups">
                <legend>{t("control:invites.joinsGroups")}</legend>
                <small>{groups.length > 0 ? t("control:invites.joinsHint") : t("control:invites.noGroups")}</small>
                {groups.map((group) => (
                  <label key={group.id} className="invite-group-option">
                    <input
                      type="checkbox"
                      checked={joinGroups.has(group.id)}
                      onChange={(event) => setJoinGroups((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(group.id); else next.delete(group.id);
                        return next;
                      })}
                    />
                    <span>{group.name}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <section className="created-invite" aria-label={t("control:invites.newInviteLinkAria")}>
              <strong>{t("control:invites.newInviteLinkLabel")}</strong>
              <div className="invite-box">
                <input value={inviteUrl} readOnly />
                <Button variant="icon" onClick={() => navigator.clipboard.writeText(inviteUrl)} title={t("control:invites.copyTitle")} aria-label={t("control:invites.copyAria")}>
                  <Copy size={18} />
                </Button>
              </div>
            </section>
          )}
          {modalError && !inviteUrl && <MessageBox tone="error" title={t("control:invites.unableToCreateTitle")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            {!inviteUrl && (
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
                {t("control:ui.cancel")}
              </Button>
            )}
            {inviteUrl ? (
              <Button variant="primary" onClick={() => setCreateOpen(false)} autoFocus>
                {t("control:ui.done")}
              </Button>
            ) : (
              <Button variant="primary" onClick={createInvite} disabled={creating}>
                {creating ? t("control:invites.creating") : t("control:invites.createLink")}
              </Button>
            )}
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:invites.deleteConfirmTitle", { role: inviteRoleLabel(pendingDelete.role) })}
          confirmLabel={t("control:invites.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteInvite}
          onCancel={() => setPendingDelete(null)}
        >
          <p>{t("control:invites.deleteBody1")}</p>
          <p><strong>{t("control:invites.deleteBody2")}</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
