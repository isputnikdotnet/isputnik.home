import { useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Share a multi-photo selection (gallery "share these") two ways:
// - Guest link: an anonymous, no-account snapshot of the selection.
// - People: grant registered users access in their own account (they see the
//   photos under "Shared with me") — useful for members who can't otherwise see
//   the library. Mirrors ShareModal's two-tab layout.

type Tab = "link" | "people";

interface SetLinkShare {
  id: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface DirectoryUser {
  id: string;
  displayName: string;
}

interface SetRecipient {
  userId: string;
  displayName: string;
  email: string;
  itemCount: number;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 }
];

// User-share expiry runs longer than a guest link's — and can be permanent, since
// the access is gated to the recipient's account rather than a public URL.
const USER_EXPIRY_OPTIONS = [
  { label: "No expiry", days: 0 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "1 year", days: 365 }
];

export function ShareSetModal({ itemIds, onClose }: { itemIds: string[]; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");
  const itemNoun = itemIds.length === 1 ? "item" : "items";

  // Link tab
  const [links, setLinks] = useState<SetLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [skippedNote, setSkippedNote] = useState("");
  const [copied, setCopied] = useState(false);

  // People tab
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [recipients, setRecipients] = useState<SetRecipient[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [userExpiryDays, setUserExpiryDays] = useState(0);
  const [granting, setGranting] = useState(false);
  const [peopleNote, setPeopleNote] = useState("");

  const loadLinks = () =>
    api<{ shares: SetLinkShare[] }>("/api/shares/sets").then((r) => setLinks(r.shares)).catch(() => {});
  const loadRecipients = () =>
    api<{ recipients: SetRecipient[] }>("/api/shares/set/recipients", {
      method: "POST",
      body: JSON.stringify({ itemIds })
    }).then((r) => setRecipients(r.recipients)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    api<{ users: DirectoryUser[] }>("/api/shares/directory").then((r) => setDirectory(r.users)).catch(() => {});
    void loadRecipients();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    setSkippedNote("");
    try {
      const { share } = await api<{ share: { url: string; itemCount: number; skipped: number } }>("/api/shares/set", {
        method: "POST",
        body: JSON.stringify({ itemIds, expiresInDays, label: label.trim() || undefined })
      });
      setNewUrl(share.url);
      if (share.skipped > 0) {
        setSkippedNote(`${share.skipped} item${share.skipped === 1 ? " was" : "s were"} left out (no permission to share them). The link shows ${share.itemCount}.`);
      }
      setLabel("");
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create link");
    } finally {
      setCreating(false);
    }
  };

  const copyUrl = async () => {
    if (!newUrl) return;
    try {
      await navigator.clipboard.writeText(newUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed — select and copy the link manually.");
    }
  };

  const revokeLink = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      setLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke link");
    }
  };

  const grantUser = async () => {
    if (!selectedUser) return;
    setGranting(true);
    setError("");
    setPeopleNote("");
    try {
      const result = await api<{ granted: number; skipped: number }>("/api/shares/set/user", {
        method: "POST",
        body: JSON.stringify({ itemIds, userId: selectedUser, expiresInDays: userExpiryDays || undefined })
      });
      const parts = [`Shared ${result.granted} ${result.granted === 1 ? "item" : "items"}`];
      if (result.skipped > 0) parts.push(`${result.skipped} skipped (no permission)`);
      setPeopleNote(`${parts.join(" · ")}.`);
      setSelectedUser("");
      await loadRecipients();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share with user");
    } finally {
      setGranting(false);
    }
  };

  const revokeUser = async (userId: string) => {
    setError("");
    try {
      await api("/api/shares/set/user/revoke", {
        method: "POST",
        body: JSON.stringify({ itemIds, userId })
      });
      setRecipients((prev) => prev.filter((r) => r.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
    }
  };

  const availableUsers = directory.filter((u) => !recipients.some((r) => r.userId === u.id));

  return (
    <Modal
      variant="panel"
      title={`Share ${itemIds.length} ${itemNoun}`}
      icon={<Link2 size={20} />}
      onClose={onClose}
    >
      <div className="modal-tabs">
        <button className={`modal-tab${tab === "link" ? " active" : ""}`} onClick={() => setTab("link")}>
          Guest link
        </button>
        <button className={`modal-tab${tab === "people" ? " active" : ""}`} onClick={() => setTab("people")}>
          People
        </button>
      </div>

      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title="Unable to share">{error}</MessageBox>}

        {tab === "link" && (
          <div className="share-link-tab">
            <p className="muted">
              Anyone with the link can view and download these photos — no account needed.
              The link is a snapshot of this selection; it expires and can be revoked.
            </p>

            <div className="share-create-row">
              <label className="field">
                <span>Expires in</span>
                <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                  {EXPIRY_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Label (optional)</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Saturday hike" maxLength={100} />
              </label>
              <button className="primary-button" onClick={createLink} disabled={creating}>
                <Link2 size={16} /><span>{creating ? "Creating…" : "Create link"}</span>
              </button>
            </div>

            {newUrl && (
              <div className="share-new-url">
                <p className="muted">Copy this link now — it won’t be shown again.</p>
                <div className="share-url-row">
                  <input readOnly value={newUrl} onFocus={(e) => e.target.select()} />
                  <button className="secondary-button" onClick={copyUrl}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                {skippedNote && <p className="muted">{skippedNote}</p>}
              </div>
            )}

            <div className="share-list">
              {links.length === 0 ? (
                <p className="muted">No active quick links.</p>
              ) : (
                links.map((link) => (
                  <div className="share-list-row" key={link.id}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {link.label || "Quick link"} · {link.itemCount} {link.itemCount === 1 ? "item" : "items"}
                      </span>
                      <span className="muted">
                        {link.status === "expired" ? "Expired" : `Expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => revokeLink(link.id)} aria-label="Revoke link">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === "people" && (
          <div className="share-people-tab">
            <p className="muted">
              Share with a registered user. They get access in their own account under “Shared with me” —
              even for photos in a library they can’t otherwise see.
            </p>

            <div className="share-create-row">
              <label className="field">
                <span>User</span>
                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                  <option value="">Choose a person…</option>
                  {availableUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Access for</span>
                <select value={userExpiryDays} onChange={(e) => setUserExpiryDays(Number(e.target.value))}>
                  {USER_EXPIRY_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
                </select>
              </label>
              <button className="primary-button" onClick={grantUser} disabled={granting || !selectedUser}>
                <UserPlus size={16} /><span>{granting ? "Sharing…" : "Share"}</span>
              </button>
            </div>

            {peopleNote && <MessageBox tone="success" title="Shared">{peopleNote}</MessageBox>}

            <div className="share-list">
              {recipients.length === 0 ? (
                <p className="muted">Not shared with anyone yet.</p>
              ) : (
                recipients.map((r) => (
                  <div className="share-list-row" key={r.userId}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {r.displayName} · {r.itemCount} of {itemIds.length} {itemIds.length === 1 ? "item" : "items"}
                      </span>
                      <span className="muted">
                        {r.expiresAt ? `Until ${new Date(r.expiresAt).toLocaleDateString()}` : "No expiry"}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => revokeUser(r.userId)} aria-label="Revoke share">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
