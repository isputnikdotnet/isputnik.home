import { useState, useEffect, useCallback, useMemo } from "react";
import { Copy, Search, Trash2, UserPlus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedInvite } from "../types";

const INVITE_ROLE_LABEL: Record<ManagedInvite["role"], string> = {
  admin: "Admin",
  member: "Member"
};

const INVITE_STATUS_LABEL: Record<ManagedInvite["status"], string> = {
  active: "Active",
  expired: "Expired",
  used: "Used"
};

export function InvitesSection() {
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedInvite | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadInvites = useCallback(async () => {
    const payload = await api<{ invites: ManagedInvite[] }>("/api/invites");
    setInvites(payload.invites);
  }, []);

  useEffect(() => {
    loadInvites().catch((err) => setError(err instanceof Error ? err.message : "Unable to load invite links"));
  }, [loadInvites]);

  const visibleInvites = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return invites;
    return invites.filter((invite) => [
      INVITE_ROLE_LABEL[invite.role],
      INVITE_STATUS_LABEL[invite.status],
      invite.createdByName,
      invite.usedByName ?? ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [invites, searchQuery]);

  const openCreate = () => {
    setInviteUrl("");
    setError("");
    setModalError("");
    setCreateOpen(true);
  };

  const createInvite = async () => {
    setCreating(true);
    setModalError("");
    try {
      const payload = await api<{ invite: { url: string } }>("/api/invites", {
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7 })
      });
      setInviteUrl(payload.invite.url);
      await loadInvites();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to create invite link");
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
      setModalError(err instanceof Error ? err.message : "Unable to delete invite link");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon invites" aria-hidden="true">
            <UserPlus size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">User administration</p>
            <h1>Invite links</h1>
            <p className="section-description">Create and retire sign-up links for new accounts.</p>
          </div>
        </div>
        <div className="row-actions">
          <Button variant="primary" onClick={openCreate} title="New invite">
            <UserPlus size={18} />
            <span>New invite</span>
          </Button>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Invite links error">{error}</MessageBox>}

      <div className="admin-controls-bar">
        <label className="search-field admin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search invite links</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search invite links..."
          />
        </label>
      </div>

      {visibleInvites.length === 0 ? (
        <p className="management-empty">
          {invites.length === 0 ? "No invite links found." : "No invite links match this search."}
        </p>
      ) : (
        <div className="datagrid-wrap admin-table-wrap">
          <table className="datagrid admin-table invite-table">
            <thead>
              <tr>
                <th>Invite</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Used</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvites.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    <div className="datagrid-primary">
                      <strong>{INVITE_ROLE_LABEL[invite.role]} invite</strong>
                      <small>Created by {invite.createdByName} on {formatManagedDate(invite.createdAt)}</small>
                    </div>
                  </td>
                  <td>
                    <span className={`status-badge ${invite.status}`}>{INVITE_STATUS_LABEL[invite.status]}</span>
                  </td>
                  <td className="datagrid-muted">{formatManagedDate(invite.expiresAt)}</td>
                  <td className="datagrid-muted">
                    {invite.usedAt
                      ? `${formatManagedDate(invite.usedAt)}${invite.usedByName ? ` by ${invite.usedByName}` : ""}`
                      : "Not used"}
                  </td>
                  <td className="col-actions">
                    <Button
                      variant="icon"
                      danger
                      title="Delete invite link"
                      aria-label={`Delete ${INVITE_ROLE_LABEL[invite.role].toLowerCase()} invite link`}
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
          title="Create invite link"
          className="create-invite-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
        >
          {!inviteUrl ? (
            <p>A member invite link will be created and will expire in 7 days.</p>
          ) : (
            <section className="created-invite" aria-label="New invite link">
              <strong>New invite link</strong>
              <div className="invite-box">
                <input value={inviteUrl} readOnly />
                <Button variant="icon" onClick={() => navigator.clipboard.writeText(inviteUrl)} title="Copy invite" aria-label="Copy invite link">
                  <Copy size={18} />
                </Button>
              </div>
            </section>
          )}
          {modalError && !inviteUrl && <MessageBox tone="error" title="Unable to create invite">{modalError}</MessageBox>}
          <div className="modal-actions">
            {!inviteUrl && (
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
                Cancel
              </Button>
            )}
            {inviteUrl ? (
              <Button variant="primary" onClick={() => setCreateOpen(false)} autoFocus>
                Done
              </Button>
            ) : (
              <Button variant="primary" onClick={createInvite} disabled={creating}>
                {creating ? "Creating..." : "Create link"}
              </Button>
            )}
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${INVITE_ROLE_LABEL[pendingDelete.role].toLowerCase()} invite link?`}
          confirmLabel="Delete link"
          busyLabel="Deleting..."
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={modalError}
          onConfirm={deleteInvite}
          onCancel={() => setPendingDelete(null)}
        >
          <p>This invite link will no longer be usable.</p>
          <p><strong>Existing user accounts and accepted invites are not changed.</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
