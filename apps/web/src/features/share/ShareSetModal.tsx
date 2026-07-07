import { useEffect, useState } from "react";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Guest quick link over a multi-photo selection (gallery "share these"). Guest
// links only — no People tab: other members already see the photos through
// their own library access. Mirrors ShareModal's link tab, including the
// show-the-URL-exactly-once contract.

interface SetLinkShare {
  id: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

const EXPIRY_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 }
];

export function ShareSetModal({ itemIds, onClose }: { itemIds: string[]; onClose: () => void }) {
  const [error, setError] = useState("");
  const [links, setLinks] = useState<SetLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [skippedNote, setSkippedNote] = useState("");
  const [copied, setCopied] = useState(false);

  const loadLinks = () =>
    api<{ shares: SetLinkShare[] }>("/api/shares/sets").then((r) => setLinks(r.shares)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []);

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

  return (
    <Modal
      variant="panel"
      title={`Share ${itemIds.length} ${itemIds.length === 1 ? "item" : "items"}`}
      icon={<Link2 size={20} />}
      onClose={onClose}
    >
      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title="Unable to share">{error}</MessageBox>}

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
      </div>
    </Modal>
  );
}
