import { useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2, UserPlus, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";

type Tab = "link" | "people";

interface LinkShare {
  id: string;
  bookTitle: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface UserShare {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  expiresAt: string | null;
  createdAt: string;
}

interface DirectoryUser {
  id: string;
  displayName: string;
}

const EXPIRY_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 }
];

export function ShareModal({
  bookId,
  bookTitle,
  onClose
}: {
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");

  // Link tab
  const [links, setLinks] = useState<LinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // People tab
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [userShares, setUserShares] = useState<UserShare[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [granting, setGranting] = useState(false);

  const loadLinks = () =>
    api<{ shares: LinkShare[] }>("/api/shares").then((r) => setLinks(r.shares)).catch(() => {});
  const loadUserShares = () =>
    api<{ shares: UserShare[] }>(`/api/shares/user?bookId=${encodeURIComponent(bookId)}`)
      .then((r) => setUserShares(r.shares)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    api<{ users: DirectoryUser[] }>("/api/shares/directory").then((r) => setDirectory(r.users)).catch(() => {});
    void loadUserShares();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const myLinks = links.filter((l) => l.bookTitle === bookTitle);

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    try {
      const { share } = await api<{ share: { url: string } }>("/api/shares", {
        method: "POST",
        body: JSON.stringify({ bookId, expiresInDays, label: label.trim() || undefined })
      });
      setNewUrl(share.url);
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
    try {
      await api("/api/shares/user", {
        method: "POST",
        body: JSON.stringify({ bookId, userId: selectedUser })
      });
      setSelectedUser("");
      await loadUserShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share with user");
    } finally {
      setGranting(false);
    }
  };

  const revokeUser = async (id: string) => {
    try {
      await api(`/api/shares/user/${id}`, { method: "DELETE" });
      setUserShares((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
    }
  };

  const availableUsers = directory.filter((u) => !userShares.some((s) => s.userId === u.id));

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="metadata-modal" role="dialog" aria-modal="true" aria-label={`Share ${bookTitle}`}>
        <div className="modal-header">
          <h2>Share “{bookTitle}”</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="modal-tabs">
          <button className={`modal-tab${tab === "link" ? " active" : ""}`} onClick={() => setTab("link")}>
            Guest link
          </button>
          <button className={`modal-tab${tab === "people" ? " active" : ""}`} onClick={() => setTab("people")}>
            People
          </button>
        </div>

        <div className="modal-tab-content">
          {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

          {tab === "link" && (
            <div className="share-link-tab">
              <p className="muted">Anyone with the link can listen and download — no account needed. Links expire and can be revoked.</p>

              <div className="share-create-row">
                <label className="field">
                  <span>Expires in</span>
                  <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                    {EXPIRY_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Label (optional)</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. For Dad" maxLength={100} />
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
                </div>
              )}

              <div className="share-list">
                {myLinks.length === 0 ? (
                  <p className="muted">No active links for this book.</p>
                ) : (
                  myLinks.map((link) => (
                    <div className="share-list-row" key={link.id}>
                      <div className="share-list-main">
                        <span className="share-list-label">{link.label || "Guest link"}</span>
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
              <p className="muted">Share with a registered user. They get full access in their own account — playback, downloads, and their own progress.</p>

              <div className="share-create-row">
                <label className="field">
                  <span>User</span>
                  <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                    <option value="">Choose a person…</option>
                    {availableUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select>
                </label>
                <button className="primary-button" onClick={grantUser} disabled={granting || !selectedUser}>
                  <UserPlus size={16} /><span>{granting ? "Sharing…" : "Share"}</span>
                </button>
              </div>

              <div className="share-list">
                {userShares.length === 0 ? (
                  <p className="muted">Not shared with anyone yet.</p>
                ) : (
                  userShares.map((s) => (
                    <div className="share-list-row" key={s.id}>
                      <div className="share-list-main">
                        <span className="share-list-label">{s.displayName}</span>
                        <span className="muted">
                          {s.expiresAt ? `Until ${new Date(s.expiresAt).toLocaleDateString()}` : "No expiry"}
                        </span>
                      </div>
                      <button className="icon-button" onClick={() => revokeUser(s.id)} aria-label="Revoke share">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
