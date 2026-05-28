import { useState, useEffect } from "react";
import { Copy, UserPlus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedInvite } from "../types";

export function InvitesSection() {
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedInvite | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadInvites = async () => {
    const payload = await api<{ invites: ManagedInvite[] }>("/api/invites");
    setInvites(payload.invites);
  };

  useEffect(() => {
    loadInvites().catch((err) => setError(err instanceof Error ? err.message : "Unable to load invite links"));
  }, []);

  useEffect(() => {
    if (!pendingDelete && !createOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting && !creating) {
        setPendingDelete(null);
        setCreateOpen(false);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [pendingDelete, createOpen, deleting, creating]);

  const createInvite = async () => {
    setCreating(true);
    setError("");
    try {
      const payload = await api<{ invite: { url: string } }>("/api/invites", {
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7 })
      });
      setInviteUrl(payload.invite.url);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create invite link");
    } finally {
      setCreating(false);
    }
  };

  const deleteInvite = async () => {
    if (!pendingDelete) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      await api(`/api/invites/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete invite link");
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
          <h1>Invite links</h1>
        </div>
        <button
          className="icon-button with-label"
          onClick={() => {
            setInviteUrl("");
            setError("");
            setCreateOpen(true);
          }}
          title="New invite"
        >
          <UserPlus size={18} />
          <span>New invite</span>
        </button>
      </div>

      {error && <MessageBox tone="error" title="Invite links error">{error}</MessageBox>}

      <div className="invite-list">
        {invites.map((invite) => (
          <article className="invite-row" key={invite.id}>
            <div className="invite-summary">
              <strong>{invite.role === "admin" ? "Admin" : "Member"} invite</strong>
              <span>Created by {invite.createdByName} on {formatManagedDate(invite.createdAt)}</span>
            </div>
            <span className={`invite-status ${invite.status}`}>{invite.status}</span>
            <div className="invite-dates">
              <span>Expires {formatManagedDate(invite.expiresAt)}</span>
              {invite.usedAt && <span>Used {formatManagedDate(invite.usedAt)}{invite.usedByName ? ` by ${invite.usedByName}` : ""}</span>}
            </div>
            <button className="text-button" onClick={() => setPendingDelete(invite)}>
              Delete
            </button>
            {invite.url ? (
              <div className="invite-link">
                <input value={invite.url} readOnly aria-label="Invite link" />
                <button className="icon-button" onClick={() => navigator.clipboard.writeText(invite.url!)} title="Copy invite">
                  <Copy size={18} />
                </button>
              </div>
            ) : (
              <span className="invite-link-unavailable">Link unavailable for invitations created before link storage was enabled.</span>
            )}
          </article>
        ))}
        {invites.length === 0 && <p className="management-empty">No invite links found.</p>}
      </div>

      {createOpen && (
        <div className="modal-backdrop" onMouseDown={() => !creating && setCreateOpen(false)}>
          <section
            className="confirm-modal create-invite-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-invite-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="create-invite-title">Create invite link</h2>
            {!inviteUrl ? (
              <p>A member invite link will be created and will expire in 7 days.</p>
            ) : (
              <section className="created-invite" aria-label="New invite link">
                <strong>New invite link</strong>
                <div className="invite-box">
                  <input value={inviteUrl} readOnly />
                  <button className="icon-button" onClick={() => navigator.clipboard.writeText(inviteUrl)} title="Copy invite">
                    <Copy size={18} />
                  </button>
                </div>
              </section>
            )}
            {error && !inviteUrl && <MessageBox tone="error" title="Unable to create invite">{error}</MessageBox>}
            <div className="modal-actions">
              {!inviteUrl && (
                <button className="secondary-button" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
                  Cancel
                </button>
              )}
              {inviteUrl ? (
                <button className="primary-button" onClick={() => setCreateOpen(false)} autoFocus>
                  Done
                </button>
              ) : (
                <button className="primary-button" onClick={createInvite} disabled={creating}>
                  {creating ? "Creating..." : "Create link"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingDelete(null)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-invite-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-invite-title">Delete invite link?</h2>
            <p>This invite link will no longer be usable.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingDelete(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteInvite} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete link"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
