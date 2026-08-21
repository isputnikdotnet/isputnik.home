import { useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Share a whole ALBUM two ways — both LIVE, so they always reflect the album's
// current photos (nothing is snapshotted, no item cap):
// - Guest link: an anonymous, no-account URL.
// - People: grant registered users the album under "Shared with me".
// Mirrors ShareSetModal, but keyed on the album instead of a fixed selection.

type Tab = "link" | "people";

interface AlbumLinkShare {
  id: string;
  albumId: string;
  albumName: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface AlbumRecipient {
  userId: string;
  displayName: string;
  email: string;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 }
];

export function ShareAlbumModal({ albumId, albumName, onClose }: { albumId: string; albumName: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");

  // Link tab
  const [links, setLinks] = useState<AlbumLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // People tab
  const [recipients, setRecipients] = useState<AlbumRecipient[]>([]);

  const loadLinks = () =>
    api<{ shares: AlbumLinkShare[] }>("/api/shares/albums")
      .then((r) => setLinks(r.shares.filter((s) => s.albumId === albumId)))
      .catch(() => {});
  const loadRecipients = () =>
    api<{ recipients: AlbumRecipient[] }>("/api/shares/album/recipients", {
      method: "POST",
      body: JSON.stringify({ albumId })
    }).then((r) => setRecipients(r.recipients)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    void loadRecipients();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    try {
      const { share } = await api<{ share: { url: string } }>("/api/shares/album", {
        method: "POST",
        body: JSON.stringify({ albumId, expiresInDays, label: label.trim() || undefined })
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

  const revokeUser = async (userId: string) => {
    setError("");
    try {
      await api("/api/shares/album/user/revoke", {
        method: "POST",
        body: JSON.stringify({ albumId, userId })
      });
      setRecipients((prev) => prev.filter((r) => r.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
    }
  };

  return (
    <Modal
      variant="panel"
      title={`Share “${albumName}”`}
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
              Anyone with the link can view and download this album’s photos — no account needed.
              The link stays in step with the album: photos you add or remove appear and disappear automatically.
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
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={albumName} maxLength={100} />
              </label>
              <button className="primary-button" onClick={() => void createLink()} disabled={creating}>
                <Link2 size={16} /><span>{creating ? "Creating…" : "Create link"}</span>
              </button>
            </div>

            {newUrl && (
              <div className="share-new-url">
                <p className="muted">Copy this link now — it won’t be shown again.</p>
                <div className="share-url-row">
                  <input readOnly value={newUrl} onFocus={(e) => e.target.select()} />
                  <button className="secondary-button" onClick={() => void copyUrl()}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>
            )}

            <div className="share-list">
              {links.length === 0 ? (
                <p className="muted">No active links for this album.</p>
              ) : (
                links.map((link) => (
                  <div className="share-list-row" key={link.id}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {link.label || "Album link"} · {link.itemCount} {link.itemCount === 1 ? "photo" : "photos"}
                      </span>
                      <span className="muted">
                        {link.status === "expired" ? "Expired" : `Expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => void revokeLink(link.id)} aria-label="Revoke link">
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
              Who has their own live copy under “Shared with me” — always the album’s current photos,
              even ones in a library they can’t otherwise browse. To give somebody access, use{" "}
              <strong>Send to</strong>: pick them and it grants access as it tells them.
            </p>

            <div className="share-list">
              {recipients.length === 0 ? (
                <p className="muted">Nobody has been given access to this album yet.</p>
              ) : (
                recipients.map((r) => (
                  <div className="share-list-row" key={r.userId}>
                    <div className="share-list-main">
                      <span className="share-list-label">{r.displayName}</span>
                      <span className="muted">
                        {r.expiresAt ? `Until ${new Date(r.expiresAt).toLocaleDateString()}` : "No expiry"}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => void revokeUser(r.userId)} aria-label={`Remove ${r.displayName}`}>
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
